import { randomUUID } from "node:crypto";
import { runAgent, type AgentDeps } from "../agent/agent.js";
import { isExplicitHumanRequest } from "../agent/guardrails.js";
import { maybeSummarize } from "../agent/memory.js";
import type { Db } from "../db/client.js";
import { repo, type Conversation, type Customer, type MessageRow } from "../db/repo.js";
import { maskPhone, type Logger } from "../logger.js";
import { detectLanguage, toWhatsAppText, truncate } from "../util/text.js";
import { isPermanentSendError, type WhatsAppSender } from "../whatsapp/client.js";
import type { EchoMessage, InboundMessage, StatusUpdate } from "../whatsapp/webhook.js";
import { performHandoff } from "./handoff.js";

export interface ProcessorConfig {
  debounceMs: number;
  maxInboundChars: number;
  rateLimitPer10Min: number;
  humanModeTimeoutHours: number;
  maxAttempts: number;
  typingIndicator: boolean;
  logBodies: boolean;
  fastModel: string;
}

// The holder renews its lease every LEASE_RENEW_MS, so a long run never loses it; it only
// expires when the worker died (the sweeper then re-queues the messages).
const LEASE_SECONDS = 300;
const LEASE_RENEW_MS = 60_000;
const MAX_DEBOUNCE_MS = 8000;

/**
 * Message pipeline:
 *   webhook -> ingest() stores messages idempotently (unique wa_message_id) and
 *   returns 200 fast -> schedule() debounces per conversation (customers send
 *   bursts of short messages) -> processConversation() takes a DB lease so only
 *   one worker handles a conversation, batches all pending messages into one
 *   agent run, sends the reply, and loops while new messages keep arriving.
 * The sweeper re-schedules anything left behind (crash, restart, send failure).
 */
export class MessageProcessor {
  private timers = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();
  private inflight = new Set<Promise<void>>();
  /** Leases this process holds right now: conversation id -> lease owner. */
  private leases = new Map<string, string>();

  constructor(
    private readonly deps: AgentDeps & { whatsapp: WhatsAppSender },
    private readonly cfg: ProcessorConfig,
  ) {}

  private get db(): Db {
    return this.deps.db;
  }
  private get log(): Logger {
    return this.deps.log;
  }

  // --------------------------------------------------------------------- ingest

  /** Store inbound messages. Returns ids of conversations with new messages. Safe to call twice with the same payload. */
  async ingest(messages: InboundMessage[]): Promise<{ conversationIds: string[]; duplicates: number }> {
    const convIds = new Set<string>();
    let duplicates = 0;
    for (const m of messages) {
      const stored = await this.db.tx(async (tx) => {
        const customer = await repo.upsertCustomer(tx, m.from, m.profileName);
        const conv = await repo.getOrCreateOpenConversation(tx, customer.id);
        const body = m.text ? truncate(m.text, this.cfg.maxInboundChars) : null;
        const row = await repo.insertInboundMessage(tx, {
          conversationId: conv.id,
          customerId: customer.id,
          waMessageId: m.waMessageId,
          type: m.type,
          body,
          media: m.media,
          waTimestamp: m.timestamp,
        });
        if (row) await repo.touchConversation(tx, conv.id, "inbound");
        return row ? { conv, customer, row } : null;
      });
      if (!stored) {
        duplicates++;
        this.log.info({ event: "duplicate_webhook", waMessageId: m.waMessageId }, "duplicate message ignored");
        continue;
      }
      convIds.add(stored.conv.id);
      this.log.info(
        {
          event: "message_received",
          conversationId: stored.conv.id,
          customerId: stored.customer.id,
          from: maskPhone(m.from),
          type: m.type,
          ...(this.cfg.logBodies ? { body: stored.row.body } : { chars: stored.row.body?.length ?? 0 }),
        },
        "inbound message stored",
      );
      // Read receipt only: "typing…" is shown once the AI actually starts on the batch (handleBatch).
      if (m.type !== "reaction") {
        this.deps.whatsapp.markRead(m.waMessageId, false).catch((err) => this.log.debug({ err: String(err) }, "markRead failed"));
      }
    }
    return { conversationIds: [...convIds], duplicates };
  }

  async applyStatuses(statuses: StatusUpdate[]) {
    for (const s of statuses) {
      await repo.applyStatusUpdate(this.db, s.waMessageId, s.status, s.error);
      if (s.status === "failed") this.log.warn({ event: "delivery_failed", waMessageId: s.waMessageId, error: s.error }, "WhatsApp delivery failed");
    }
  }

