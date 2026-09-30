import { z } from "zod";
import type { EchoMessage, InboundMessage } from "../whatsapp/webhook.js";

/**
 * Facebook Page (Messenger) and Instagram DM webhooks. Both use the same `entry[].messaging[]`
 * shape (object: "page" | "instagram"), so one parser covers both; output re-uses the WhatsApp
 * pipeline's InboundMessage/EchoMessage shapes so the rest of the pipeline (ingest, schedule,
 * handleBatch, is_blocked, handoff) is untouched. Customers are keyed by 'psid:<id>' or
 * 'igsid:<id>' (see email's 'email:<address>' for the same pattern).
 */

export const PSID_PREFIX = "psid:";
export const IGSID_PREFIX = "igsid:";

export function socialHandle(platform: "messenger" | "instagram", id: string): string {
  return (platform === "messenger" ? PSID_PREFIX : IGSID_PREFIX) + id;
}
export function isSocialHandle(handle: string): boolean {
  return handle.startsWith(PSID_PREFIX) || handle.startsWith(IGSID_PREFIX);
}
export function socialPlatformOf(handle: string): "messenger" | "instagram" | null {
  if (handle.startsWith(PSID_PREFIX)) return "messenger";
  if (handle.startsWith(IGSID_PREFIX)) return "instagram";
  return null;
}
export function socialIdOf(handle: string): string | null {
  if (handle.startsWith(PSID_PREFIX)) return handle.slice(PSID_PREFIX.length);
  if (handle.startsWith(IGSID_PREFIX)) return handle.slice(IGSID_PREFIX.length);
  return null;
}

const AttachmentSchema = z.object({ type: z.string(), payload: z.object({ url: z.string().optional() }).partial().optional() }).passthrough();

const MessagingEntrySchema = z
  .object({
    sender: z.object({ id: z.string() }),
    recipient: z.object({ id: z.string() }),
    timestamp: z.number(),
    message: z
      .object({
        mid: z.string(),
        text: z.string().optional(),
        attachments: z.array(AttachmentSchema).optional(),
        is_echo: z.boolean().optional(),
        is_deleted: z.boolean().optional(),
        is_unsupported: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const PayloadSchema = z.object({
  object: z.enum(["page", "instagram"]),
  entry: z.array(
    z
      .object({
        id: z.string().optional(),
        messaging: z.array(z.unknown()).optional(),
        standby: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  ),
});

export class MalformedSocialWebhookError extends Error {}

export interface ParsedSocialWebhook {
  messages: InboundMessage[];
  echoes: EchoMessage[];
  /** Skipped: unparseable, or older than the staleness cutoff (deleted/typing/read events too). */
  skipped: number;
}

const ATTACHMENT_TYPE_TO_INTERNAL: Record<string, string> = { image: "image", video: "video", audio: "audio", file: "document", share: "document", story_mention: "document", reel: "video", ig_reel: "video" };

export function parseSocialWebhook(body: unknown, opts: { expectedPageId?: string; expectedIgId?: string; maxAgeMs?: number; now?: () => number } = {}): ParsedSocialWebhook {
  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) throw new MalformedSocialWebhookError("not a page/instagram messaging payload");
  const platform: "messenger" | "instagram" = parsed.data.object === "instagram" ? "instagram" : "messenger";
  const expectedId = platform === "instagram" ? opts.expectedIgId : opts.expectedPageId;
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 3600_000;
  const now = (opts.now ?? Date.now)();

  const out: ParsedSocialWebhook = { messages: [], echoes: [], skipped: 0 };
  for (const entry of parsed.data.entry) {
    if (expectedId && entry.id && entry.id !== expectedId) {
      out.skipped += (entry.messaging?.length ?? 0) + (entry.standby?.length ?? 0);
      continue; // a shared app subscribed to several pages/IG accounts; not ours
    }
    for (const raw of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      const e = MessagingEntrySchema.safeParse(raw);
      if (!e.success || !e.data.message) {
        out.skipped++;
        continue;
      }
      const m = e.data.message;
      if (m.is_deleted) {
        out.skipped++;
        continue;
      }
      // Too old to be worth answering (backlog from before the channel was connected, or a
      // retried delivery after downtime): never auto-reply, and don't even store it.
      if (now - e.data.timestamp > maxAgeMs) {
        out.skipped++;
        continue;
      }
      if (m.is_echo) {
        // Our own reply, or one staff sent directly from the Page/Instagram inbox.
        out.echoes.push({ waMessageId: m.mid, to: socialHandle(platform, e.data.recipient.id), text: m.text ?? null });
        continue;
      }
      const handle = socialHandle(platform, e.data.sender.id);
      const attachment = m.attachments?.[0];
      const type = m.is_unsupported ? "unsupported" : attachment ? (ATTACHMENT_TYPE_TO_INTERNAL[attachment.type] ?? "document") : "text";
      out.messages.push({
        waMessageId: m.mid,
        from: handle,
        profileName: null, // Page/IG webhooks don't include the sender's name; the customer's display name stays whatever we already have (or unset).
        timestamp: new Date(e.data.timestamp),
        type,
        text: m.text ?? null,
        media: attachment?.payload?.url ? { kind: attachment.type, url: attachment.payload.url } : null,
        phoneNumberId: null,
      });
    }
  }
  return out;
}
