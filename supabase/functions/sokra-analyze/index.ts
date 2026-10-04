// ─────────────────────────────────────────────────────────────────────────────
// SOKRA — backend
//
// Routes (all under /functions/v1/sokra-analyze):
//   GET  /health                → { ok, has_key, has_email, model }
//   POST /                      → analyze (multipart: files[], income, household, state, insured, notes, email, consent_store, source)
//   GET  /case/:id              → saved plan (public by unguessable uuid)
//   POST /outcome               → { id, amount, note? }  self-reported $ reduced
//   POST /delete                → { id }  user-initiated deletion (files + analysis)
//   GET  /stats?token=…         → admin dashboard numbers
//   GET  /cases?token=…&limit=  → admin recent cases
//   POST /followup              → cron: email 14-day "did it work?" (x-cron-token)
//
// Env (Supabase secrets): ANTHROPIC_API_KEY (required), RESEND_API_KEY (optional),
//   SOKRA_MODEL (optional), SOKRA_FROM (optional email From)
// Config (sokra.config): playbook, admin_token_sha256, cron_token_sha256, app_url
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "jsr:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

// Direct Postgres (the `sokra` schema is not exposed to PostgREST; this avoids that dependency entirely)
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10 });

const MODEL = Deno.env.get("SOKRA_MODEL") ?? "claude-sonnet-5-5";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("SOKRA_FROM") ?? "Sokra <sokra@llcreativityllc.com>";
const MAX_FILES = 6;
const MAX_BYTES = 15 * 1024 * 1024;
const IMG = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-token",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf); let s = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
const money = (c: number | null | undefined) => c == null ? "—" : "$" + Math.round(c / 100).toLocaleString("en-US");
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function storage() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!).storage.from("sokra-bills");
}
async function cfg(key: string): Promise<string | null> {
  const r = await sql`select value from sokra.config where key = ${key}`;
  return r[0]?.value ?? null;
}
async function log(kind: string, case_id: string | null, meta: unknown = null) {
  try { await sql`insert into sokra.events (kind, case_id, meta) values (${kind}, ${case_id}, ${meta ? sql.json(meta as never) : null})`; } catch { /* non-fatal */ }
}

// Fallback if the playbook row is missing — keeps the product alive, less sharp.
const FALLBACK_PLAYBOOK = `You are Sokra, a financial advocate. Read the uploaded bill, find errors, list every realistic way to reduce it with exact scripts, say what to do first, flag deadlines, and teach 3 short Q&As. Education, not legal advice. Respond with ONLY a JSON object with keys: bill_type, provider, total_amount, currency, due_date, in_collections, summary, estimated_reduction_low, estimated_reduction_high, do_first{action,why,when}, deadlines[], errors_found[], levers[{name,applies_because,reduction_low,reduction_high,confidence,effort,steps[],script,who_to_contact}], line_items[], teach[{q,a}], escalate, disclaimer, image_quality.`;

