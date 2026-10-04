/* Sokra — shared client. No framework, no build step. */
window.SOKRA = (() => {
  const API = "https://igussyvvpcrgriugnvlx.supabase.co/functions/v1/sokra-analyze";
  const $ = (s, r = document) => r.querySelector(s);

  const money = (n) => (n == null || isNaN(n)) ? "—" : "$" + Math.round(n).toLocaleString("en-US");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function toast(t) { const el = $("#toast"); if (!el) return; el.textContent = t; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1600); }

  // ── Image pipeline: HEIC/oversized phone photos → ≤1800px JPEG. PDFs pass through.
  async function prepare(file) {
    if (file.type === "application/pdf") return file;
    const isImg = file.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name);
    if (!isImg) return file;
    try {
      const bmp = await createImageBitmap(file);           // Safari decodes HEIC here; others get JPEG/PNG
      const max = 1800, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.86));
      if (!blob) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    } catch {
      if (/heic|heif/i.test(file.type + file.name)) throw new Error("This photo is in HEIC format and your browser can't convert it. Take a screenshot of the bill instead, or change iPhone camera settings to 'Most Compatible'.");
      return file;
    }
  }

  // ── Render a full plan into a container
  function renderPlan(root, a, id, opts = {}) {
    const lo = a.estimated_reduction_low, hi = a.estimated_reduction_high, tot = a.total_amount;
    const pct = (tot && hi) ? Math.min(100, Math.round(hi / tot * 100)) : null;
    const levers = (a.levers || []).slice().sort((x, y) => (y.reduction_high || 0) - (x.reduction_high || 0));
    const h = [];

    if (a.image_quality === "poor") h.push(`<div class="err" style="display:block;margin-top:24px">The photo was hard to read, so parts of this plan may be incomplete. ${esc(a.summary || "")}</div>`);

    h.push(`<div class="hero">
      <div class="k">${esc(a.provider || "Your bill")} · ${esc((a.bill_type || "").replace(/_/g, " "))}</div>
      <div class="n">${money(lo)}–${money(hi)} <small>could come off</small></div>
      <div class="sub">of ${money(tot)} total${pct ? ` — up to ${pct}%` : ""}. ${a.image_quality === "poor" ? "" : esc(a.summary || "")}</div>
      <div class="row">
        ${a.due_date ? `<span class="pill">Due ${esc(a.due_date)}</span>` : ""}
        ${a.in_collections ? `<span class="pill warn">In collections</span>` : ""}
        <span class="pill">${levers.length} lever${levers.length === 1 ? "" : "s"}</span>
        ${(a.errors_found || []).length ? `<span class="pill warn">${a.errors_found.length} error${a.errors_found.length === 1 ? "" : "s"} found</span>` : ""}
      </div></div>`);

    if (a.escalate) h.push(`<div class="esc"><b>Get a human on this.</b> ${esc(a.escalate)}</div>`);

    if (a.do_first) h.push(`<section><div class="sec">Do this first</div>
      <div class="first"><div class="a">${esc(a.do_first.action)}</div><div class="w">${esc(a.do_first.why)}</div><span class="when">${esc(a.do_first.when || "today")}</span></div></section>`);

    if ((a.deadlines || []).length) h.push(`<section><div class="sec">Deadlines</div>${a.deadlines.map((d) => `<div class="dl"><b>${esc(d.what)} — ${esc(d.by)}</b><span>${esc(d.consequence)}</span></div>`).join("")}</section>`);

    if (levers.length) h.push(`<section><div class="sec">How to reduce it — ranked by impact</div>${levers.map((l, i) => `
      <details class="lever" ${i === 0 ? "open" : ""}>
        <summary>
          <div class="top"><div class="nm">${esc(l.name)}</div><div class="amt">${money(l.reduction_low)}–${money(l.reduction_high)}</div></div>
          <div class="bc">${esc(l.applies_because)}</div>
          <div class="meta"><span class="pill conf-${esc(l.confidence)}">${esc(l.confidence)} confidence</span><span class="pill">${esc(l.effort)}</span></div>
        </summary>
        <div class="body">
          ${(l.steps || []).length ? `<ol>${l.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
          ${l.script ? `<div class="script"><div class="lab">Say or send this</div><p>${esc(l.script)}</p><button class="copy" data-copy="${esc(l.script)}">copy</button></div>` : ""}
          ${l.who_to_contact ? `<div class="who">Contact: ${esc(l.who_to_contact)}</div>` : ""}
        </div></details>`).join("")}</section>`);

    if ((a.errors_found || []).length) h.push(`<section><div class="sec">Errors on the bill</div><table>${a.errors_found.map((e) => `
      <tr><td><b>${esc(e.issue)}</b><br><span style="color:var(--ink3);font-size:13px">${esc(e.where)} — ${esc(e.how_to_dispute)}</span></td><td class="r">${money(e.estimated_overcharge)}</td></tr>`).join("")}</table></section>`);

    if ((a.line_items || []).length) h.push(`<section><div class="sec">What Sokra read</div><table>${a.line_items.map((li) => `
      <tr><td>${esc(li.description)}${li.flag ? `<br><span style="color:#F0A48A;font-size:12px">⚑ ${esc(li.flag)}</span>` : ""}</td><td class="r">${money(li.amount)}</td></tr>`).join("")}</table></section>`);

    if ((a.teach || []).length) h.push(`<section><div class="sec">So you never need this again</div>${a.teach.map((t) => `
      <details class="q"><summary class="qq">${esc(t.q)}</summary><p>${esc(t.a)}</p></details>`).join("")}</section>`);

    if (id) {
      const planUrl = location.origin + location.pathname.replace(/[^/]*$/, "") + "plan.html?id=" + id;
      h.push(`<div class="outcome" id="outcome">
        <div class="t">${opts.outcomeDone ? "Thank you." : "Did it work?"}</div>
        <div class="d">${opts.outcomeDone ? `You reported ${money(opts.outcomeDone / 100)} came off. That's the only number we optimize for.` : "Come back and tell us how much came off. It's the only number we optimize for."}</div>
        ${opts.outcomeDone ? "" : `<div class="f"><input type="text" inputmode="numeric" placeholder="Amount reduced, e.g. 39200" id="oc_amt"><button id="oc_btn">Report</button></div>`}
      </div>
      <div class="row" style="margin-top:18px">
        <button class="pill" id="share_btn" style="cursor:pointer">Copy link to this plan</button>
        <button class="pill" id="del_btn" style="cursor:pointer;color:#F0A48A">Delete my data</button>
      </div>`);
      opts.planUrl = planUrl;
    }

    h.push(`<p class="disc">${esc(a.disclaimer || "Sokra provides financial education and advocacy scripts, not legal or licensed financial advice.")} Nothing here is sent to your biller.${id ? ` Plan ${esc(id.slice(0, 8))}.` : ""}</p>`);
    h.push(`<a class="btn ghost" href="./">Analyze another bill</a>`);

    root.innerHTML = h.join("");
    root.querySelectorAll(".copy").forEach((b) => b.addEventListener("click", () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Copied — go make the call"))));
    $("#oc_btn", root)?.addEventListener("click", async () => {
      const amt = $("#oc_amt", root).value.replace(/[^0-9.]/g, ""); if (!amt) return;
      const r = await fetch(API + "/outcome", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, amount: +amt }) });
      if (r.ok) { $("#outcome", root).innerHTML = `<div class="t">Thank you.</div><div class="d">${money(+amt)} reported. That's the number that matters.</div>`; }
      else toast("Couldn't save — try again");
    });
    $("#share_btn", root)?.addEventListener("click", () => navigator.clipboard.writeText(opts.planUrl).then(() => toast("Link copied")));
    $("#del_btn", root)?.addEventListener("click", async () => {
      if (!confirm("Delete this plan and any uploaded files permanently?")) return;
      const r = await fetch(API + "/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (r.ok) { root.innerHTML = `<div class="card" style="margin-top:28px"><b>Deleted.</b><p class="hint">Your plan and files are gone. Nothing else was kept.</p><a class="btn ghost" href="./">Start over</a></div>`; }
      else toast("Couldn't delete — try again");
    });
  }

  // ── PWA
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; const el = $("#install"); if (el) el.style.display = "block"; });
  function install() { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } }

  return { API, $, money, esc, toast, prepare, renderPlan, install };
})();
