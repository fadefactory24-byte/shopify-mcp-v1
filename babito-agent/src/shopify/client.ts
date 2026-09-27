import { RetryableError, withRetry } from "../util/retry.js";

export class ShopifyError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "auth" | "query") {
    super(message);
    this.name = "ShopifyError";
  }
}

/**
 * Shopify Admin GraphQL client.
 *
 * Auth modes:
 *  - static token (SHOPIFY_ADMIN_ACCESS_TOKEN, legacy custom apps), or
 *  - client-credentials grant (Dev Dashboard apps installed on your own store):
 *    token is fetched and refreshed automatically before expiry, and once on 401.
 */
export class ShopifyGraphQLClient {
  private token = "";
  private expiresAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      storeDomain: string;
      apiVersion: string;
      staticToken?: string;
      clientId?: string;
      clientSecret?: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    if (opts.staticToken) {
      this.token = opts.staticToken;
      this.expiresAt = Number.POSITIVE_INFINITY;
    }
  }

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }

  private async ensureToken(force = false) {
    if (this.opts.staticToken) return;
    if (!force && this.token && Date.now() < this.expiresAt - 5 * 60_000) return;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const res = await this.fetch(`https://${this.opts.storeDomain}/admin/oauth/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.opts.clientId ?? "",
            client_secret: this.opts.clientSecret ?? "",
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new ShopifyError(`Shopify token request failed (${res.status})`, res.status >= 500 ? "unavailable" : "auth");
        const json = (await res.json()) as { access_token: string; expires_in?: number };
        this.token = json.access_token;
        this.expiresAt = Date.now() + (json.expires_in ?? 86_399) * 1000;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let reauthed = false;
    return withRetry(
      async () => {
        await this.ensureToken();
        let res: Response;
        try {
          res = await this.fetch(`https://${this.opts.storeDomain}/admin/api/${this.opts.apiVersion}/graphql.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.token },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
          });
        } catch (err) {
          throw new RetryableError(`Shopify network error: ${(err as Error).message}`);
        }
        if (res.status === 401 && !this.opts.staticToken && !reauthed) {
          reauthed = true;
          await this.ensureToken(true);
          throw new RetryableError("Shopify 401, token refreshed");
        }
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get("retry-after"));
          throw new RetryableError(`Shopify ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        }
        if (res.status === 401 || res.status === 403) throw new ShopifyError(`Shopify auth error ${res.status}`, "auth");
        if (!res.ok) throw new ShopifyError(`Shopify HTTP ${res.status}`, "query");
        const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
        if (json.errors?.length) {
          if (json.errors.some((e) => e.extensions?.code === "THROTTLED")) throw new RetryableError("Shopify throttled", 1000);
          throw new ShopifyError(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ").slice(0, 300)}`, "query");
        }
        if (!json.data) throw new ShopifyError("Shopify returned no data", "query");
        return json.data;
      },
      { retries: 2, baseDelayMs: 500 },
    ).catch((err) => {
      if (err instanceof ShopifyError) throw err;
      throw new ShopifyError((err as Error).message, "unavailable");
    });
  }
}
