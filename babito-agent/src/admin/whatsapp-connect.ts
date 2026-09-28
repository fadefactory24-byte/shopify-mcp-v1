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

export async function completeWhatsAppOnboarding(
  cfg: ConnectConfig,
  input: { code: string; wabaId: string; phoneNumberId?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectResult> {
  const g = `https://graph.facebook.com/${cfg.graphVersion}`;
  const exchange = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code: input.code });
  const { access_token: token } = await graph(fetchImpl, `${g}/oauth/access_token?${exchange}`);
  if (typeof token !== "string" || !token) throw new ConnectError("Meta did not return a business token");
  const auth = { Authorization: `Bearer ${token}` };

  const sub = await graph(fetchImpl, `${g}/${input.wabaId}/subscribed_apps`, { method: "POST", headers: auth });
  const numbers: ConnectedNumber[] = input.phoneNumberId
    ? [await graph(fetchImpl, `${g}/${input.phoneNumberId}?fields=${PHONE_FIELDS}`, { headers: auth })]
    : ((await graph(fetchImpl, `${g}/${input.wabaId}/phone_numbers?fields=${PHONE_FIELDS}`, { headers: auth })).data ?? []);
  return { wabaId: input.wabaId, subscribed: sub?.success === true, numbers };
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
        if (String(data.event).startsWith("FINISH")) { session = data.data || {}; log("Meta: finished (" + data.event + ")"); }
        else if (data.event === "CANCEL") log("Meta: cancelled at step " + ((data.data || {}).current_step || "?"));
        else if (data.event === "ERROR") log("Meta error: " + ((data.data || {}).error_message || "unknown"));
      });
      async function finish(code) {
        for (let i = 0; i < 30 && !session; i++) await new Promise((r) => setTimeout(r, 200));
        if (!session || !session.waba_id) { log("No WhatsApp account id came back from Meta. Nothing was connected."); return; }
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
          if (code) finish(code); else log("Sign-in was not completed.");
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
