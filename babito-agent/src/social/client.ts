import type { WhatsAppSender } from "../whatsapp/client.js";
import { socialIdOf, socialPlatformOf } from "./webhook.js";

export class SocialApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Sends Messenger and Instagram DM replies. Both use the same Send API shape
 * (POST .../messages with {recipient:{id}, message:{text}}); Messenger targets the app's own
 * page ("me"), Instagram targets the Instagram professional account id. Same Page access token
 * works for both once the IG account is linked to the page (that's how it's connected here).
 */
export class SocialSender implements WhatsAppSender {
  constructor(
    private readonly opts: { pageAccessToken: string; pageId: string; instagramId: string; graphVersion: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {}

  private get f() {
    return this.opts.fetchImpl ?? fetch;
  }

  async sendText(to: string, body: string): Promise<{ waMessageId: string }> {
    const platform = socialPlatformOf(to);
    const id = socialIdOf(to);
    if (!platform || !id) throw new SocialApiError(`not a social handle: ${to}`, 400);
    const target = platform === "instagram" ? this.opts.instagramId : "me";
    const res = await this.f(`https://graph.facebook.com/${this.opts.graphVersion}/${target}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.pageAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id }, message: { text: body }, messaging_type: "RESPONSE" }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.message_id) throw new SocialApiError(`${platform} send ${res.status}: ${String(json?.error?.message ?? "").slice(0, 200)}`, res.status);
    return { waMessageId: json.message_id as string };
  }

  /** No read receipts / typing indicator on the Send API this app uses; a harmless no-op. */
  async markRead(): Promise<void> {}
}