  /**
   * Messages staff typed in the WhatsApp Business app (coexistence). Staff took
   * over: store them and switch the conversation to human mode.
   */
  async applyEchoes(echoes: EchoMessage[]) {
    for (const e of echoes) {
      await this.db.tx(async (tx) => {
        const customer = await repo.upsertCustomer(tx, e.to, null);
        const conv = await repo.getOrCreateOpenConversation(tx, customer.id);
        const row = await repo.insertOutboundMessage(tx, {
          conversationId: conv.id,
          customerId: customer.id,
          author: "human_agent",
          body: e.text ?? "(non-text message)",
          waMessageId: e.waMessageId,
          status: "sent",
        });
        if (!row) return; // our own AI message echoed back, or duplicate
        if (conv.mode !== "human") await repo.setMode(tx, conv.id, "human");
        else await repo.touchHumanActivity(tx, conv.id);
        await repo.touchConversation(tx, conv.id, "outbound");
      });
    }
  }

  // ------------------------------------------------------------------- schedule

  schedule(conversationId: string, delayMs = this.cfg.debounceMs) {
    const existing = this.timers.get(conversationId);
    const firstAt = existing?.firstAt ?? Date.now();
    if (existing) clearTimeout(existing.timer);
    // Debounce, but never hold a conversation longer than MAX_DEBOUNCE_MS.
    const wait = Math.max(0, Math.min(delayMs, firstAt + MAX_DEBOUNCE_MS - Date.now()));
    const timer = setTimeout(() => {
      this.timers.delete(conversationId);
      this.track(this.processConversation(conversationId));
    }, wait);
    this.timers.set(conversationId, { timer, firstAt });
  }

  private track(p: Promise<void>) {
    const wrapped = p.catch((err) => this.log.error({ err: String(err) }, "processConversation crashed")).finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
  }

  /** Wait for scheduled and running work (tests, graceful shutdown). */
  async drain(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while ((this.timers.size > 0 || this.inflight.size > 0) && Date.now() < deadline) {
      if (this.inflight.size) await Promise.race([...this.inflight, new Promise((r) => setTimeout(r, 50))]);
      else await new Promise((r) => setTimeout(r, 20));
    }
  }

  stopTimers() {
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
  }

  /**
   * Shutdown, after drain(): runs still in flight will not finish in this process. Re-queue their
   * messages and free their leases so the next instance answers them without waiting for expiry.
   */
  async releaseLeases() {
    for (const [conversationId, owner] of this.leases) {
      try {
        await repo.requeueProcessingInbound(this.db, conversationId);
        await repo.releaseConversation(this.db, conversationId, owner);
      } catch (err) {
        this.log.warn({ err: String(err), conversationId }, "could not release lease on shutdown");
      }
    }
    this.leases.clear();
  }

  // -------------------------------------------------------------------- process

  async processConversation(conversationId: string): Promise<void> {
    const owner = randomUUID();
    if (!(await repo.claimConversation(this.db, conversationId, owner, LEASE_SECONDS))) {
      this.log.debug({ conversationId }, "conversation busy; the lease holder will pick up new messages");
      return;
    }
    this.leases.set(conversationId, owner);
    const renew = setInterval(() => {
      repo
        .extendLease(this.db, conversationId, owner, LEASE_SECONDS)
        .then((held) => {
          if (!held) this.log.warn({ event: "lease_lost", conversationId }, "processing lease taken over by another worker");
        })
        .catch((err) => this.log.warn({ err: String(err), conversationId }, "lease renewal failed"));
    }, LEASE_RENEW_MS);
    let failed = false;
    try {
      for (let round = 0; round < 5; round++) {
        if (!(await repo.extendLease(this.db, conversationId, owner, LEASE_SECONDS))) break; // lost it: the new holder takes over
        const pending = await repo.claimPendingInbound(this.db, conversationId);
        if (pending.length === 0) break;
        try {
          await this.handleBatch(conversationId, pending);
        } catch (err) {
          failed = true;
          await this.batchFailed(conversationId, pending, err);
          break;
        }
      }
    } finally {
      clearInterval(renew);
      this.leases.delete(conversationId);
      await repo.releaseConversation(this.db, conversationId, owner);
    }
    // The sweeper retries a failed batch shortly; rescheduling now would spin on a persistent error.
    if (failed) return;
    // A message may have landed between our last check and releasing the lease.
    const { rows } = await this.db.query(
      `select 1 from messages where conversation_id = $1 and direction = 'inbound' and status = 'received' limit 1`,
      [conversationId],
    );
    if (rows.length) this.schedule(conversationId, 0);
  }

