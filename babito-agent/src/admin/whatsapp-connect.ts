import { html, raw } from "hono/html";

/**
 * Connect a number that is already on the WhatsApp Business app ("coexistence"): Meta's Embedded
 * Signup runs in the browser, the business scans a QR code in the app, and we get back a one-time
 * code plus the WhatsApp Business Account (WABA) and phone number ids. The server exchanges the code
 * for a business token, uses it once to subscribe our app to the WABA's webhooks, and discards it:
 * the bot keeps sending with its own system-user token once the WABA is assigned to that user.
 */

export interface ConnectConfig {
  appId: string;
  appSecret: string;
  embeddedSignupConfigId: string;
  graphVersion: string;
}

export interface ConnectedNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
  status?: string;
}

export interface ConnectResult {
  wabaId: string;
  subscribed: boolean;
  numbers: ConnectedNumber[];
}

export class ConnectError extends Error {}

const PHONE_FIELDS = "id,display_phone_number,verified_name,platform_type,is_on_biz_app,status";

/** Meta's error message only: never the request URL (it carries the app secret and the code). */
async function graph(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ConnectError("could not reach Meta, try again");
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) throw new ConnectError(String(json?.error?.message ?? `Meta answered ${res.status}`).slice(0, 300));
  return json;
}

async function exchangeCode(cfg: ConnectConfig, code: string, fetchImpl: typeof fetch): Promise<string> {
  const exchange = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code });
  const { access_token: token } = await graph(fetchImpl, `https://graph.facebook.com/${cfg.graphVersion}/oauth/access_token?${exchange}`);
  if (typeof token !== "string" || !token) throw new ConnectError("Meta did not return a business token");
  return token;
}

