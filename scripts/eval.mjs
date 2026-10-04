#!/usr/bin/env node
// Sokra eval — runs every bill in test-bills/ through the live engine and checks the plan is usable.
// Usage: node scripts/eval.mjs [--api https://.../sokra-analyze]
import fs from "node:fs";
import path from "node:path";

const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "https://igussyvvpcrgriugnvlx.supabase.co/functions/v1/sokra-analyze";
const dir = path.resolve("test-bills");
const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|pdf)$/i.test(f));
const ctxFor = (name) => (fs.existsSync(path.join(dir, name + ".json")) ? JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8")) : {});

const h = await fetch(API + "/health").then((r) => r.json());
console.log("health:", h);
if (!h.has_key) { console.error("\nANTHROPIC_API_KEY is not set on the function. Nothing to evaluate."); process.exit(2); }

let pass = 0;
for (const f of files) {
  const base = f.replace(/\.[^.]+$/, "");
  const ctx = ctxFor(base);
  const fd = new FormData();
  const buf = fs.readFileSync(path.join(dir, f));
  fd.append("files", new Blob([buf], { type: f.endsWith(".pdf") ? "application/pdf" : "image/png" }), f);
  for (const [k, v] of Object.entries(ctx.fields ?? {})) fd.append(k, String(v));
  fd.append("source", "eval");
  const t0 = Date.now();
  const r = await fetch(API, { method: "POST", body: fd });
  const b = await r.json();
  const ms = Date.now() - t0;
  const a = b.analysis ?? {};
  const checks = {
    ok: !!b.ok,
    has_levers: (a.levers?.length ?? 0) >= 1,
    has_scripts: (a.levers ?? []).every((l) => typeof l.script === "string" && l.script.length > 40),
    has_do_first: !!a.do_first?.action,
    total_read: typeof a.total_amount === "number",
    estimate_sane: typeof a.estimated_reduction_high === "number" && a.estimated_reduction_high <= (a.total_amount ?? Infinity) * 1.01,
    ...(ctx.expect ? Object.fromEntries(Object.entries(ctx.expect).map(([k, v]) => {
      if (k === "bill_type") return [k, a.bill_type === v];
      if (k === "total_amount") return [k, Math.abs((a.total_amount ?? 0) - v) < 1];
      if (k === "lever_includes") return [k, (a.levers ?? []).some((l) => new RegExp(v, "i").test(l.name + " " + l.applies_because))];
      if (k === "errors_min") return [k, (a.errors_found?.length ?? 0) >= v];
      return [k, true];
    })) : {}),
  };
  const good = Object.values(checks).every(Boolean);
  pass += good ? 1 : 0;
  console.log(`\n${good ? "PASS" : "FAIL"}  ${f}  ${ms}ms  ${b.id ?? ""}`);
  console.log("  ", a.provider, "|", a.bill_type, "| total", a.total_amount, "| est", a.estimated_reduction_low, "-", a.estimated_reduction_high);
  for (const [k, v] of Object.entries(checks)) if (!v) console.log("   ✗", k);
  if (!b.ok) console.log("   error:", b.error);
}
console.log(`\n${pass}/${files.length} passed`);
process.exit(pass === files.length ? 0 : 1);