  private async handleBatch(conversationId: string, pending: MessageRow[]) {
    const ids = pending.map((p) => p.id);
    let conv = (await repo.getConversation(this.db, conversationId))!;
    const customer = (await repo.getCustomer(this.db, conv.customer_id))!;
    const settings = await this.deps.knowledge.settings();

    // Human mode: AI stays silent unless staff have been inactive long enough.
    if (conv.mode === "human") {
      const last = new Date(conv.human_last_activity_at ?? conv.human_since ?? 0).getTime();
      if (Date.now() - last < this.cfg.humanModeTimeoutHours * 3600_000) {
        await repo.setInboundStatus(this.db, ids, "skipped");
        this.log.info({ event: "skipped_human_mode", conversationId }, "conversation in human mode; AI not replying");
        return;
      }
      await repo.setMode(this.db, conversationId, "ai");
      await repo.resolveActiveHandoffs(this.db, conversationId, "system:timeout");
      conv = { ...conv, mode: "ai" };
      this.log.info({ event: "human_mode_expired", conversationId }, "human mode timed out; AI resumed");
    }
    if (conv.mode === "paused" || customer.is_blocked || !settings.botEnabled) {
      await repo.setInboundStatus(this.db, ids, "skipped");
      return;
    }

    const texts = pending.map((p) => p.body).filter((b): b is string => Boolean(b));
    const joined = texts.join("\n");
    const lang = detectLanguage(joined) ?? conv.language ?? customer.preferred_language ?? null;
    if (lang && lang !== conv.language) {
      await repo.setConversationLanguage(this.db, conversationId, lang);
      await repo.setCustomerLanguage(this.db, customer.id, lang);
    }

    // Rate limit (abuse / loops). Tell the customer once, then stay quiet.
    const recent = await repo.countInboundSince(this.db, customer.id, 10);
    if (recent > this.cfg.rateLimitPer10Min) {
      await repo.setInboundStatus(this.db, ids, "skipped", "rate_limited");
      const notified = conv.context.rate_limit_notified_at && Date.now() - new Date(conv.context.rate_limit_notified_at).getTime() < 3600_000;
      if (!notified) {
        await repo.updateConversationContext(this.db, conversationId, { ...conv.context, rate_limit_notified_at: new Date().toISOString() });
        await this.sendReply(conv, customer, settings.handoffExpectation[lang ?? "he"] ?? settings.handoffExpectation.he!, null, "system");
        await performHandoff(this.handoffDeps(), { ...this.handoffBase(conv, customer), reason: "other", summary: "Rate limit exceeded", createdBy: "system" });
      }
      this.log.warn({ event: "rate_limited", conversationId, recent }, "customer rate limited");
      return;
    }

    // Only non-text content (voice note, image without caption, sticker...): polite canned reply, no LLM cost.
    if (texts.length === 0) {
      const onlyReactions = pending.every((p) => p.type === "reaction");
      await repo.setInboundStatus(this.db, ids, onlyReactions ? "skipped" : "processed");
      if (!onlyReactions) {
        const reply = settings.unsupportedMediaReply[lang ?? "he"] ?? settings.unsupportedMediaReply.he ?? "🙏";
        await this.sendReply(conv, customer, reply, null, "system");
      }
      return;
    }

    // Fast path: explicit, short "I want a human" -> hand off without the LLM.
    if (texts.some(isExplicitHumanRequest)) {
      await performHandoff(this.handoffDeps(), {
        ...this.handoffBase(conv, customer),
        reason: "customer_request",
        summary: truncate(joined, 300),
        createdBy: "system",
      });
      await this.sendReply(conv, customer, settings.handoffExpectation[lang ?? "he"] ?? settings.handoffExpectation.he!, null, "system");
      await repo.setInboundStatus(this.db, ids, "processed");
      return;
    }

    // ------------------------------------------------------------------ AI run
    const lastText = pending.filter((p) => p.body && p.wa_message_id).at(-1);
    if (this.cfg.typingIndicator && lastText) {
      this.deps.whatsapp.markRead(lastText.wa_message_id!, true).catch((err) => this.log.debug({ err: String(err) }, "typing indicator failed"));
    }
    const started = Date.now();
    const runId = await repo.createRun(this.db, conversationId, this.deps.config.model);
    await repo.linkInboundToRun(this.db, ids, runId);
    const result = await runAgent(this.deps, { customer, conversation: conv, pending, replyLanguage: lang });
    const latencyMs = Date.now() - started;

    for (const tc of result.toolCalls) {
      await repo.insertToolCall(this.db, {
        runId,
        conversationId,
        tool: tc.name,
        input: tc.input,
        output: truncateJson(tc.output),
        success: tc.success,
        error: tc.error,
        latencyMs: tc.latencyMs,
      });
    }

    let reply = result.reply ? toWhatsAppText(result.reply) : null;
    let status: string = result.status;
    let handedOffHere = result.handedOff;
    if (!reply) {
      // Fail closed: never leave the customer hanging, never improvise.
      const fallback = settings.handoffExpectation[lang ?? "he"] ?? settings.handoffExpectation.he!;
      const alreadyHuman = result.handedOff;
      if (!alreadyHuman) {
        handedOffHere = true;
        await performHandoff(this.handoffDeps(), {
          ...this.handoffBase(conv, customer),
          reason: result.flags.includes("model_refusal") ? "sensitive" : "processing_error",
          summary: `AI could not answer (${result.error ?? "unknown"}). Last message: ${truncate(joined, 200)}`,
          createdBy: "system",
        });
      }
      reply = fallback;
      status = "failed";
    }

    await repo.finishRun(this.db, runId, {
      status,
      iterations: result.iterations,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      latencyMs,
      replyText: reply,
      flags: result.flags,
      error: result.error,
    });

    this.log.info(
      {
        event: "agent_run",
        conversationId,
        customerId: customer.id,
        runId,
        status,
        model: this.deps.config.model,
        iterations: result.iterations,
        tools: result.toolCalls.map((t) => `${t.name}:${t.success ? "ok" : "fail"}`),
        tokens: result.usage,
        latencyMs,
        flags: result.flags,
        error: result.error,
      },
      "agent run finished",
    );

    // Staff may have taken over (or paused the bot) while the model was working.
    const latest = handedOffHere ? null : await repo.getConversation(this.db, conversationId);
    if (latest && latest.mode !== "ai") {
      await repo.setInboundStatus(this.db, ids, "skipped", "staff_took_over");
      this.log.info({ event: "reply_suppressed", conversationId, runId, mode: latest.mode }, "staff took over during the AI run; reply not sent");
      return;
    }

    await this.sendReply(conv, customer, reply, runId, "ai");
    await repo.setInboundStatus(this.db, ids, "processed");

    // Background housekeeping (does not delay the customer).
    maybeSummarize(
      { db: this.db, llm: this.deps.llm, log: this.log, fastModel: this.cfg.fastModel, historyMessages: this.deps.config.historyMessages },
      (await repo.getConversation(this.db, conversationId))!,
    ).catch(() => {});
  }

