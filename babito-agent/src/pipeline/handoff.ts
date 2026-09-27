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

export interface HandoffNotifier {
  notify(n: HandoffNotice): Promise<void>;
}

/**
 * Notifies staff via a generic webhook (point it at n8n / Slack / Make) and/or
 * WhatsApp messages to staff numbers. Staff WhatsApp delivery only works if the
 * staff member messaged the business number in the last 24h (Meta rule) —
 * the webhook is the reliable channel.
 */
export class StaffNotifier implements HandoffNotifier {
  constructor(
    private readonly opts: { webhookUrl: string; staffNumbers: string[]; whatsapp: WhatsAppSender; adminBaseUrl?: string; log: Logger },
  ) {}

  async notify(n: HandoffNotice) {
    const text =
      `🔔 BABITO handoff (${n.priority})\n` +
      `Reason: ${n.reason}${n.orderName ? ` | Order ${n.orderName}` : ""}${n.changeType ? ` | ${n.changeType}` : ""}\n` +
      `Customer: ${n.customerName ?? ""} +${n.customerWaId}\n` +
      `${truncate(n.summary ?? "", 500)}` +
      (this.opts.adminBaseUrl ? `\n${this.opts.adminBaseUrl}/admin/conversations/${n.conversationId}` : "");

    const tasks: Promise<unknown>[] = [];
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
