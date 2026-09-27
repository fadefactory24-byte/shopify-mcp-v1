import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: string, header: string | undefined | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const given = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false; // non-hex would make timingSafeEqual throw

  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

// Lenient schemas: Meta adds fields over time; we only require what we use.
const MessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string(),
    text: z.object({ body: z.string() }).partial().optional(),
    button: z.object({ text: z.string() }).partial().optional(),
    interactive: z
      .object({
        type: z.string().optional(),
        button_reply: z.object({ id: z.string(), title: z.string() }).partial().optional(),
        list_reply: z.object({ id: z.string(), title: z.string() }).partial().optional(),
      })
      .optional(),
    image: z.object({ id: z.string(), mime_type: z.string(), caption: z.string() }).partial().optional(),
    video: z.object({ id: z.string(), mime_type: z.string(), caption: z.string() }).partial().optional(),
    document: z.object({ id: z.string(), mime_type: z.string(), caption: z.string(), filename: z.string() }).partial().optional(),
    audio: z.object({ id: z.string(), mime_type: z.string(), voice: z.boolean() }).partial().optional(),
    sticker: z.object({ id: z.string() }).partial().optional(),
    location: z.object({ latitude: z.number(), longitude: z.number() }).partial().optional(),
    reaction: z.object({ message_id: z.string(), emoji: z.string() }).partial().optional(),
    context: z.object({ id: z.string() }).partial().optional(),
  })
  .passthrough();

const StatusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    recipient_id: z.string().optional(),
    errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const EchoSchema = z
  .object({
    from: z.string().optional(),
    to: z.string(),
    id: z.string(),
    type: z.string().optional(),
    text: z.object({ body: z.string() }).partial().optional(),
  })
  .passthrough();

const ValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z.object({ phone_number_id: z.string().optional(), display_phone_number: z.string().optional() }).partial().optional(),
    contacts: z.array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).optional() }).passthrough()).optional(),
    messages: z.array(z.unknown()).optional(),
    statuses: z.array(z.unknown()).optional(),
    message_echoes: z.array(z.unknown()).optional(),
  })
  .passthrough();

const PayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z
      .object({
        id: z.string().optional(),
        changes: z.array(z.object({ field: z.string().optional(), value: ValueSchema }).passthrough()).default([]),
      })
      .passthrough(),
  ),
});

export interface InboundMessage {
  waMessageId: string;
  from: string;
  profileName: string | null;
  timestamp: Date | null;
  type: string;
  /** Text we can reason about: text body, button title, or media caption. */
  text: string | null;
  media: { kind: string; id?: string; mime?: string } | null;
  phoneNumberId: string | null;
}

export interface StatusUpdate {
  waMessageId: string;
  status: string;
  recipient: string | null;
  error: string | null;
}

/** Message typed by staff in the WhatsApp Business app (coexistence mode). */
export interface EchoMessage {
  waMessageId: string;
  to: string;
  text: string | null;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  echoes: EchoMessage[];
  /** Items we could not parse; logged, never thrown. */
  skipped: number;
}

export class MalformedWebhookError extends Error {}

export function parseWebhook(body: unknown, expectedPhoneNumberId?: string): ParsedWebhook {
  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== "whatsapp_business_account") {
    throw new MalformedWebhookError("not a whatsapp_business_account payload");
  }
  const out: ParsedWebhook = { messages: [], statuses: [], echoes: [], skipped: 0 };

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const v = change.value;
      const phoneNumberId = v.metadata?.phone_number_id ?? null;
      // One Meta app can serve several numbers; ignore events for other numbers.
      if (expectedPhoneNumberId && phoneNumberId && phoneNumberId !== expectedPhoneNumberId) {
        out.skipped++;
        continue;
      }
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);

      for (const raw of v.messages ?? []) {
        const m = MessageSchema.safeParse(raw);
        if (!m.success) {
          out.skipped++;
          continue;
        }
        out.messages.push(toInbound(m.data, names.get(m.data.from) ?? null, phoneNumberId));
      }
      for (const raw of v.statuses ?? []) {
        const s = StatusSchema.safeParse(raw);
        if (!s.success) {
          out.skipped++;
          continue;
        }
        const err = s.data.errors?.[0];
        out.statuses.push({
          waMessageId: s.data.id,
          status: s.data.status,
          recipient: s.data.recipient_id ?? null,
          error: err ? `${err.code ?? ""} ${err.title ?? ""}`.trim() : null,
        });
      }
      for (const raw of v.message_echoes ?? []) {
        const e = EchoSchema.safeParse(raw);
        if (!e.success) {
          out.skipped++;
          continue;
        }
        out.echoes.push({ waMessageId: e.data.id, to: e.data.to, text: e.data.text?.body ?? null });
      }
    }
  }
  return out;
}

function toInbound(m: z.infer<typeof MessageSchema>, profileName: string | null, phoneNumberId: string | null): InboundMessage {
  let text: string | null = null;
  let media: InboundMessage["media"] = null;
  switch (m.type) {
    case "text":
      text = m.text?.body ?? null;
      break;
    case "button":
      text = m.button?.text ?? null;
      break;
    case "interactive":
      text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
      break;
    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker": {
      const obj = (m as Record<string, unknown>)[m.type] as { id?: string; mime_type?: string; caption?: string } | undefined;
      media = { kind: m.type, id: obj?.id, mime: obj?.mime_type };
      text = obj?.caption ?? null;
      break;
    }
    case "reaction":
      text = null;
      break;
    default:
      break;
  }
  const ts = m.timestamp ? new Date(Number(m.timestamp) * 1000) : null;
  return {
    waMessageId: m.id,
    from: m.from,
    profileName,
    timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
    type: m.type,
    text: text?.trim() ? text : null,
    media,
    phoneNumberId,
  };
}
