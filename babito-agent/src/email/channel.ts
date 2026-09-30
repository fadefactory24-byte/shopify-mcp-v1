import type { Db } from "../db/client.js";
import { repo } from "../db/repo.js";
import type { Logger } from "../logger.js";
import type { WhatsAppSender } from "../whatsapp/client.js";
import type { InboxMessage, MailApi } from "./graph.js";
import { isSocialHandle, socialIdOf, socialPlatformOf } from "../social/webhook.js";

/**
 * Email as a second channel next to WhatsApp. Customers are keyed by the handle 'email:<address>'.
 * The poller turns new customer emails into inbound messages (same pipeline, same rules as
 * WhatsApp); replies go back in the same thread. Replies staff send themselves from Outlook put
 * the conversation in human mode, like WhatsApp Business app echoes.
 */

export const EMAIL_PREFIX = "email:";

export function isEmailHandle(handle: string): boolean {
  return handle.startsWith(EMAIL_PREFIX);
}
export function emailOf(handle: string): string | null {
  return isEmailHandle(handle) ? handle.slice(EMAIL_PREFIX.length) : null;
}
export function emailHandle(address: string): string {
  return EMAIL_PREFIX + address.trim().toLowerCase();
}
/** Human-readable customer id for alerts and the dashboard. */
export function displayHandle(handle: string): string {
  const email = emailOf(handle);
  if (email) return email;
  const platform = socialPlatformOf(handle);
  if (platform) return `${platform === "instagram" ? "Instagram" : "Messenger"} user ${socialIdOf(handle)}`;
  return `+${handle}`;
}

const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletter|news|marketing|billing|invoices?|receipts?|support-noreply)([+._-].*)?$/i;
const PLATFORM_DOMAINS = [
  "facebookmail.com", "facebook.com", "meta.com", "instagram.com", "whatsapp.com", "shopify.com", "shopifyemail.com", "google.com",
  "youtube.com", "microsoft.com", "microsoftonline.com", "office.com", "outlook.com-bounce", "apple.com", "github.com", "railway.app",
  "railway.com", "supabase.io", "supabase.com", "anthropic.com", "claude.com", "17track.net", "resend.dev", "stripe.com", "paypal.com",
  "linkedin.com", "tiktok.com", "amazonses.com", "sendgrid.net", "mailchimp.com", "mcsv.net",
];
const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|out of office|undeliverable|delivery status notification|תשובה אוטומטית|לא ניתן למסור|رد تلقائي)/i;

