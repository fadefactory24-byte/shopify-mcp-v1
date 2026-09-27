import { RetryableError, withRetry } from "../util/retry.js";

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<{ waMessageId: string }>;
  markRead(waMessageId: string, typing: boolean): Promise<void>;
}

export class WhatsAppApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = "WhatsAppApiError";
  }
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

  private async post(payload: unknown): Promise<any> {
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
      { retries: 2, baseDelayMs: 500 },
    );
  }

  async sendText(to: string, body: string) {
    const json = await this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: true, body },
    });
    const id = json?.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError("WhatsApp API returned no message id", 200);
    return { waMessageId: id as string };
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
