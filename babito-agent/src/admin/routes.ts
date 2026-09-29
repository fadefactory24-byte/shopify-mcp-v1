import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { html } from "hono/html";
import type { AppDeps } from "../app.js";
import { repo } from "../db/repo.js";
import { displayHandle } from "../email/channel.js";
import { ConnectError, completeWhatsAppOnboarding, connectPageBody, inspectGrant, parseCode, parseConnectInput } from "./whatsapp-connect.js";

/**
 * Minimal staff dashboard (server-rendered, no build step):
 * conversations, AI/human mode, messages, tool calls, errors, handoffs, basic stats,
 * and actions: reply as staff, take over, release to AI, close, forget customer.
 * Protected by HTTP Basic auth (user "admin", ADMIN_PASSWORD) + same-origin check on POST.
 */
const INLINE_MEDIA = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/3gpp", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "application/pdf"]);

export function adminRoutes(deps: AppDeps) {
  const r = new Hono();
  const { db } = deps;

  r.use("*", basicAuth({ username: "admin", password: deps.config.adminPassword }));
  r.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin") ?? c.req.header("referer") ?? "";
      const host = c.req.header("host") ?? "";
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        /* invalid header */
      }
      if (!host || originHost !== host) return c.text("cross-origin request blocked", 403);
    }
    await next();
  });

  const page = (title: string, body: unknown) => html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · BABITO Agent</title>
        <style>
          :root { --bg:#fafaf7; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e1da; --ai:#2d6cdf; --human:#c2410c; --bad:#b91c1c; --ok:#15803d; }
          @media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --muted:#9a9993; --line:#2c2b28; } }
          body { font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0 auto; padding: 16px; max-width: 1100px; }
          a { color: inherit; }
          table { width: 100%; border-collapse: collapse; }
          td, th { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: start; vertical-align: top; }
          .muted { color: var(--muted); } .bad { color: var(--bad); } .ok { color: var(--ok); }
          .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; border:1px solid currentColor; }
          .ai { color: var(--ai); } .human { color: var(--human); }
          .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:8px; margin: 12px 0; }
          .stat { border:1px solid var(--line); border-radius:8px; padding:10px; } .stat b { font-size: 22px; display:block; }
          .msg { margin: 6px 0; padding: 8px 10px; border-radius: 10px; max-width: 75%; white-space: pre-wrap; unicode-bidi: plaintext; }
          .in { background: #8881; } .out { background: #2d6cdf1f; margin-inline-start: auto; } .staff { background: #c2410c22; margin-inline-start: auto; }
          form.inline { display:inline; } textarea { width:100%; min-height:70px; }
          details { margin: 4px 0; } pre { white-space: pre-wrap; font-size: 12px; }
        </style>
      </head>
      <body>
        <p><a href="/admin">← Dashboard</a></p>
        ${body}
      </body>
    </html>`;

  r.get("/", async (c) => {
    const mode = c.req.query("mode");
    const stats = (
      await db.query<Record<string, string>>(`
        select
          (select count(*) from messages where direction='inbound' and created_at > now() - interval '24 hours')::text as inbound_24h,
          (select count(*) from agent_runs where created_at > now() - interval '24 hours')::text as runs_24h,
          (select count(*) from agent_runs where status='failed' and created_at > now() - interval '24 hours')::text as failed_24h,
          (select count(*) from handoffs where status in ('open','claimed'))::text as open_handoffs,
          (select count(*) from conversations where status='open' and mode='human')::text as human_mode,
          (select coalesce(sum(input_tokens),0) from agent_runs where created_at > now() - interval '24 hours')::text as in_tok,
          (select coalesce(sum(output_tokens),0) from agent_runs where created_at > now() - interval '24 hours')::text as out_tok,
          (select coalesce(round(avg(latency_ms)),0) from agent_runs where created_at > now() - interval '24 hours')::text as avg_latency,
          (select count(*) from tool_calls where not success and created_at > now() - interval '24 hours')::text as tool_fail_24h,
          (select count(*) from messages where direction='outbound' and status='failed' and created_at > now() - interval '24 hours')::text as send_fail_24h
      `)
    ).rows[0]!;
    const handoffs = (
      await db.query<any>(`
        select h.*, cu.display_name, cu.wa_id from handoffs h join customers cu on cu.id = h.customer_id
        where h.status in ('open','claimed') order by h.priority desc, h.created_at limit 50`)
    ).rows;
    const convs = (
      await db.query<any>(
        `select c.id, c.mode, c.channel, c.language, c.last_message_at, cu.display_name, cu.wa_id,
           (select body from messages m where m.conversation_id = c.id and m.body is not null order by created_at desc limit 1) as last_body
         from conversations c join customers cu on cu.id = c.customer_id
         where c.status = 'open' and ($1::text is null or c.mode = $1)
         order by c.last_message_at desc limit 100`,
        [mode ?? null],
      )
    ).rows;

    const stat = (label: string, v: string, cls = "") => html`<div class="stat"><span class="muted">${label}</span><b class="${cls}">${v}</b></div>`;
    return c.html(
      page(
        "Dashboard",
        html`<h1>BABITO WhatsApp Agent</h1>
          <p class="muted"><a href="/admin/whatsapp-connect">Connect a WhatsApp number</a></p>
          <div class="stats">
            ${stat("Inbound msgs (24h)", stats.inbound_24h!)} ${stat("AI runs (24h)", stats.runs_24h!)}
            ${stat("Failed runs (24h)", stats.failed_24h!, Number(stats.failed_24h) ? "bad" : "")}
            ${stat("Tool failures (24h)", stats.tool_fail_24h!, Number(stats.tool_fail_24h) ? "bad" : "")}
            ${stat("Send failures (24h)", stats.send_fail_24h!, Number(stats.send_fail_24h) ? "bad" : "")}
            ${stat("Open handoffs", stats.open_handoffs!, Number(stats.open_handoffs) ? "human" : "")}
            ${stat("Human-mode chats", stats.human_mode!)} ${stat("Avg AI latency ms", stats.avg_latency!)}
            ${stat("Tokens in/out (24h)", `${stats.in_tok}/${stats.out_tok}`)}
          </div>
          <h2>Open handoffs</h2>
          <table>
            <tr><th>Customer</th><th>Reason</th><th>Summary</th><th>Since</th></tr>
            ${handoffs.map(
              (h) => html`<tr>
                <td><a href="/admin/conversations/${h.conversation_id}">${h.display_name ?? ""} ${displayHandle(h.wa_id)}</a></td>
                <td><span class="pill ${h.priority === "high" ? "bad" : ""}">${h.reason}</span> ${h.order_name ?? ""}</td>
                <td>${h.summary ?? ""}</td><td class="muted">${new Date(h.created_at).toLocaleString("he-IL")}</td>
              </tr>`,
            )}
          </table>
          <h2>Conversations <small class="muted"><a href="/admin">all</a> · <a href="/admin?mode=human">human</a> · <a href="/admin?mode=ai">ai</a></small></h2>
          <table>
            <tr><th>Customer</th><th>Mode</th><th>Last message</th><th>At</th></tr>
            ${convs.map(
              (cv) => html`<tr>
                <td><a href="/admin/conversations/${cv.id}">${cv.display_name ?? "—"}</a><br /><span class="muted">${displayHandle(cv.wa_id)}</span></td>
                <td><span class="pill ${cv.mode}">${cv.mode}</span> <span class="muted">${cv.channel === "email" ? "email" : "WhatsApp"} ${cv.language ?? ""}</span></td>
                <td style="unicode-bidi:plaintext">${(cv.last_body ?? "").slice(0, 120)}</td>
                <td class="muted">${new Date(cv.last_message_at).toLocaleString("he-IL")}</td>
              </tr>`,
            )}
          </table>`,
      ),
    );
  });

  r.get("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.notFound();
    const conv = await repo.getConversation(db, id);
    if (!conv) return c.notFound();
    const customer = (await repo.getCustomer(db, conv.customer_id))!;
    const msgs = (await db.query<any>(`select * from messages where conversation_id = $1 order by created_at desc limit 200`, [id])).rows.reverse();
    const runs = (
      await db.query<any>(
        `select r.*, coalesce(json_agg(json_build_object('tool', t.tool_name, 'ok', t.success, 'error', t.error, 'ms', t.latency_ms, 'input', t.input, 'output', t.output) order by t.created_at) filter (where t.id is not null), '[]') as tools
         from agent_runs r left join tool_calls t on t.agent_run_id = r.id
         where r.conversation_id = $1 group by r.id order by r.created_at desc limit 30`,
        [id],
      )
    ).rows;
    const memories = await repo.getMemories(db, customer.id);
    const handoffs = (await db.query<any>(`select * from handoffs where conversation_id = $1 order by created_at desc limit 10`, [id])).rows;

    return c.html(
      page(
        customer.display_name ?? "Conversation",
        html`<h1>${customer.display_name ?? "—"} <span class="muted">${displayHandle(customer.wa_id)}</span></h1>
          <p>
            Mode: <span class="pill ${conv.mode}">${conv.mode}</span> · Language: ${conv.language ?? "?"} · Memories:
            ${memories.map((m) => `${m.key}=${m.value}`).join("; ") || "none"}
          </p>
          <p>
            <form class="inline" method="post" action="/admin/conversations/${id}/takeover"><button>Take over (stop AI)</button></form>
            <form class="inline" method="post" action="/admin/conversations/${id}/release"><button>Release to AI</button></form>
            <form class="inline" method="post" action="/admin/conversations/${id}/close"><button>Close conversation</button></form>
            <form class="inline" method="post" action="/admin/customers/${customer.id}/forget" onsubmit="return confirm('Delete memories and message texts for this customer?')"><button>Forget customer</button></form>
          </p>
          ${conv.summary ? html`<p class="muted">Summary: ${conv.summary}</p>` : ""}
          ${handoffs.length ? html`<p>Handoffs: ${handoffs.map((h) => html`<span class="pill">${h.status}: ${h.reason}</span> `)}</p>` : ""}
          <h2>Messages</h2>
          ${msgs.map(
            (m) => html`<div class="msg ${m.direction === "inbound" ? "in" : m.author === "human_agent" ? "staff" : "out"}">
              ${(m.media as { id?: string } | null)?.id ? html`<a href="/admin/media/${m.id}" target="_blank" rel="noopener">[${m.type}: open]</a> ` : ""}${m.body ?? ((m.media as { id?: string } | null)?.id ? "" : `[${m.type}]`)}
              <div class="muted" style="font-size:11px">${m.author} · ${m.status}${m.error ? html` · <span class="bad">${m.error}</span>` : ""} · ${new Date(m.created_at).toLocaleString("he-IL")}</div>
            </div>`,
          )}
          <form method="post" action="/admin/conversations/${id}/reply">
            <textarea name="body" required maxlength="3000" placeholder="Reply as staff (switches the chat to human mode)"></textarea>
            <button>Send as staff</button>
          </form>
          <h2>AI runs</h2>
          ${runs.map(
            (run) => html`<details>
              <summary>
                <span class="${run.status === "failed" ? "bad" : run.status === "handoff" ? "human" : "ok"}">${run.status}</span>
                · ${new Date(run.created_at).toLocaleString("he-IL")} · ${run.latency_ms ?? "?"}ms · ${run.input_tokens}/${run.output_tokens} tok
                (cache ${run.cache_read_tokens}) · ${(run.tools as any[]).map((t) => `${t.tool}${t.ok ? "" : "✗"}`).join(", ")}
                ${run.guardrail_flags?.length ? html`· <span class="bad">${run.guardrail_flags.join(",")}</span>` : ""}
              </summary>
              ${run.error ? html`<p class="bad">${run.error}</p>` : ""}
              <pre>${JSON.stringify(run.tools, null, 2)}</pre>
            </details>`,
          )}`,
      ),
    );
  });

  /**
   * Customer photo/video/document, fetched from WhatsApp on demand (never stored here). Only safe
   * media types are shown inline; anything else downloads as an opaque file.
   */
  r.get("/media/:messageId", async (c) => {
    const { rows } = await db.query<{ media: { id?: string } | null }>(`select media from messages where id = $1`, [c.req.param("messageId")]);
    const mediaId = rows[0]?.media?.id;
    if (!mediaId) return c.text("no media for this message", 404);
    if (!deps.media?.downloadMedia) return c.text("media viewing not available", 501);
    try {
      const { contentType, data } = await deps.media.downloadMedia(mediaId);
      const type = contentType.split(";")[0]!.trim().toLowerCase();
      const inline = INLINE_MEDIA.has(type);
      return c.body(data, 200, {
        "Content-Type": inline ? type : "application/octet-stream",
        "Content-Disposition": inline ? "inline" : "attachment",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      });
    } catch (err) {
      deps.log.warn({ err: String(err) }, "media download failed");
      return c.text("could not load this file from WhatsApp (media expires after 30 days)", 502);
    }
  });

  r.post("/conversations/:id/reply", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const body = String(form.body ?? "").trim().slice(0, 3000);
    const conv = await repo.getConversation(db, id);
    if (!conv || !body) return c.redirect(`/admin/conversations/${id}`);
    const customer = (await repo.getCustomer(db, conv.customer_id))!;
    if (conv.mode !== "human") await repo.setMode(db, id, "human");
    else await repo.touchHumanActivity(db, id);
    await deps.processor.sendReply(conv, customer, body, null, "human_agent");
    await repo.audit(db, "admin", "staff_reply", "conversation", id);
    return c.redirect(`/admin/conversations/${id}`);
  });

  r.post("/conversations/:id/takeover", async (c) => {
    const id = c.req.param("id");
    await repo.setMode(db, id, "human");
    await repo.audit(db, "admin", "takeover", "conversation", id);
    return c.redirect(`/admin/conversations/${id}`);
  });

  r.post("/conversations/:id/release", async (c) => {
    const id = c.req.param("id");
    await repo.setMode(db, id, "ai");
    await repo.resolveActiveHandoffs(db, id, "admin");
    await repo.audit(db, "admin", "release_to_ai", "conversation", id);
    return c.redirect(`/admin/conversations/${id}`);
  });

  r.post("/conversations/:id/close", async (c) => {
    const id = c.req.param("id");
    await db.query(`update conversations set status = 'closed', closed_at = now(), mode = 'ai' where id = $1`, [id]);
    await repo.resolveActiveHandoffs(db, id, "admin");
    await repo.audit(db, "admin", "close", "conversation", id);
    return c.redirect(`/admin`);
  });

  /** Privacy request: delete memories and every stored text about the customer; keep row skeletons for stats. */
  r.post("/customers/:id/forget", async (c) => {
    const id = c.req.param("id");
    await db.tx(async (tx) => {
      const convs = `select id from conversations where customer_id = $1`;
      await repo.deleteMemories(tx, id);
      await tx.query(`update messages set body = null, media = null where customer_id = $1`, [id]);
      // Tool inputs/outputs can hold the order email, handoff summaries and AI replies quote the customer.
      await tx.query(`update tool_calls set input = null, output = null where conversation_id in (${convs})`, [id]);
      await tx.query(`update agent_runs set reply_text = null where conversation_id in (${convs})`, [id]);
      await tx.query(`update handoffs set summary = null where customer_id = $1`, [id]);
      await tx.query(`update conversations set summary = null, context = '{}'::jsonb where customer_id = $1`, [id]);
      await tx.query(`update customers set display_name = null, shopify_customer_id = null, deleted_at = now() where id = $1`, [id]);
      await repo.audit(tx, "admin", "forget_customer", "customer", id);
    });
    return c.redirect(`/admin`);
  });

  /** Embedded Signup for a number that stays on the WhatsApp Business app (coexistence). */
  const connectCfg = {
    appId: deps.config.metaAppId ?? "",
    appSecret: deps.config.appSecret,
    embeddedSignupConfigId: deps.config.embeddedSignupConfigId ?? "",
    graphVersion: deps.config.graphVersion ?? "v25.0",
  };

  r.get("/whatsapp-connect", (c) => c.html(page("Connect WhatsApp number", connectPageBody(connectCfg))));

  r.post("/whatsapp-connect/complete", async (c) => {
    if (!connectCfg.appId || !connectCfg.embeddedSignupConfigId || !connectCfg.appSecret) return c.json({ error: "not configured" }, 501);
    const input = parseConnectInput(await c.req.json().catch(() => null));
    if (!input) return c.json({ error: "invalid input" }, 400);
    try {
      const result = await completeWhatsAppOnboarding(connectCfg, input, deps.fetchImpl ?? fetch);
      deps.log.info({ event: "whatsapp_connected", wabaId: result.wabaId, subscribed: result.subscribed, numbers: result.numbers.map((n) => n.id) }, "WhatsApp number connected");
      await repo.audit(db, "admin", "whatsapp_connect", "waba", result.wabaId);
      return c.json(result);
    } catch (err) {
      const message = err instanceof ConnectError ? err.message : "unexpected error";
      deps.log.warn({ event: "whatsapp_connect_failed", error: message }, "WhatsApp connect failed");
      return c.json({ error: message }, 502);
    }
  });

  /** Diagnostics: Meta returned a sign-in code but no WhatsApp account. Reads only; nothing is connected. */
  r.post("/whatsapp-connect/inspect", async (c) => {
    if (!connectCfg.appId || !connectCfg.embeddedSignupConfigId || !connectCfg.appSecret) return c.json({ error: "not configured" }, 501);
    const code = parseCode(await c.req.json().catch(() => null));
    if (!code) return c.json({ error: "invalid input" }, 400);
    try {
      const report = await inspectGrant(connectCfg, code, deps.fetchImpl ?? fetch);
      deps.log.info({ event: "whatsapp_connect_inspect", scopes: report.scopes, wabas: report.wabas.map((w) => ({ id: w.id, numbers: w.numbers.map((n) => n.id) })) }, "Embedded Signup returned no WABA; grant inspected");
      return c.json(report);
    } catch (err) {
      const message = err instanceof ConnectError ? err.message : "unexpected error";
      deps.log.warn({ event: "whatsapp_connect_inspect_failed", error: message }, "grant inspection failed");
      return c.json({ error: message }, 502);
    }
  });

  r.post("/kb/reload", async (c) => {
    deps.knowledge.invalidate();
    return c.json({ ok: true });
  });

  return r;
}
