import type { Db } from "../db/client.js";
import { repo, type HandoffReason } from "../db/repo.js";
import type { Logger } from "../logger.js";
import type { WhatsAppSender } from "../whatsapp/client.js";
import { truncate } from "../util/text.js";

export interface HandoffNotice {
  handoffId: string;
  conversationId: string;
  customerWaId: string;
  customerName: string | null;
  reason: HandoffReason;
  priority: "normal" | "high";
  summary: string | null;
  orderName?: string | null;
  changeType?: string | null;
}

export interface WaitingNotice {
  conversationId: string;
  customerWaId: string;
  customerName: string | null;
  text: string | null;
}

export interface HandoffNotifier {
  notify(n: HandoffNotice): Promise<void>;
  /** A customer wrote while the chat is with staff (throttled per conversation by the notifier). */
  customerWaiting?(n: WaitingNotice): Promise<void>;
  /** Operational problem staff should know about (throttled per kind by the notifier). */
  systemAlert?(kind: string, message: string): Promise<void>;
}

/** Sends plain-text email through Resend's HTTP API (https://resend.com). */
export class ResendEmail {
  constructor(private readonly opts: { apiKey: string; from: string; to: string[]; fetchImpl?: typeof fetch }) {}

  async send(subject: string, text: string, idempotencyKey?: string) {
    const res = await (this.opts.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: this.opts.from, to: this.opts.to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`email HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

const WAITING_EVERY_MS = 30 * 60_000;
const ALERT_EVERY_MS = 60 * 60_000;

/**
 * Notifies staff via a generic webhook (point it at n8n / Slack / Make) and/or
 * WhatsApp messages to staff numbers. Staff WhatsApp delivery only works if the
 * staff member messaged the business number in the last 24h (Meta rule) —
 * the webhook is the reliable channel.
 */
export class StaffNotifier implements HandoffNotifier {
  private lastWaiting = new Map<string, number>();
  private lastAlert = new Map<string, number>();

  constructor(
    private readonly opts: {
      webhookUrl: string;
      staffNumbers: string[];
      whatsapp: WhatsAppSender;
      adminBaseUrl?: string;
      email?: ResendEmail | null;
      log: Logger;
      now?: () => number;
    },
  ) {}

  private link(conversationId: string) {
    return this.opts.adminBaseUrl ? `\n\n${this.opts.adminBaseUrl}/admin/conversations/${conversationId}` : "";
  }

  private async sendEmail(subject: string, text: string, key?: string) {
    if (!this.opts.email) return;
    try {
      await this.opts.email.send(subject, text, key);
    } catch (err) {
      this.opts.log.warn({ event: "staff_email_failed", err: String(err) }, "staff email failed");
    }
  }

  async customerWaiting(n: WaitingNotice) {
    const now = (this.opts.now ?? Date.now)();
    const last = this.lastWaiting.get(n.conversationId);
    if (last !== undefined && now - last < WAITING_EVERY_MS) return;
    this.lastWaiting.set(n.conversationId, now);
    const who = `${n.customerName ?? ""} +${n.customerWaId}`.trim();
    await this.sendEmail(
      `[BABITO] Customer waiting for staff: ${who}`,
      `The chat is with staff (the bot is not answering) and the customer wrote again:\n\n${truncate(n.text ?? "(media or empty message)", 500)}${this.link(n.conversationId)}`,
    );
  }

  async systemAlert(kind: string, message: string) {
    const now = (this.opts.now ?? Date.now)();
    const last = this.lastAlert.get(kind);
    if (last !== undefined && now - last < ALERT_EVERY_MS) return;
    this.lastAlert.set(kind, now);
    await this.sendEmail(`[BABITO] System alert: ${kind}`, `${truncate(message, 1000)}${this.opts.adminBaseUrl ? `\n\n${this.opts.adminBaseUrl}/admin` : ""}`);
  }

  async notify(n: HandoffNotice) {
    const text =
      `🔔 BABITO handoff (${n.priority})\n` +
      `Reason: ${n.reason}${n.orderName ? ` | Order ${n.orderName}` : ""}${n.changeType ? ` | ${n.changeType}` : ""}\n` +
      `Customer: ${n.customerName ?? ""} +${n.customerWaId}\n` +
      `${truncate(n.summary ?? "", 500)}` +
      (this.opts.adminBaseUrl ? `\n${this.opts.adminBaseUrl}/admin/conversations/${n.conversationId}` : "");

    const tasks: Promise<unknown>[] = [];
    if (this.opts.email) {
      const subject = `[BABITO] ${n.priority === "high" ? "URGENT " : ""}Handoff: ${n.reason}${n.orderName ? ` (order ${n.orderName})` : ""}: ${n.customerName ?? ""} +${n.customerWaId}`;
      tasks.push(this.opts.email.send(subject, text, `handoff-${n.handoffId}`));
    }
    if (this.opts.webhookUrl) {
      tasks.push(
        fetch(this.opts.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "handoff", text, ...n }),
          signal: AbortSignal.timeout(8000),
        }).then((r) => {
          if (!r.ok) throw new Error(`staff webhook HTTP ${r.status}`);
        }),
      );
    }
    for (const num of this.opts.staffNumbers) tasks.push(this.opts.whatsapp.sendText(num, text));
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === "rejected") this.opts.log.warn({ err: String(r.reason), handoffId: n.handoffId }, "staff notification failed");
  }
}

/**
 * Put the conversation in human mode (AI stops replying) and record a handoff.
 * Idempotent: at most one active handoff per conversation.
 */
export async function performHandoff(
  deps: { db: Db; notifier: HandoffNotifier; log: Logger },
  h: {
    conversationId: string;
    customerId: string;
    customerWaId: string;
    customerName: string | null;
    reason: HandoffReason;
    summary: string | null;
    kind?: "live" | "order_change";
    priority?: "normal" | "high";
    orderName?: string | null;
    changeType?: string | null;
    details?: Record<string, unknown>;
    createdBy?: "ai" | "system" | "staff";
  },
): Promise<{ handoffId: string; created: boolean }> {
  const { id, created } = await deps.db.tx(async (tx) => {
    await repo.setMode(tx, h.conversationId, "human");
    return repo.createHandoff(tx, { ...h });
  });
  deps.log.info({ event: "handoff", conversationId: h.conversationId, handoffId: id, reason: h.reason, created }, "conversation handed off to human");
  if (created) {
    // Fire-and-forget: notification failures must not break the customer reply.
    void deps.notifier
      .notify({
        handoffId: id,
        conversationId: h.conversationId,
        customerWaId: h.customerWaId,
        customerName: h.customerName,
        reason: h.reason,
        priority: h.priority ?? "normal",
        summary: h.summary,
        orderName: h.orderName,
        changeType: h.changeType,
      })
      .then(() => repo.markHandoffNotified(deps.db, id))
      .catch((err) => deps.log.warn({ err: String(err), handoffId: id }, "handoff notify error"));
  }
  return { handoffId: id, created };
}