export async function completeWhatsAppOnboarding(
  cfg: ConnectConfig,
  input: { code: string; wabaId: string; phoneNumberId?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectResult> {
  const g = `https://graph.facebook.com/${cfg.graphVersion}`;
  const token = await exchangeCode(cfg, input.code, fetchImpl);
  const auth = { Authorization: `Bearer ${token}` };

  const sub = await graph(fetchImpl, `${g}/${input.wabaId}/subscribed_apps`, { method: "POST", headers: auth });
  const numbers: ConnectedNumber[] = input.phoneNumberId
    ? [await graph(fetchImpl, `${g}/${input.phoneNumberId}?fields=${PHONE_FIELDS}`, { headers: auth })]
    : ((await graph(fetchImpl, `${g}/${input.wabaId}/phone_numbers?fields=${PHONE_FIELDS}`, { headers: auth })).data ?? []);
  return { wabaId: input.wabaId, subscribed: sub?.success === true, numbers };
}

export interface GrantReport {
  scopes: string[];
  wabas: { id: string; name?: string; numbers: ConnectedNumber[]; error?: string }[];
}

/**
 * Diagnostics when Meta returns a sign-in code but no WhatsApp account: what did the sign-in grant,
 * on which WhatsApp accounts, with which numbers? Nothing is subscribed or changed; the token is
 * used for these reads only and discarded.
 */
export async function inspectGrant(cfg: ConnectConfig, code: string, fetchImpl: typeof fetch = fetch): Promise<GrantReport> {
  const g = `https://graph.facebook.com/${cfg.graphVersion}`;
  const token = await exchangeCode(cfg, code, fetchImpl);
  const debug = new URLSearchParams({ input_token: token, access_token: `${cfg.appId}|${cfg.appSecret}` });
  const info = (await graph(fetchImpl, `${g}/debug_token?${debug}`)).data ?? {};
  const granular: { scope?: string; target_ids?: string[] }[] = Array.isArray(info.granular_scopes) ? info.granular_scopes : [];
  const ids = [...new Set(granular.filter((s) => String(s.scope).startsWith("whatsapp_business")).flatMap((s) => s.target_ids ?? []))].slice(0, 5);
  const auth = { Authorization: `Bearer ${token}` };
  const wabas: GrantReport["wabas"] = [];
  for (const id of ids) {
    try {
      const { name } = await graph(fetchImpl, `${g}/${id}?fields=name`, { headers: auth });
      const numbers: ConnectedNumber[] = (await graph(fetchImpl, `${g}/${id}/phone_numbers?fields=${PHONE_FIELDS}`, { headers: auth })).data ?? [];
      wabas.push({ id, name, numbers });
    } catch (err) {
      wabas.push({ id, numbers: [], error: err instanceof ConnectError ? err.message : "lookup failed" });
    }
  }
  return { scopes: Array.isArray(info.scopes) ? info.scopes : [], wabas };
}

export function parseCode(body: any): string | null {
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  return code && code.length <= 2000 ? code : null;
}

/** Validates the browser's POST body; returns null when it is not a plausible Embedded Signup result. */
export function parseConnectInput(body: any): { code: string; wabaId: string; phoneNumberId: string | null } | null {
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const wabaId = typeof body?.waba_id === "string" ? body.waba_id.trim() : "";
  const phone = typeof body?.phone_number_id === "string" ? body.phone_number_id.trim() : "";
  if (!code || code.length > 2000 || !/^\d{5,25}$/.test(wabaId)) return null;
  if (phone && !/^\d{5,25}$/.test(phone)) return null;
  return { code, wabaId, phoneNumberId: phone || null };
}

/** Page body for /admin/whatsapp-connect (rendered inside the admin layout). */
export function connectPageBody(cfg: { appId: string; embeddedSignupConfigId: string; graphVersion: string }) {
  if (!cfg.appId || !cfg.embeddedSignupConfigId) {
    return html`<h1>Connect a WhatsApp number</h1>
      <p class="bad">Not configured: set <code>META_APP_ID</code> and <code>WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID</code>, then redeploy.</p>`;
  }
  const settings = JSON.stringify({ appId: cfg.appId, configId: cfg.embeddedSignupConfigId, version: cfg.graphVersion }).replace(/</g, "\\u003c");
  return html`<h1>Connect a WhatsApp number</h1>
    <p>Connects a number that is already on the <b>WhatsApp Business app</b>. Staff keep using the app; the bot answers too, and pauses in any chat where staff reply from the app.</p>
    <ol>
      <li>Update the WhatsApp Business app on the phone (version 2.24.17 or newer) and keep the phone at hand.</li>
      <li>Click the button, sign in with Facebook, choose the business portfolio <b>My Babito</b>, and pick <b>connect your existing WhatsApp Business app</b>.</li>
      <li>Enter the number, then scan the QR code shown by Meta with the WhatsApp Business app (it asks to share chat history: optional).</li>
    </ol>
    <p><button id="connect" disabled>Loading Facebook…</button></p>
    <pre id="status" class="muted"></pre>
    <script>
      const S = ${raw(settings)};
      const out = document.getElementById("status");
      const btn = document.getElementById("connect");
      const log = (t) => { out.textContent += t + "\\n"; };
      let session = null;
      window.addEventListener("message", (ev) => {
        if (!/(^|\\.)facebook\\.com$/.test(new URL(ev.origin).hostname)) return;
        let data;
        try { data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch { return; }
        if (!data || data.type !== "WA_EMBEDDED_SIGNUP") return;
        const d = data.data || {};
        if (String(data.event).startsWith("FINISH")) { session = d; log("Meta: finished (" + data.event + ")"); }
        else if (data.event === "CANCEL") log("Meta: cancelled at step " + (d.current_step || "?") + (d.error_message ? " (" + d.error_message + ")" : ""));
        else if (data.event === "ERROR") log("Meta error: " + (d.error_message || "unknown") + (d.error_code ? " [" + d.error_code + "]" : ""));
        else log("Meta event: " + data.event);
      });
      async function finish(code) {
        for (let i = 0; i < 30 && !session; i++) await new Promise((r) => setTimeout(r, 200));
        if (!session || !session.waba_id) {
          log("Meta sent no WhatsApp account, so nothing was connected. Asking Meta what this sign-in granted…");
          const res = await fetch("/admin/whatsapp-connect/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
          const r = await res.json().catch(() => ({ error: "bad response" }));
          if (!res.ok) { log("Check failed: " + (r.error || res.status)); return; }
          log("Granted permissions: " + (r.scopes.join(", ") || "none"));
          if (!r.wabas.length) log("No WhatsApp account was shared with the app in this sign-in.");
          for (const w of r.wabas) {
            log("WhatsApp account " + w.id + " (" + (w.name || "?") + ")" + (w.error ? ": " + w.error : ""));
            for (const n of w.numbers) log("  number " + (n.display_phone_number || "?") + ": id " + n.id + ", platform " + (n.platform_type || "?") + ", on business app: " + n.is_on_biz_app);
          }
          return;
        }
        log("Connecting WhatsApp account " + session.waba_id + " to the bot…");
        const res = await fetch("/admin/whatsapp-connect/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, waba_id: String(session.waba_id), phone_number_id: session.phone_number_id ? String(session.phone_number_id) : "" }),
        });
        const r = await res.json().catch(() => ({ error: "bad response" }));
        if (!res.ok) { log("Failed: " + (r.error || res.status)); return; }
        log("Done. Webhooks subscribed: " + r.subscribed);
        for (const n of r.numbers) log("Number " + (n.display_phone_number || "?") + " (" + (n.verified_name || "") + "): phone number id " + n.id + ", platform " + (n.platform_type || "?") + ", on business app: " + n.is_on_biz_app);
        log("Next: give this WhatsApp account to the bot's system user and set WHATSAPP_PHONE_NUMBER_ID (see docs/DEPLOYMENT.md).");
      }
      window.fbAsyncInit = function () {
        FB.init({ appId: S.appId, autoLogAppEvents: true, xfbml: false, version: S.version });
        btn.disabled = false;
        btn.textContent = "Connect WhatsApp Business app number";
      };
      btn.addEventListener("click", () => {
        session = null;
        FB.login((response) => {
          const code = response && response.authResponse && response.authResponse.code;
          log("Facebook sign-in ended: status " + ((response && response.status) || "?") + ", code " + (code ? "received" : "none"));
          if (code) finish(code);
        }, {
          config_id: S.configId,
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
        });
      });
    </script>
    <script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>`;
}
