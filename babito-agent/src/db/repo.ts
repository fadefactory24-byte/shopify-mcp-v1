import type { Db } from "./client.js";
import type { Lang } from "../util/text.js";

export interface Customer {
  id: string;
  wa_id: string;
  display_name: string | null;
  preferred_language: Lang | null;
  shopify_customer_id: string | null;
  is_blocked: boolean;
}

export interface ConversationContext {
  /** Products discussed recently, newest first. Lets "بكم؟" resolve without re-asking. */
  recent_products?: { id: string; title: string }[];
  /** Order names this conversation proved ownership of (phone/email match). */
  verified_orders?: string[];
  /** Failed ownership checks, to throttle order-number guessing. */
  failed_verifications?: { at: string }[];
  /** Whether we already told this customer they hit the rate limit. */
  rate_limit_notified_at?: string;
  /** Message count covered by the rolling summary. */
  summarized_count?: number;
}

export interface Conversation {
  id: string;
  customer_id: string;
  channel?: "whatsapp" | "email";
  status: "open" | "closed";
  mode: "ai" | "human" | "paused";
  language: Lang | null;
  summary: string | null;
  context: ConversationContext;
  human_since: string | null;
  human_last_activity_at: string | null;
  last_message_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  customer_id: string;
  direction: "inbound" | "outbound";
  author: "customer" | "ai" | "human_agent" | "system";
  wa_message_id: string | null;
  type: string;
  body: string | null;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
}

export interface KbArticle {
  key: string;
  category: string;
  title: string;
  content: string;
  language: string;
  product_ids: string[];
  priority: number;
}

export type HandoffReason =
  | "customer_request"
  | "complaint"
  | "refund"
  | "payment_issue"
  | "shipping_issue"
  | "order_change"
  | "uncertain"
  | "tool_failure"
  | "sensitive"
  | "processing_error"
  | "other";

/**
 * All SQL lives here. Every function takes a Db so callers can pass a
 * transaction-bound Db when atomicity matters.
 */
