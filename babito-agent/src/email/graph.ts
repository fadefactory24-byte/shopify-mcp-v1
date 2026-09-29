/**
 * Microsoft Graph client for ONE mailbox (support@), delegated access: the mailbox user signed in
 * once (device code, scripts/connect-outlook) and granted Mail.ReadWrite + Mail.Send for their own
 * mailbox only. Refresh tokens rotate on every use; the newest one is persisted through TokenStore.
 * Message ids are requested as immutable ids so a draft keeps its id after it moves to Sent Items.
 */

export const GRAPH_SCOPES = "offline_access User.Read Mail.ReadWrite Mail.Send";

export interface TokenStore {
  load(): Promise<string | null>;
  save(refreshToken: string): Promise<void>;
}

export interface InboxMessage {
  id: string;
  conversationId: string | null;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string;
  /** New text only (quoted history removed by Graph's uniqueBody), plain text. */
  text: string;
  hasAttachments: boolean;
  headers: Record<string, string>;
}

export interface SentMessage {
  id: string;
  toAddresses: string[];
  text: string;
  sentAt: string;
}

export interface MailApi {
  listInbox(since: Date): Promise<InboxMessage[]>;
  listSent(since: Date): Promise<SentMessage[]>;
  /** Reply in the thread of `messageId`; returns the sent message's (immutable) id. */
  reply(messageId: string, text: string): Promise<string>;
  /** New email (no thread to reply to). */
  sendMail(to: string[], subject: string, text: string): Promise<void>;
  /** Flag the message and tag it for staff. */
  flagForStaff(messageId: string, category: string): Promise<void>;
}

export class GraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class GraphMailClient implements MailApi {
  private access: { token: string; until: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly opts: {
      clientId: string;
      tenant: string;
      seedRefreshToken: string;
      store: TokenStore;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private get f() {
    return this.opts.fetchImpl ?? fetch;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > this.now() + 60_000) return this.access.token;
    // One refresh at a time: the old refresh token stops working once rotated.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const refreshToken = (await this.opts.store.load()) || this.opts.seedRefreshToken;
    if (!refreshToken) throw new GraphError("Outlook is not connected (no refresh token)", 401);
    const res = await this.f(`https://login.microsoftonline.com/${this.opts.tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.opts.clientId, grant_type: "refresh_token", refresh_token: refreshToken, scope: GRAPH_SCOPES }),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new GraphError(`Microsoft sign-in failed: ${String(json.error_description ?? json.error ?? res.status).slice(0, 200)}`, res.status || 401);
    }
    if (json.refresh_token) await this.opts.store.save(json.refresh_token);
    this.access = { token: json.access_token, until: this.now() + Number(json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  private async call(path: string, init: RequestInit & { prefer?: string[] } = {}): Promise<any> {
    const token = await this.accessToken();
    const prefer = ['IdType="ImmutableId"', ...(init.prefer ?? [])].join(", ");
    const res = await this.f(`https://graph.microsoft.com/v1.0${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: prefer, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 202 || res.status === 204) return null;
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GraphError(`Graph ${res.status}: ${String(json?.error?.message ?? "").slice(0, 200)}`, res.status);
    return json;
  }

  async listInbox(since: Date): Promise<InboxMessage[]> {
    const q = new URLSearchParams({
      $filter: `receivedDateTime ge ${since.toISOString()}`,
      $orderby: "receivedDateTime asc",
      $top: "25",
      $select: "id,conversationId,subject,from,receivedDateTime,uniqueBody,hasAttachments,internetMessageHeaders",
    });
    const json = await this.call(`/me/mailFolders/inbox/messages?${q}`, { prefer: ['outlook.body-content-type="text"'] });
    return (json?.value ?? []).map((m: any) => ({
      id: m.id,
      conversationId: m.conversationId ?? null,
      subject: m.subject ?? "",
      fromAddress: String(m.from?.emailAddress?.address ?? "").toLowerCase(),
      fromName: m.from?.emailAddress?.name ?? null,
      receivedAt: m.receivedDateTime,
      text: String(m.uniqueBody?.content ?? "").trim(),
      hasAttachments: Boolean(m.hasAttachments),
      headers: Object.fromEntries((m.internetMessageHeaders ?? []).map((h: any) => [String(h.name).toLowerCase(), String(h.value ?? "")])),
    }));
  }

  async listSent(since: Date): Promise<SentMessage[]> {
    const q = new URLSearchParams({
      $filter: `sentDateTime ge ${since.toISOString()}`,
      $orderby: "sentDateTime asc",
      $top: "25",
      $select: "id,toRecipients,sentDateTime,uniqueBody",
    });
    const json = await this.call(`/me/mailFolders/sentitems/messages?${q}`, { prefer: ['outlook.body-content-type="text"'] });
    return (json?.value ?? []).map((m: any) => ({
      id: m.id,
      toAddresses: (m.toRecipients ?? []).map((r: any) => String(r.emailAddress?.address ?? "").toLowerCase()).filter(Boolean),
      text: String(m.uniqueBody?.content ?? "").trim(),
      sentAt: m.sentDateTime,
    }));
  }

  async reply(messageId: string, text: string): Promise<string> {
    const draft = await this.call(`/me/messages/${encodeURIComponent(messageId)}/createReply`, {
      method: "POST",
      body: JSON.stringify({ message: { body: { contentType: "Text", content: text } } }),
    });
    if (!draft?.id) throw new GraphError("Graph did not return the reply draft", 502);
    await this.call(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
    return draft.id as string;
  }

  async sendMail(to: string[], subject: string, text: string): Promise<void> {
    await this.call(`/me/sendMail`, {
      method: "POST",
      body: JSON.stringify({
        message: { subject, body: { contentType: "Text", content: text }, toRecipients: to.map((address) => ({ emailAddress: { address } })) },
        saveToSentItems: false,
      }),
    });
  }

  async flagForStaff(messageId: string, category: string): Promise<void> {
    await this.call(`/me/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ flag: { flagStatus: "flagged" }, categories: [category] }),
    });
  }
}

/** Refresh token persisted in integration_state (rotates on every refresh). */
export function dbTokenStore(db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, key = "microsoft_refresh_token"): TokenStore {
  return {
    async load() {
      const { rows } = await db.query(`select value from integration_state where key = $1`, [key]);
      return (rows[0]?.value?.token as string | undefined) ?? null;
    },
    async save(token: string) {
      await db.query(
        `insert into integration_state (key, value) values ($1, $2::jsonb)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify({ token })],
      );
    },
  };
}
