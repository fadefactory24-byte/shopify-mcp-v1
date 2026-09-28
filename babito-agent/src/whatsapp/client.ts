import { RetryableError, withRetry } from "../util/retry.js";

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<{ waMessageId: string }>;
  markRead(waMessageId: string, typing: boolean): Promise<void>;
  /** Fetch an inbound media file (photo, video, document) so staff can view it in the dashboard. */
  downloadMedia?(mediaId: string): Promise<{ contentType: string; data: ArrayBuffer }>;
}

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export class WhatsAppApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

/**
 * Send errors that fail the same way on every resend: 131047 outside the 24h window (needs a
 * template), 131026 undeliverable, 131051 unsupported type, 131021 recipient is the sender,
 * 131049 not delivered by Meta, 100/131008/131009 invalid request.
 */
const PERMANENT_ERROR_CODES = new Set([100, 131008, 131009, 131021, 131026, 131047, 131049, 131051]);

export function isPermanentSendError(err: unknown): boolean {
  return err instanceof WhatsAppApiError && err.code !== undefined && PERMANENT_ERROR_CODES.has(err.code);
}

/**
 * WhatsApp Cloud API client. Retries 429/5xx/network errors with backoff.
 * Does NOT retry 4xx business errors (e.g. 131047: outside the 24h window) —
 * those need a template message or human action, retrying just burns quota.
 */
export class WhatsAppCloudClient implements WhatsAppSender {
  constructor(
    private readonly opts: { accessToken: string; phoneNumberId: string; graphVersion: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {}

  private get url() {
    return `https://graph.facebook.com/${this.opts.graphVersion}/${this.opts.phoneNumberId}/messages`;
  }

  private async post(payload: unknown, opts: { retryNetworkErrors?: boolean } = {}): Promise<any> {
    const f = this.opts.fetchImpl ?? fetch;
    return withRetry(
      async () => {
        const res = await f(this.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        const text = await res.text();
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* non-JSON error body */
        }
        if (res.ok) return json;
        const code = json?.error?.code as number | undefined;
        const msg = `WhatsApp API ${res.status}${code ? ` (code ${code})` : ""}: ${json?.error?.message ?? text.slice(0, 200)}`;
        if (res.status === 429 || res.status >= 500 || code === 130429 || code === 131016) {
          const ra = Number(res.headers.get("retry-after"));
          throw new RetryableError(msg, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        }
        throw new WhatsAppApiError(msg, res.status, code);
      },
      { retries: 2, baseDelayMs: 500, retryNetworkErrors: opts.retryNetworkErrors },
    );
  }

  async sendText(to: string, body: string) {
    const json = await this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: true, body },
    }, { retryNetworkErrors: false }); // a timed-out send may already be delivered; retrying would duplicate it
    const id = json?.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError("WhatsApp API returned no message id", 200);
    return { waMessageId: id as string };
  }

  /** Media id -> short-lived URL (Graph API) -> bytes. Both requests need the access token. */
  async downloadMedia(mediaId: string) {
    const f = this.opts.fetchImpl ?? fetch;
    const auth = { Authorization: `Bearer ${this.opts.accessToken}` };
    const metaRes = await f(`https://graph.facebook.com/${this.opts.graphVersion}/${encodeURIComponent(mediaId)}`, {
      headers: auth,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!metaRes.ok) throw new WhatsAppApiError(`WhatsApp media lookup ${metaRes.status}`, metaRes.status);
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!meta.url) throw new WhatsAppApiError("WhatsApp media lookup returned no url", 200);
    if ((meta.file_size ?? 0) > MAX_MEDIA_BYTES) throw new WhatsAppApiError("media file too large", 413);
    const fileRes = await f(meta.url, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) throw new WhatsAppApiError(`WhatsApp media download ${fileRes.status}`, fileRes.status);
    const data = await fileRes.arrayBuffer();
    if (data.byteLength > MAX_MEDIA_BYTES) throw new WhatsAppApiError("media file too large", 413);
    return { contentType: meta.mime_type ?? fileRes.headers.get("content-type") ?? "application/octet-stream", data };
  }

  async markRead(waMessageId: string, typing: boolean) {
    await this.post({
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
      ...(typing ? { typing_indicator: { type: "text" } } : {}),
    });
  }
}