export const repo = {
  // ------------------------------------------------------------------ customers
  async upsertCustomer(db: Db, waId: string, displayName: string | null): Promise<Customer> {
    const { rows } = await db.query<Customer>(
      `insert into customers (wa_id, display_name) values ($1, $2)
       on conflict (wa_id) do update
         set display_name = coalesce(excluded.display_name, customers.display_name),
             last_seen_at = now()
       returning id, wa_id, display_name, preferred_language, shopify_customer_id, is_blocked`,
      [waId, displayName],
    );
    return rows[0]!;
  },

  async getCustomer(db: Db, id: string): Promise<Customer | null> {
    const { rows } = await db.query<Customer>(
      `select id, wa_id, display_name, preferred_language, shopify_customer_id, is_blocked from customers where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async setCustomerShopifyId(db: Db, id: string, shopifyId: string | null) {
    await db.query(`update customers set shopify_customer_id = $2 where id = $1`, [id, shopifyId]);
  },

  async setCustomerLanguage(db: Db, id: string, lang: Lang) {
    await db.query(`update customers set preferred_language = $2 where id = $1 and preferred_language is distinct from $2`, [id, lang]);
  },

  /**
   * Block a contact (WhatsApp id or 'email:' handle) so the AI never replies to them, even before
   * they've ever messaged (e.g. a known supplier number the owner is pre-adding). Their messages
   * still arrive and are stored — visible in /admin, and staff can reply normally — the AI just
   * never processes them (see MessageProcessor.handleBatch's is_blocked check).
   */
  async blockContact(db: Db, waId: string, displayName: string | null): Promise<Customer> {
    const { rows } = await db.query<Customer>(
      `insert into customers (wa_id, display_name, is_blocked) values ($1, $2, true)
       on conflict (wa_id) do update set is_blocked = true, display_name = coalesce(customers.display_name, excluded.display_name)
       returning id, wa_id, display_name, preferred_language, shopify_customer_id, is_blocked`,
      [waId, displayName],
    );
    return rows[0]!;
  },

  async unblockContact(db: Db, id: string) {
    await db.query(`update customers set is_blocked = false where id = $1`, [id]);
  },

  async listBlockedContacts(db: Db): Promise<Customer[]> {
    const { rows } = await db.query<Customer>(
      `select id, wa_id, display_name, preferred_language, shopify_customer_id, is_blocked from customers where is_blocked = true order by wa_id`,
    );
    return rows;
  },

  // -------------------------------------------------------------- conversations
  async getOrCreateOpenConversation(db: Db, customerId: string): Promise<Conversation> {
    const existing = await db.query<Conversation>(`select * from conversations where customer_id = $1 and status = 'open'`, [customerId]);
    if (existing.rows[0]) return existing.rows[0];
    // Race-safe: the partial unique index guarantees a single open conversation.
    const { rows } = await db.query<Conversation>(
      `insert into conversations (customer_id) values ($1)
       on conflict (customer_id) where status = 'open' do update set updated_at = now()
       returning *`,
      [customerId],
    );
    return rows[0]!;
  },

  async getConversation(db: Db, id: string): Promise<Conversation | null> {
    const { rows } = await db.query<Conversation>(`select * from conversations where id = $1`, [id]);
    return rows[0] ?? null;
  },

  async touchConversation(db: Db, id: string, direction: "inbound" | "outbound") {
    const col = direction === "inbound" ? "last_inbound_at" : "last_outbound_at";
    await db.query(`update conversations set ${col} = now(), last_message_at = now() where id = $1`, [id]);
  },

  /** Acquire the per-conversation processing lease for `owner`. Returns false if someone else holds it. */
  async claimConversation(db: Db, id: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const { rows } = await db.query(
      `update conversations set processing_until = now() + make_interval(secs => $3), processing_owner = $2
       where id = $1 and (processing_until is null or processing_until < now())
       returning id`,
      [id, owner, leaseSeconds],
    );
    return rows.length > 0;
  },

  /** Returns false if `owner` no longer holds the lease (it expired and another worker took it). */
  async extendLease(db: Db, id: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const { rows } = await db.query(
      `update conversations set processing_until = now() + make_interval(secs => $3)
       where id = $1 and processing_owner = $2
       returning id`,
      [id, owner, leaseSeconds],
    );
    return rows.length > 0;
  },

  async releaseConversation(db: Db, id: string, owner: string) {
    await db.query(`update conversations set processing_until = null, processing_owner = null where id = $1 and processing_owner = $2`, [id, owner]);
  },

  async updateConversationContext(db: Db, id: string, context: ConversationContext) {
    await db.query(`update conversations set context = $2::jsonb where id = $1`, [id, JSON.stringify(context)]);
  },

  async setConversationLanguage(db: Db, id: string, lang: Lang) {
    await db.query(`update conversations set language = $2 where id = $1`, [id, lang]);
  },

  async setConversationSummary(db: Db, id: string, summary: string, summarizedCount: number) {
    await db.query(
      `update conversations set summary = $2, context = jsonb_set(context, '{summarized_count}', to_jsonb($3::int)) where id = $1`,
      [id, summary, summarizedCount],
    );
  },

  async setMode(db: Db, id: string, mode: Conversation["mode"]) {
    await db.query(
      `update conversations set mode = $2,
         human_since = case when $2 = 'human' then coalesce(human_since, now()) else null end,
         human_last_activity_at = case when $2 = 'human' then now() else null end
       where id = $1`,
      [id, mode],
    );
  },

  async touchHumanActivity(db: Db, id: string) {
    await db.query(`update conversations set human_last_activity_at = now() where id = $1`, [id]);
  },

  // ------------------------------------------------------------------- messages
  /** Returns null when wa_message_id was already stored (duplicate webhook delivery). */
  async insertInboundMessage(
    db: Db,
    m: {
      conversationId: string;
      customerId: string;
      waMessageId: string;
      type: string;
      body: string | null;
      media: unknown;
      waTimestamp: Date | null;
    },
  ): Promise<MessageRow | null> {
    const { rows } = await db.query<MessageRow>(
      `insert into messages (conversation_id, customer_id, direction, author, wa_message_id, type, body, media, status, wa_timestamp)
       values ($1, $2, 'inbound', 'customer', $3, $4, $5, $6::jsonb, 'received', $7)
       on conflict (wa_message_id) where wa_message_id is not null do nothing
       returning *`,
      [m.conversationId, m.customerId, m.waMessageId, m.type, m.body, m.media ? JSON.stringify(m.media) : null, m.waTimestamp],
    );
    return rows[0] ?? null;
  },

  async insertOutboundMessage(
    db: Db,
    m: { conversationId: string; customerId: string; author: "ai" | "human_agent" | "system"; body: string; agentRunId?: string | null; waMessageId?: string | null; status?: string },
  ): Promise<MessageRow | null> {
    const { rows } = await db.query<MessageRow>(
      `insert into messages (conversation_id, customer_id, direction, author, type, body, status, agent_run_id, wa_message_id)
       values ($1, $2, 'outbound', $3, 'text', $4, $5, $6, $7)
       on conflict (wa_message_id) where wa_message_id is not null do nothing
       returning *`,
      [m.conversationId, m.customerId, m.author, m.body, m.status ?? "pending", m.agentRunId ?? null, m.waMessageId ?? null],
    );
    return rows[0] ?? null; // null only for a duplicate echo with a known wa_message_id
  },

  async markOutboundSent(db: Db, id: string, waMessageId: string) {
    await db.query(`update messages set status = 'sent', wa_message_id = $2, attempts = attempts + 1, error = null where id = $1`, [id, waMessageId]);
  },

  /** Pass `noRetryAt` (the retry limit) for errors a resend cannot fix: attempts jump to it, so the sweeper skips the message. */
  async markOutboundFailed(db: Db, id: string, error: string, noRetryAt = 0) {
    await db.query(`update messages set status = 'failed', attempts = greatest(attempts + 1, $3), error = $2 where id = $1`, [id, error.slice(0, 500), noRetryAt]);
  },

  /** Delivery receipts only move forward (sent -> delivered -> read); 'failed' always applies. */
  async applyStatusUpdate(db: Db, waMessageId: string, status: string, error: string | null) {
    const rank: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
    if (status === "failed") {
      await db.query(`update messages set status = 'failed', error = $2 where wa_message_id = $1 and direction = 'outbound'`, [waMessageId, error]);
      return;
    }
    if (!(status in rank)) return;
    await db.query(
      `update messages set status = $2
       where wa_message_id = $1 and direction = 'outbound'
         and (case status when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 99 end) < $3`,
      [waMessageId, status, rank[status]],
    );
  },

  /** Atomically move this conversation's received inbound messages to 'processing'. */
  async claimPendingInbound(db: Db, conversationId: string): Promise<MessageRow[]> {
    const { rows } = await db.query<MessageRow>(
      `update messages set status = 'processing', attempts = attempts + 1
       where conversation_id = $1 and direction = 'inbound' and status = 'received'
       returning *`,
      [conversationId],
    );
    return rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  },

  async setInboundStatus(db: Db, ids: string[], status: "processed" | "skipped" | "failed" | "received", error?: string | null) {
    if (ids.length === 0) return;
    await db.query(`update messages set status = $2, error = $3 where id = any($1::uuid[])`, [ids, status, error ?? null]);
  },

  /**
   * A batch threw: move its rows to 'received' (retry) or 'failed' (give up). Only rows still
   * 'processing' move, so a batch that already replied and marked itself processed is not answered
   * twice. Returns how many rows moved.
   */
  async releaseFailedBatch(db: Db, ids: string[], status: "received" | "failed", error: string): Promise<number> {
    if (ids.length === 0) return 0;
    const { rows } = await db.query(
      `update messages set status = $2, error = $3 where id = any($1::uuid[]) and status = 'processing' returning id`,
      [ids, status, error.slice(0, 500)],
    );
    return rows.length;
  },

  /** Shutdown: re-queue a conversation whose run will not finish in this process. */
  async requeueProcessingInbound(db: Db, conversationId: string) {
    await db.query(`update messages set status = 'received' where conversation_id = $1 and direction = 'inbound' and status = 'processing'`, [conversationId]);
  },

  async linkInboundToRun(db: Db, ids: string[], runId: string) {
    if (ids.length === 0) return;
    await db.query(`update messages set agent_run_id = $2 where id = any($1::uuid[])`, [ids, runId]);
  },

  async recentMessages(db: Db, conversationId: string, limit: number): Promise<MessageRow[]> {
    const { rows } = await db.query<MessageRow>(
      `select * from (
         select * from messages
         where conversation_id = $1 and body is not null
           and (direction = 'outbound' and status <> 'failed' or direction = 'inbound' and status in ('processed','processing','skipped'))
         order by created_at desc limit $2
       ) t order by created_at asc`,
      [conversationId, limit],
    );
    return rows;
  },

  async countInboundSince(db: Db, customerId: string, minutes: number): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from messages where customer_id = $1 and direction = 'inbound' and created_at > now() - make_interval(mins => $2)`,
      [customerId, minutes],
    );
    return Number(rows[0]?.n ?? 0);
  },

  // ----------------------------------------------------------------- recovery
  /**
   * Conversations with inbound messages that should have been processed by now (`ready`), and
   * messages that just ran out of attempts (`exhausted`, marked failed here; the caller tells the customer).
   */
  async conversationsNeedingWork(
    db: Db,
    olderThanSeconds: number,
    maxAttempts: number,
  ): Promise<{ ready: string[]; exhausted: { conversationId: string; ids: string[] }[] }> {
    // Stale 'processing' rows (worker crashed and its lease expired) go back to 'received'.
    await db.query(
      `update messages m set status = 'received'
       from conversations c
       where m.conversation_id = c.id and m.direction = 'inbound' and m.status = 'processing'
         and (c.processing_until is null or c.processing_until < now())
         and m.updated_at < now() - interval '5 minutes'`,
    );
    // Give up after maxAttempts.
    const exhausted = await db.query<{ conversation_id: string; ids: string[] }>(
      `with failed as (
         update messages set status = 'failed', error = 'max attempts exceeded'
         where direction = 'inbound' and status = 'received' and attempts >= $1
         returning id, conversation_id
       )
       select conversation_id, array_agg(id)::text[] as ids from failed group by conversation_id`,
      [maxAttempts],
    );
    const { rows } = await db.query<{ conversation_id: string }>(
      `select distinct conversation_id from messages
       where direction = 'inbound' and status = 'received' and created_at < now() - make_interval(secs => $1)
       limit 50`,
      [olderThanSeconds],
    );
    return {
      ready: rows.map((r) => r.conversation_id),
      exhausted: exhausted.rows.map((r) => ({ conversationId: r.conversation_id, ids: r.ids })),
    };
  },

  /** Recent failed outbound replies worth retrying (only very fresh ones — stale replies confuse customers). */
  async failedOutboundToRetry(db: Db, maxAttempts: number): Promise<(MessageRow & { wa_id: string })[]> {
    const { rows } = await db.query<MessageRow & { wa_id: string }>(
      `select m.*, c.wa_id from messages m join customers c on c.id = m.customer_id
       where m.direction = 'outbound' and m.status = 'failed' and m.attempts < $1
         and m.wa_message_id is null and m.created_at > now() - interval '3 minutes'
       order by m.created_at limit 20`,
      [maxAttempts],
    );
    return rows;
  },

  // ----------------------------------------------------------------- agent runs
  async createRun(db: Db, conversationId: string, model: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`insert into agent_runs (conversation_id, model) values ($1, $2) returning id`, [conversationId, model]);
    return rows[0]!.id;
  },

  async finishRun(
    db: Db,
    id: string,
    r: { status: string; iterations: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; latencyMs: number; replyText: string | null; flags: string[]; error?: string | null },
  ) {
    await db.query(
      `update agent_runs set status = $2, iterations = $3, input_tokens = $4, output_tokens = $5, cache_read_tokens = $6,
         latency_ms = $7, reply_text = $8, guardrail_flags = $9, error = $10, finished_at = now()
       where id = $1`,
      [id, r.status, r.iterations, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.latencyMs, r.replyText, r.flags, r.error ?? null],
    );
  },

  /** A batch threw mid-run: close the run it started (if any) instead of leaving it 'running' forever. */
  async failUnfinishedRuns(db: Db, messageIds: string[], error: string) {
    if (messageIds.length === 0) return;
    await db.query(
      `update agent_runs set status = 'failed', error = $2, finished_at = now()
       where status = 'running' and id in (select agent_run_id from messages where id = any($1::uuid[]))`,
      [messageIds, error.slice(0, 500)],
    );
  },

  async insertToolCall(
    db: Db,
    t: { runId: string; conversationId: string; tool: string; input: unknown; output: unknown; success: boolean; error?: string | null; latencyMs: number },
  ) {
    await db.query(
      `insert into tool_calls (agent_run_id, conversation_id, tool_name, input, output, success, error, latency_ms)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [t.runId, t.conversationId, t.tool, JSON.stringify(t.input ?? null), JSON.stringify(t.output ?? null), t.success, t.error ?? null, t.latencyMs],
    );
  },

  // ------------------------------------------------------------------- handoffs
  async createHandoff(
    db: Db,
    h: {
      conversationId: string;
      customerId: string;
      kind?: "live" | "order_change";
      reason: HandoffReason;
      priority?: "normal" | "high";
      summary: string | null;
      orderName?: string | null;
      changeType?: string | null;
      details?: Record<string, unknown>;
      createdBy?: "ai" | "system" | "staff";
    },
  ): Promise<{ id: string; created: boolean }> {
    const { rows } = await db.query<{ id: string }>(
      `insert into handoffs (conversation_id, customer_id, kind, reason, priority, summary, order_name, change_type, details, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       on conflict (conversation_id) where status in ('open','claimed') do nothing
       returning id`,
      [
        h.conversationId,
        h.customerId,
        h.kind ?? "live",
        h.reason,
        h.priority ?? "normal",
        h.summary,
        h.orderName ?? null,
        h.changeType ?? null,
        JSON.stringify(h.details ?? {}),
        h.createdBy ?? "ai",
      ],
    );
    if (rows[0]) return { id: rows[0].id, created: true };
    const existing = await db.query<{ id: string }>(`select id from handoffs where conversation_id = $1 and status in ('open','claimed')`, [h.conversationId]);
    return { id: existing.rows[0]!.id, created: false };
  },

  async markHandoffNotified(db: Db, id: string) {
    await db.query(`update handoffs set notified_at = now() where id = $1`, [id]);
  },

  async resolveActiveHandoffs(db: Db, conversationId: string, by: string) {
    await db.query(
      `update handoffs set status = 'resolved', resolved_at = now(), claimed_by = coalesce(claimed_by, $2)
       where conversation_id = $1 and status in ('open','claimed')`,
      [conversationId, by],
    );
  },

  // ------------------------------------------------------------------- memory
  async getMemories(db: Db, customerId: string): Promise<{ key: string; value: string }[]> {
    const { rows } = await db.query<{ key: string; value: string }>(
      `select key, value from customer_memories where customer_id = $1 and (expires_at is null or expires_at > now()) order by key`,
      [customerId],
    );
    return rows;
  },

  async upsertMemory(db: Db, customerId: string, key: string, value: string, source: "ai" | "staff" | "system", ttlDays: number | null) {
    await db.query(
      `insert into customer_memories (customer_id, key, value, source, expires_at)
       values ($1, $2, $3, $4, case when $5::int is null then null else now() + make_interval(days => $5::int) end)
       on conflict (customer_id, key) do update set value = excluded.value, source = excluded.source, expires_at = excluded.expires_at`,
      [customerId, key, value, source, ttlDays],
    );
  },

  async deleteMemories(db: Db, customerId: string) {
    await db.query(`delete from customer_memories where customer_id = $1`, [customerId]);
  },

  // ---------------------------------------------------------- knowledge/settings
  async activeKb(db: Db): Promise<KbArticle[]> {
    const { rows } = await db.query<KbArticle>(
      `select key, category, title, content, language, product_ids, priority from kb_articles
       where is_active and deleted_at is null order by priority desc, key`,
    );
    return rows;
  },

  async allSettings(db: Db): Promise<Record<string, unknown>> {
    const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from settings`);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async setSetting(db: Db, key: string, value: unknown) {
    await db.query(
      `insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  },

  async audit(db: Db, actor: string, action: string, entity: string | null, entityId: string | null, details: Record<string, unknown> = {}) {
    await db.query(`insert into audit_log (actor, action, entity, entity_id, details) values ($1, $2, $3, $4, $5::jsonb)`, [
      actor,
      action,
      entity,
      entityId,
      JSON.stringify(details),
    ]);
  },
};
