/**
 * One-time connection of the support mailbox (Microsoft 365) to the agent.
 *
 *   MS_CLIENT_ID=<app id> npx tsx scripts/connect-outlook.ts [path/to/secrets.env]
 *
 * Device-code sign-in: prints a short code; open https://microsoft.com/devicelogin, enter it and
 * sign in AS THE SUPPORT MAILBOX (e.g. support@mybabito.com), then accept the permissions (read and
 * send mail for this mailbox only). The refresh token is written to the secrets file as
 * MS_REFRESH_TOKEN and never printed. The server rotates it afterwards and keeps it in the DB.
 */
import fs from "node:fs";
import { GRAPH_SCOPES } from "../src/email/graph.js";

const clientId = process.env.MS_CLIENT_ID;
const tenant = process.env.MS_TENANT_ID || "organizations";
const secretsPath = process.argv[2] || "private/secrets.env";
if (!clientId) {
  console.error("Set MS_CLIENT_ID (the app registration's Application (client) ID).");
  process.exit(1);
}

const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
const start = await (await fetch(`${base}/devicecode`, { method: "POST", body: new URLSearchParams({ client_id: clientId, scope: GRAPH_SCOPES }) })).json();
if (!start.device_code) {
  console.error("Microsoft refused the request:", start.error_description ?? start.error);
  process.exit(1);
}
console.log(`\n1) Open ${start.verification_uri}\n2) Enter the code: ${start.user_code}\n3) Sign in as the support mailbox and accept.\n\nWaiting…`);

const deadline = Date.now() + Number(start.expires_in ?? 900) * 1000;
let interval = Number(start.interval ?? 5) * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval));
  const res = await (
    await fetch(`${base}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: start.device_code }),
    })
  ).json();
  if (res.error === "authorization_pending") continue;
  if (res.error === "slow_down") {
    interval += 5000;
    continue;
  }
  if (!res.refresh_token) {
    console.error("Sign-in failed:", res.error_description ?? res.error);
    process.exit(1);
  }
  const me = await (await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { Authorization: `Bearer ${res.access_token}` } })).json();
  let s = fs.existsSync(secretsPath) ? fs.readFileSync(secretsPath, "utf8") : "";
  s = s.replace(/^MS_REFRESH_TOKEN=.*\n?/m, "").replace(/\n*$/, "\n") + `MS_REFRESH_TOKEN=${res.refresh_token}\n`;
  fs.writeFileSync(secretsPath, s, { mode: 0o600 });
  console.log(`\nConnected mailbox: ${me.mail ?? me.userPrincipalName}. Saved MS_REFRESH_TOKEN to ${secretsPath} (not shown).`);
  process.exit(0);
}
console.error("The code expired. Run the script again.");
process.exit(1);