// ─── email ───────────────────────────────────────────────────────────────────
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    return r.ok;
  } catch { return false; }
}
function planEmail(appUrl: string, id: string, a: Record<string, unknown>) {
  const df = (a.do_first as { action?: string } | null)?.action ?? "";
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
  <p style="font-size:13px;color:#777;letter-spacing:.1em">SOKRA</p>
  <h2 style="margin:0 0 8px">Your plan for the ${esc(String(a.provider ?? "bill"))}</h2>
  <p style="font-size:18px;margin:0 0 16px"><b>$${num(a.estimated_reduction_low)}–$${num(a.estimated_reduction_high)}</b> could come off a $${num(a.total_amount)} bill.</p>
  ${df ? `<p style="background:#f4f1ea;border-left:3px solid #D9B45A;padding:12px 14px;margin:0 0 16px"><b>Do this first:</b> ${esc(df)}</p>` : ""}
  <p><a href="${appUrl}/plan.html?id=${id}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px">Open your full plan →</a></p>
  <p style="font-size:12px;color:#777;margin-top:24px">This is financial education and advocacy scripting, not legal or licensed financial advice. You can delete your data any time from the plan page.</p></div>`;
}
function followupEmail(appUrl: string, id: string, provider: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
  <p style="font-size:13px;color:#777;letter-spacing:.1em">SOKRA</p>
  <h2 style="margin:0 0 8px">Did it work?</h2>
  <p>Two weeks ago you ran the ${esc(provider || "bill")} through Sokra. Did any of it come off?</p>
  <p>It takes ten seconds and it's the only number we care about. It's also how we get better for the next person.</p>
  <p><a href="${appUrl}/plan.html?id=${id}#outcome" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px">Tell us what happened →</a></p>
  <p style="font-size:12px;color:#777;margin-top:24px">If nothing's happened yet, the scripts are still on your plan page. If you'd rather not hear from us, just ignore this — we only send one.</p></div>`;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const num = (n: unknown) => typeof n === "number" ? Math.round(n).toLocaleString("en-US") : "—";

// ─── routes ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/sokra-analyze/, "") || "/";
  // health
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    let pb = false, dbOk = false;
    try { pb = !!(await cfg("playbook")); dbOk = true; } catch { /* db down */ }
    return json({ ok: true, db: dbOk, has_key: !!ANTHROPIC_KEY, has_email: !!RESEND_KEY, has_playbook: pb, model: MODEL });
  }

  // saved plan
  if (req.method === "GET" && path.startsWith("/case/")) {
    const id = path.slice(6);
    if (!isUuid(id)) return json({ error: "bad id" }, 400);
    const r = await sql`select id, created_at, provider, bill_type, analysis, outcome_reported_cents, deleted_at from sokra.cases where id = ${id}`;
    const data = r[0];
    if (!data || data.deleted_at) return json({ error: "Plan not found or deleted" }, 404);
    return json({ ok: true, ...data });
  }

  // admin
  if (req.method === "GET" && (path === "/stats" || path === "/cases")) {
    const tok = url.searchParams.get("token") ?? req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const want = await cfg("admin_token_sha256");
    if (!tok || !want || (await sha(tok)) !== want) return json({ error: "unauthorized" }, 401);
    if (path === "/cases") {
      const limit = Math.min(200, +(url.searchParams.get("limit") ?? 50));
      const data = await sql`select id, created_at, email, bill_type, provider, total_cents, est_reduction_low_cents, est_reduction_high_cents, outcome_reported_cents, outcome_at, latency_ms, tokens_in, tokens_out, source, deleted_at from sokra.cases order by created_at desc limit ${limit}`;
      return json({ ok: true, cases: data });
    }
    const r = await sql`select bill_type, total_cents, est_reduction_low_cents, est_reduction_high_cents, outcome_reported_cents, created_at, email, deleted_at, latency_ms, tokens_in, tokens_out from sokra.cases` as unknown as Array<Record<string, any>>;
    const live = r.filter((x) => !x.deleted_at);
    const sum = (k: string) => live.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const outcomes = live.filter((x) => x.outcome_reported_cents != null);
    const byType: Record<string, number> = {};
    for (const x of live) byType[x.bill_type ?? "unknown"] = (byType[x.bill_type ?? "unknown"] ?? 0) + 1;
    const day = (d: string) => d.slice(0, 10);
    const perDay: Record<string, number> = {};
    for (const x of live) { const d = day(new Date(x.created_at).toISOString()); perDay[d] = (perDay[d] ?? 0) + 1; }
    const avgLatency = live.length ? Math.round(live.reduce((a, x) => a + (Number(x.latency_ms) || 0), 0) / live.length) : 0;
    // rough cost: sonnet-class pricing ~$3/M in, $15/M out
    const cost = live.reduce((a, x) => a + ((Number(x.tokens_in) || 0) * 3 + (Number(x.tokens_out) || 0) * 15) / 1e6, 0);
    return json({
      ok: true,
      cases: live.length, deleted: r.length - live.length,
      with_email: live.filter((x) => !!x.email).length,
      total_billed_cents: sum("total_cents"),
      est_low_cents: sum("est_reduction_low_cents"), est_high_cents: sum("est_reduction_high_cents"),
      outcomes_reported: outcomes.length,
      reported_reduced_cents: outcomes.reduce((a, x) => a + (Number(x.outcome_reported_cents) || 0), 0),
      by_type: byType, per_day: perDay, avg_latency_ms: avgLatency, est_api_cost_usd: +cost.toFixed(2),
      has_key: !!ANTHROPIC_KEY, has_email: !!RESEND_KEY, model: MODEL,
    });
  }

  if (req.method !== "POST") return json({ error: "method" }, 405);

  // outcome
  if (path === "/outcome") {
    let b: { id?: string; amount?: number; note?: string } = {};
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!b.id || !isUuid(b.id) || typeof b.amount !== "number" || !isFinite(b.amount) || b.amount < 0) return json({ error: "id and amount required" }, 400);
    try {
      await sql`update sokra.cases set outcome_reported_cents = ${Math.round(b.amount * 100)}, outcome_note = ${(b.note ?? "").toString().slice(0, 500) || null}, outcome_at = now() where id = ${b.id}`;
      await log("outcome", b.id, { amount: b.amount });
      return json({ ok: true });
    } catch { return json({ error: "could not save" }, 500); }
  }

  // delete
  if (path === "/delete") {
    let b: { id?: string } = {};
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!b.id || !isUuid(b.id)) return json({ error: "id required" }, 400);
    const r = await sql`select files from sokra.cases where id = ${b.id}`;
    const paths = ((r[0]?.files as { path?: string }[] | null) ?? []).map((f) => f.path).filter((p): p is string => !!p);
    if (paths.length) await storage().remove(paths);
    await sql`update sokra.cases set analysis = null, files = null, context = null, email = null, deleted_at = now() where id = ${b.id}`;
    await log("delete", b.id);
    return json({ ok: true });
  }

  // follow-up (cron)
  if (path === "/followup") {
    const tok = req.headers.get("x-cron-token") ?? "";
    const want = await cfg("cron_token_sha256");
    if (!tok || !want || (await sha(tok)) !== want) return json({ error: "unauthorized" }, 401);
    if (!RESEND_KEY) { await log("followup_run", null, { sent: 0, note: "no RESEND_API_KEY" }); return json({ ok: true, sent: 0, note: "RESEND_API_KEY not set" }); }
    const appUrl = (await cfg("app_url")) ?? "";
    const data = await sql`select id, email, provider from sokra.cases where followup_sent_at is null and outcome_reported_cents is null and deleted_at is null and email is not null and created_at <= now() - interval '14 days' and created_at >= now() - interval '21 days' limit 100`;
    let sent = 0;
    for (const c of data) {
      const ok = await sendEmail(c.email, "Did it work? (Sokra)", followupEmail(appUrl, c.id, c.provider ?? ""));
      if (ok) { sent++; await sql`update sokra.cases set followup_sent_at = now() where id = ${c.id}`; }
    }
    await log("followup_run", null, { sent });
    return json({ ok: true, sent });
  }

  // ── analyze ────────────────────────────────────────────────────────────────
  if (path !== "/" && path !== "/analyze") return json({ error: "not found" }, 404);
  if (!ANTHROPIC_KEY) return json({ error: "Sokra isn't switched on yet — the analysis key hasn't been added. Try again shortly." }, 503);

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "Expected multipart form data" }, 400); }

  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return json({ error: "Attach at least one photo or PDF of the bill" }, 400);
  if (files.length > MAX_FILES) return json({ error: `Up to ${MAX_FILES} files` }, 400);
  for (const f of files) {
    if (f.size > MAX_BYTES) return json({ error: `${f.name} is over 15 MB` }, 400);
    if (!IMG.has(f.type) && f.type !== "application/pdf") return json({ error: `Unsupported file type (${f.type || "unknown"}). Use a photo (JPG/PNG) or a PDF.` }, 400);
  }

  const g = (k: string, n = 200) => (form.get(k) ?? "").toString().trim().slice(0, n);
  const ctx = {
    income: g("income", 20).replace(/[^0-9.]/g, "") || null,
    household: g("household", 3).replace(/[^0-9]/g, "") || null,
    state: g("state", 2).toUpperCase() || null,
    insured: g("insured", 3) || null,
    notes: g("notes", 1500) || null,
  };
  const emailRaw = g("email").toLowerCase();
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : null;
  const consentStore = g("consent_store", 5) === "1" || g("consent_store", 5) === "true";
  const source = g("source", 80) || null;
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 200);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
  const ipHash = ip ? (await sha(ip)).slice(0, 32) : null;

  if (ipHash) {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const c = await sql`select count(*)::int as n from sokra.cases where ip_hash = ${ipHash} and created_at >= ${since}`;
    if ((c[0]?.n ?? 0) >= 8) return json({ error: "That's a lot of bills from one connection. Try again in an hour." }, 429);
  }

  const playbook = (await cfg("playbook")) ?? FALLBACK_PLAYBOOK;

  const content: unknown[] = [];
  const buffers: { f: File; buf: ArrayBuffer }[] = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    buffers.push({ f, buf });
    const data = b64(buf);
    content.push(f.type === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: f.type, data } });
  }
  const ctxLines = [
    ctx.income ? `Annual household income: $${ctx.income}` : null,
    ctx.household ? `Household size: ${ctx.household}` : null,
    ctx.state ? `State: ${ctx.state}` : null,
    ctx.insured ? `Has health insurance: ${ctx.insured}` : null,
    ctx.notes ? `Notes from the person: ${ctx.notes}` : null,
  ].filter(Boolean);
  content.push({ type: "text", text:
    `Analyze this bill and produce the full reduction plan as JSON.\n` +
    (ctxLines.length ? `Context:\n${ctxLines.join("\n")}\n` : `No extra context was provided — note in levers where income/household info would unlock more (e.g. charity care).\n`) +
    `Today's date: ${new Date().toISOString().slice(0, 10)}.` });

  const t0 = Date.now();
  let raw = ""; let usage: { input_tokens?: number; output_tokens?: number } = {};
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, temperature: 0.2, system: playbook, messages: [{ role: "user", content }] }),
    });
    const body = await r.json();
    if (!r.ok) { await log("api_error", null, { status: r.status, msg: body?.error?.message }); return json({ error: "The analysis engine had a problem. Please try again in a minute." }, 502); }
    raw = (body.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    usage = body.usage ?? {};
  } catch (e) {
    await log("api_unreachable", null, { msg: (e as Error).message });
    return json({ error: "Couldn't reach the analysis engine. Please try again." }, 502);
  }
  const latency = Date.now() - t0;

  let analysis: Record<string, unknown>;
  try { const m = raw.match(/\{[\s\S]*\}/); analysis = JSON.parse(m ? m[0] : raw); }
  catch { await log("parse_error", null, { head: raw.slice(0, 300) }); return json({ error: "Couldn't read that clearly. Try a sharper, straight-on photo with the total visible." }, 500); }

  const cents = (n: unknown) => (typeof n === "number" && isFinite(n) ? Math.round(n * 100) : null);
  let id: string | undefined;
  try {
    const ins = await sql`insert into sokra.cases (email, bill_type, provider, total_cents, est_reduction_low_cents, est_reduction_high_cents, context, analysis, model, tokens_in, tokens_out, latency_ms, ip_hash, source, ua, consent_store, files)
      values (${email}, ${(analysis.bill_type as string) ?? null}, ${(analysis.provider as string) ?? null}, ${cents(analysis.total_amount)}, ${cents(analysis.estimated_reduction_low)}, ${cents(analysis.estimated_reduction_high)},
        ${sql.json(ctx as never)}, ${sql.json(analysis as never)}, ${MODEL}, ${usage.input_tokens ?? null}, ${usage.output_tokens ?? null}, ${latency}, ${ipHash}, ${source}, ${ua}, ${consentStore},
        ${sql.json(buffers.map(({ f }) => ({ name: f.name.slice(0, 120), type: f.type, size: f.size })) as never)})
      returning id`;
    id = ins[0]?.id as string;
  } catch (e) { await log("db_insert_error", null, { msg: (e as Error).message }); }

  // Store originals only with consent (used for re-analysis + audit trail)
  if (id && consentStore) {
    const stored: { path: string; name: string; type: string; size: number }[] = [];
    for (let i = 0; i < buffers.length; i++) {
      const { f, buf } = buffers[i];
      const ext = f.type === "application/pdf" ? "pdf" : (f.type.split("/")[1] || "bin");
      const p = `${id}/${String(i + 1).padStart(2, "0")}.${ext}`;
      const { error } = await storage().upload(p, buf, { contentType: f.type, upsert: false });
      if (!error) stored.push({ path: p, name: f.name.slice(0, 120), type: f.type, size: f.size });
    }
    if (stored.length) await sql`update sokra.cases set files = ${sql.json(stored as never)} where id = ${id}`;
  }

  await log("analyze", id ?? null, { bill_type: analysis.bill_type, latency, source });

  // Email the plan (best effort)
  let emailed = false;
  if (id && email) {
    const appUrl = (await cfg("app_url")) ?? "";
    emailed = await sendEmail(email, `Your Sokra plan: ${money(cents(analysis.estimated_reduction_low))}–${money(cents(analysis.estimated_reduction_high))} could come off`, planEmail(appUrl, id, analysis));
    if (emailed) await sql`update sokra.cases set plan_emailed_at = now() where id = ${id}`;
  }

  return json({ ok: true, id: id ?? null, analysis, emailed });
});