  /**
   * handleBatch threw (DB error, bug...). Put the batch straight back in the queue for the sweeper
   * to retry, or give up once it has used its attempts (counted when claimed). Never throws.
   */
  private async batchFailed(conversationId: string, pending: MessageRow[], err: unknown) {
    const ids = pending.map((p) => p.id);
    const attempts = Math.max(...pending.map((p) => p.attempts));
    const error = String(err);
    const exhausted = attempts >= this.cfg.maxAttempts;
    this.log.error({ event: "batch_failed", conversationId, attempts, exhausted, err: error }, "processing a batch failed");
    try {
      if (!exhausted) {
        await repo.failUnfinishedRuns(this.db, ids, error);
        await repo.releaseFailedBatch(this.db, ids, "received", error);
      } else if (await repo.releaseFailedBatch(this.db, ids, "failed", "max attempts exceeded")) {
        await this.giveUp(conversationId, ids, error);
      }
    } catch (e) {
      this.log.error({ conversationId, err: String(e) }, "could not record the failed batch");
    }
  }

  /**
   * Messages ran out of attempts. Fail closed like a failed AI run (handoff text to the customer,
   * chat to staff) instead of dropping them silently. Best-effort: never throws.
   */
  private async giveUp(conversationId: string, ids: string[], error: string) {
    try {
      await repo.failUnfinishedRuns(this.db, ids, error);
      const conv = await repo.getConversation(this.db, conversationId);
      const customer = conv && (await repo.getCustomer(this.db, conv.customer_id));
      const settings = await this.deps.knowledge.settings();
      // Staff already own the chat, or the bot must stay quiet.
      if (!conv || !customer || conv.mode !== "ai" || customer.is_blocked || !settings.botEnabled) return;
      const lang = conv.language ?? customer.preferred_language ?? "he";
      await this.sendReply(conv, customer, settings.handoffExpectation[lang] ?? settings.handoffExpectation.he!, null, "system");
      await performHandoff(this.handoffDeps(), {
        ...this.handoffBase(conv, customer),
        reason: "processing_error",
        summary: `Could not process the customer's messages after ${this.cfg.maxAttempts} attempts (${truncate(error, 200)})`,
        createdBy: "system",
      });
    } catch (err) {
      this.log.error({ event: "give_up_failed", conversationId, err: String(err) }, "could not hand off a failed batch");
    }
  }