/** Why an inbound email must not get an AI answer (automated, platform, loop risk), or null. */
export function skipReason(m: InboxMessage, mailbox: string): string | null {
  const from = m.fromAddress;
  if (!from || !from.includes("@")) return "no_sender";
  if (from === mailbox.toLowerCase()) return "own_mailbox";
  const [local, domain] = from.split("@") as [string, string];
  if (AUTOMATED_LOCAL.test(local)) return "automated_sender";
  if (PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return "platform_sender";
  const h = m.headers;
  const auto = (h["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return "auto_submitted";
  if (/^(bulk|list|junk)$/i.test((h["precedence"] ?? "").trim())) return "bulk";
  if (h["list-unsubscribe"] || h["list-id"]) return "mailing_list";
  if (h["x-autoreply"] || h["x-autorespond"] || /\b(all|oof|autoreply)\b/i.test(h["x-auto-response-suppress"] ?? "")) return "auto_reply";
  if (AUTO_SUBJECT.test(m.subject.trim())) return "auto_reply_subject";
  return null;
}

/** Text of an inbound email for the AI: subject on the first message of a thread, capped. */
function inboundText(m: InboxMessage): string | null {
  const body = m.text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
  const subject = m.subject.replace(/^(re|fw|fwd|השב|העבר)\s*:\s*/gi, "").trim();
  const parts = [subject && !body.startsWith(subject) ? `[Subject: ${subject}]` : "", body].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

export class EmailChannel {
  constructor(
    private readonly deps: {
      db: Db;
      mail: MailApi;
      mailbox: string;
      log: Logger;
      schedule: (conversationId: string) => void;
      applyStaffReplies: (echoes: { waMessageId: string; to: string; text: string | null }[]) => Promise<void>;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private async watermark(key: string): Promise<Date | null> {
    const { rows } = await this.deps.db.query<{ value: { at?: string } }>(`select value from integration_state where key = $1`, [key]);
    return rows[0]?.value?.at ? new Date(rows[0].value.at) : null;
  }
  private async setWatermark(key: string, at: Date) {
    await this.deps.db.query(
      `insert into integration_state (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify({ at: at.toISOString() })],
    );
  }

  /** One polling round: new customer emails, then replies staff sent from Outlook. Never throws. */
  async poll(): Promise<{ ingested: number; skipped: number; staffReplies: number }> {
    const out = { ingested: 0, skipped: 0, staffReplies: 0 };
    try {
      await this.pollInbox(out);
      await this.pollSent(out);
    } catch (err) {
      this.deps.log.warn({ event: "email_poll_failed", err: String(err) }, "email polling failed");
    }
    return out;
  }

  private async pollInbox(out: { ingested: number; skipped: number }) {
    const since = await this.watermark("email_inbox_since");
    if (!since) {
      // First run: start from now. Old mail is never answered.
      await this.setWatermark("email_inbox_since", new Date(this.now()));
      return;
    }
    // Small overlap: messages are idempotent by id, and delivery timestamps can lag a little.
    const messages = await this.deps.mail.listInbox(new Date(since.getTime() - 2 * 60_000));
    let newest = since;
    for (const m of messages) {
      const at = new Date(m.receivedAt);
      if (at > newest) newest = at;
      const reason = skipReason(m, this.deps.mailbox);
      if (reason) {
        out.skipped++;
        continue;
      }
      const text = inboundText(m);
      const conversationId = await this.deps.db.tx(async (tx) => {
        const customer = await repo.upsertCustomer(tx, emailHandle(m.fromAddress), m.fromName);
        const conv = await repo.getOrCreateOpenConversation(tx, customer.id);
        if ((conv as { channel?: string }).channel !== "email") await tx.query(`update conversations set channel = 'email' where id = $1`, [conv.id]);
        const row = await repo.insertInboundMessage(tx, {
          conversationId: conv.id,
          customerId: customer.id,
          waMessageId: m.id,
          type: text ? "text" : m.hasAttachments ? "document" : "text",
          body: text,
          media: m.hasAttachments ? { kind: "email_attachment" } : null,
          waTimestamp: at,
        });
        if (!row) return null; // already ingested (overlap window)
        await repo.touchConversation(tx, conv.id, "inbound");
        return conv.id;
      });
      if (conversationId) {
        out.ingested++;
        this.deps.log.info({ event: "email_received", conversationId }, "customer email received");
        this.deps.schedule(conversationId);
      }
    }
    if (newest > since) await this.setWatermark("email_inbox_since", newest);
  }

  private async pollSent(out: { staffReplies: number }) {
    const since = await this.watermark("email_sent_since");
    if (!since) {
      await this.setWatermark("email_sent_since", new Date(this.now()));
      return;
    }
    const sent = await this.deps.mail.listSent(new Date(since.getTime() - 2 * 60_000));
    let newest = since;
    for (const s of sent) {
      const at = new Date(s.sentAt);
      if (at > newest) newest = at;
      for (const to of s.toAddresses) {
        const handle = emailHandle(to);
        const { rows } = await this.deps.db.query<{ body: string | null; wa_message_id: string | null }>(
          `select m.body, m.wa_message_id from messages m join customers c on c.id = m.customer_id
           where c.wa_id = $1 and m.direction = 'outbound' and m.created_at > now() - interval '2 days'`,
          [handle],
        );
        if (rows.length === 0 && !(await this.knownCustomer(handle))) continue; // not a customer conversation
        // Our own replies (by id, or by text while the send is still being recorded) are not staff replies.
        const sentText = normalize(s.text);
        const mine = rows.some((r) => {
          const ours = normalize(r.body ?? "").slice(0, 120);
          return r.wa_message_id === s.id || (ours.length > 0 && sentText.startsWith(ours));
        });
        if (mine) continue;
        await this.deps.applyStaffReplies([{ waMessageId: s.id, to: handle, text: s.text || null }]);
        out.staffReplies++;
      }
    }
    if (newest > since) await this.setWatermark("email_sent_since", newest);
  }

  private async knownCustomer(handle: string) {
    const { rows } = await this.deps.db.query(`select 1 from customers where wa_id = $1`, [handle]);
    return rows.length > 0;
  }

  /** Reply to an email customer: in the thread of their latest email, or a new email if none. */
  async sendReply(handle: string, body: string): Promise<{ waMessageId: string }> {
    const address = emailOf(handle)!;
    const { rows } = await this.deps.db.query<{ wa_message_id: string }>(
      `select m.wa_message_id from messages m join customers c on c.id = m.customer_id
       where c.wa_id = $1 and m.direction = 'inbound' and m.wa_message_id is not null
       order by m.created_at desc limit 1`,
      [handle],
    );
    const replyTo = rows[0]?.wa_message_id;
    if (replyTo) return { waMessageId: await this.deps.mail.reply(replyTo, body) };
    await this.deps.mail.sendMail([address], "BABITO", body);
    return { waMessageId: `email-new-${this.now()}` };
  }

  /** Handoff on an email conversation: flag the customer's latest email for staff in Outlook. */
  async flagLatest(handle: string) {
    const { rows } = await this.deps.db.query<{ wa_message_id: string }>(
      `select m.wa_message_id from messages m join customers c on c.id = m.customer_id
       where c.wa_id = $1 and m.direction = 'inbound' and m.wa_message_id is not null
       order by m.created_at desc limit 1`,
      [handle],
    );
    if (rows[0]) await this.deps.mail.flagForStaff(rows[0].wa_message_id, "BABITO: needs staff");
  }
}

/**
 * The pipeline's sender: WhatsApp ids go to WhatsApp, 'email:' handles to the mailbox, 'psid:'/
 * 'igsid:' handles to Messenger/Instagram. Read receipts and typing indicators only exist on
 * WhatsApp.
 */
export class ChannelSender implements WhatsAppSender {
  constructor(
    private readonly whatsapp: WhatsAppSender,
    private readonly email: EmailChannel | null,
    private readonly social: WhatsAppSender | null = null,
  ) {}

  async sendText(to: string, body: string) {
    if (isEmailHandle(to)) {
      if (!this.email) throw new Error("email channel is not configured");
      return this.email.sendReply(to, body);
    }
    if (isSocialHandle(to)) {
      if (!this.social) throw new Error("the Messenger/Instagram channel is not configured");
      return this.social.sendText(to, body);
    }
    return this.whatsapp.sendText(to, body);
  }

  async markRead(waMessageId: string, typing: boolean) {
    if (!waMessageId.startsWith("wamid.")) return;
    return this.whatsapp.markRead(waMessageId, typing);
  }

  get downloadMedia() {
    return this.whatsapp.downloadMedia?.bind(this.whatsapp);
  }
}
