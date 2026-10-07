import type { Db } from "../db/client.js";
import { repo, type HandoffReason } from "../db/repo.js";
import type { Logger } from "../logger.js";
import type { WhatsAppSender } from "../whatsapp/client.js";
import { truncate } from "../util/text.js";
import { displayHandle, isEmailHandle } from "../email/channel.js";
import { socialPlatformOf } from "../social/webhook.js";

/** Where the customer wrote and where staff must answer, in Arabic, so the alert says it explicitly. */
export function replyWhere(handle: string): string {
  if (isEmailHandle(handle)) return "عبر الإيميل: الرد من صندوق support@mybabito.com (Outlook)";
  const social = socialPlatformOf(handle);
  if (social === "messenger") return "عبر ماسنجر: الرد من Meta Business Suite ثم Inbox";
  if (social === "instagram") return "عبر إنستغرام: الرد من Meta Business Suite ثم Inbox";
  return "عبر واتساب البوت: الرد من داشبورد البوت (admin)";
}

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

/** Where staff alert emails go out (the support mailbox via Microsoft Graph). */
export interface AlertEmail {
  send(subject: string, text: string, idempotencyKey?: string): Promise<void>;
}

const WAITING_EVERY_MS = 30 * 60_000;
const ALERT_EVERY_MS = 60 * 60_000;

/**
 * Notifies staff of a handoff via WhatsApp messages to staff numbers (the only channel for
 * handoff alerts — no email leg) and/or a generic webhook (point it at n8n / Slack / Make).
 * Plain-text staff WhatsApp delivery only works if the staff member messaged the business
 * number in the last 24h (Meta rule); when an approved message template is configured
 * (handoffTemplate), that's used instead so delivery doesn't depend on the 24h window.
 * customerWaiting() and systemAlert() are separate, unaffected staff-email alerts.
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
      email?: AlertEmail | null;
      /** Handoff on an email conversation: flag the customer's email in the mailbox. */
      flagEmail?: (handle: string) => Promise<void>;
      /** Approved WhatsApp template for handoff alerts: body params are [customer, reason, summary]. */
      handoffTemplate?: { name: string; language: string };
      /** Called with the WhatsApp message id of every alert sent to a staff number, so a reply to it can be tied back to its chat. */
      onAlertSent?: (waMessageId: string, staffNumber: string, conversationId: string | null) => Promise<void>;
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
    const who = `${n.customerName ?? ""} ${displayHandle(n.customerWaId)}`.trim();
    // Also on WhatsApp, so staff can answer in plain words (the reply goes through the staff relay).
    const oneLine = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 300) || "-";
    const template = this.opts.handoffTemplate;
    for (const num of this.opts.staffNumbers) {
      const send =
        template && this.opts.whatsapp.sendTemplate
          ? this.opts.whatsapp.sendTemplate.call(this.opts.whatsapp, num, template.name, template.language, [
              oneLine(`${who} (${replyWhere(n.customerWaId)})`),
              "Customer replied",
              oneLine(n.text ?? "(media or empty message)"),
            ])
          : this.opts.whatsapp.sendText(num, `Customer replied: ${who}\n${truncate(n.text ?? "(media or empty message)", 500)}`);
      void send.then((r) => this.remember(r, num, n.conversationId)).catch((err) => this.opts.log.warn({ event: "staff_waiting_whatsapp_failed", err: String(err) }, "waiting alert on WhatsApp failed"));
    }
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

  private async remember(r: { waMessageId: string }, staffNumber: string, conversationId: string | null) {
    try {
      await this.opts.onAlertSent?.(r.waMessageId, staffNumber, conversationId);
    } catch (err) {
      this.opts.log.warn({ event: "staff_alert_record_failed", err: String(err) }, "could not record the alert for replies");
    }
    return r;
  }

  /** Send the handoff alert to every staff number now and report what happened per number (for the dashboard's test button). */
  async sendTest(): Promise<{ to: string; ok: boolean; detail: string }[]> {
    const template = this.opts.handoffTemplate;
    const out: { to: string; ok: boolean; detail: string }[] = [];
    for (const to of this.opts.staffNumbers) {
      try {
        if (template && this.opts.whatsapp.sendTemplate) {
          await this.remember(
            await this.opts.whatsapp.sendTemplate(to, template.name, template.language, ["TEST - Dana +972501234567", "complaint | Order #0000 (test only)", "This is a test alert, no action needed"]),
            to,
            null,
          );
          out.push({ to, ok: true, detail: `template ${template.name} (${template.language}) accepted by WhatsApp` });
        } else {
          await this.remember(await this.opts.whatsapp.sendText(to, "BABITO test alert: no action needed."), to, null);
          out.push({ to, ok: true, detail: "plain text accepted by WhatsApp (no template configured)" });
        }
      } catch (err) {
        out.push({ to, ok: false, detail: String(err instanceof Error ? err.message : err).slice(0, 300) });
      }
    }
    if (this.opts.staffNumbers.length === 0) out.push({ to: "-", ok: false, detail: "STAFF_WHATSAPP_NUMBERS is empty" });
    return out;
  }

  async notify(n: HandoffNotice) {
    const text =
      `🔔 BABITO handoff (${n.priority})\n` +
      `Reason: ${n.reason}${n.orderName ? ` | Order ${n.orderName}` : ""}${n.changeType ? ` | ${n.changeType}` : ""}\n` +
      `Customer: ${n.customerName ?? ""} ${displayHandle(n.customerWaId)}${isEmailHandle(n.customerWaId) ? " (email)" : " (WhatsApp)"}\n` +
      `${truncate(n.summary ?? "", 500)}` +
      (this.opts.adminBaseUrl ? `\n${this.opts.adminBaseUrl}/admin/conversations/${n.conversationId}` : "");

    const tasks: Promise<unknown>[] = [];
    // Handoff alerts go out over WhatsApp only (see StaffNotifier class doc) — no email leg here.
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
    if (this.opts.flagEmail && isEmailHandle(n.customerWaId)) tasks.push(this.opts.flagEmail(n.customerWaId));
    const template = this.opts.handoffTemplate;
    if (template && this.opts.whatsapp.sendTemplate) {
      // Template params can't contain newlines or be empty (WhatsApp rejects both).
      const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300) || "-";
      const customer = oneLine(`${n.customerName ?? ""} ${displayHandle(n.customerWaId)} (${replyWhere(n.customerWaId)})`);
      const reason = oneLine(`${n.reason}${n.orderName ? ` | Order ${n.orderName}` : ""}${n.changeType ? ` | ${n.changeType}` : ""}`);
      const summary = oneLine(n.summary ?? "(no summary)");
      const sendTemplate = this.opts.whatsapp.sendTemplate;
      for (const num of this.opts.staffNumbers) {
        tasks.push(sendTemplate.call(this.opts.whatsapp, num, template.name, template.language, [customer, reason, summary]).then((r) => this.remember(r, num, n.conversationId)));
      }
    } else {
      for (const num of this.opts.staffNumbers) tasks.push(this.opts.whatsapp.sendText(num, text).then((r) => this.remember(r, num, n.conversationId)));
    }
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