  private handoffDeps() {
    return { db: this.db, notifier: this.deps.notifier, log: this.log };
  }

  private handoffBase(conv: Conversation, customer: Customer) {
    return { conversationId: conv.id, customerId: customer.id, customerWaId: customer.wa_id, customerName: customer.display_name };
  }

  /** Persist first (status 'pending'), then send; a failed send stays 'failed' for the sweeper. */
  async sendReply(conv: Conversation, customer: Customer, body: string, runId: string | null, author: "ai" | "system" | "human_agent") {
    const msg = (await repo.insertOutboundMessage(this.db, { conversationId: conv.id, customerId: customer.id, author, body, agentRunId: runId }))!;
    let waMessageId: string;
    try {
      ({ waMessageId } = await this.deps.whatsapp.sendText(customer.wa_id, body));
    } catch (err) {
      await this.markSendFailed(msg.id, err);
      this.log.error({ event: "send_failed", conversationId: conv.id, err: (err as Error).message }, "failed to send WhatsApp reply");
      return msg;
    }
    // The customer has the message now. A bookkeeping error here must not mark it failed (the sweeper would resend it).
    try {
      await repo.markOutboundSent(this.db, msg.id, waMessageId);
      await repo.touchConversation(this.db, conv.id, "outbound");
    } catch (err) {
      this.log.error({ event: "post_send_update_failed", conversationId: conv.id, waMessageId, err: (err as Error).message }, "reply sent but not recorded");
    }
    this.log.info(
      { event: "message_sent", conversationId: conv.id, author, waMessageId, ...(this.cfg.logBodies ? { body } : { chars: body.length }) },
      "reply sent",
    );
    return msg;
  }

  /** Errors like 131047 (outside the 24h window) fail the same way on every resend: don't let the sweeper retry them. */
  private markSendFailed(messageId: string, err: unknown) {
    return repo.markOutboundFailed(this.db, messageId, (err as Error).message, isPermanentSendError(err) ? this.cfg.maxAttempts : 0);
  }

  // -------------------------------------------------------------------- sweeper

  private sweeping = false;

  async sweep() {
    if (this.sweeping) return { rescheduled: 0 };
    this.sweeping = true;
    try {
      return await this.sweepOnce();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce() {
    const { ready, exhausted } = await repo.conversationsNeedingWork(this.db, 10, this.cfg.maxAttempts);
    for (const id of ready) this.schedule(id, 0);
    // Every attempt died mid-run (crash, restart) without recording a failure.
    for (const e of exhausted) await this.giveUp(e.conversationId, e.ids, "processing never completed (max attempts exceeded)");

    for (const m of await repo.failedOutboundToRetry(this.db, this.cfg.maxAttempts)) {
      try {
        const { waMessageId } = await this.deps.whatsapp.sendText(m.wa_id, m.body ?? "");
        await repo.markOutboundSent(this.db, m.id, waMessageId);
        this.log.info({ event: "resend_ok", messageId: m.id }, "resent failed reply");
      } catch (err) {
        await this.markSendFailed(m.id, err);
      }
    }
    return { rescheduled: ready.length };
  }
}

function truncateJson(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length <= 4000 ? v : { truncated: s.slice(0, 4000) };
}

