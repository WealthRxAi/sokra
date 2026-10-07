/* Sokra — shared client. No framework, no build step. */
window.SOKRA = (() => {
  const API = "https://igussyvvpcrgriugnvlx.supabase.co/functions/v1/sokra-analyze";
  const $ = (s, r = document) => r.querySelector(s);

  const money = (n) => (n == null || isNaN(n)) ? "—" : "$" + Math.round(n).toLocaleString("en-US");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Copy that reports its own failure instead of doing nothing.
  async function copyText(text, okMsg, nearEl) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); return; } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove();
      if (ok) { toast(okMsg); return; }
    } catch {}
    // Last resort: select the real text on screen so the person can copy it themselves.
    const box = nearEl?.closest(".script, .doc")?.querySelector("p, pre");
    if (box) { const r = document.createRange(); r.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    toast("Couldn't copy automatically — the text is selected, hold and choose Copy");
  }


  // Renders the facility-policy block in its three states: still looking, found, or
  // not published anywhere we could read.
  function renderPolicy(fp) {
    const head = `<h2 class="sec">What your hospital's own policy says</h2>`;
    if (!fp) return head + `<div class="fap pending"><span class="dot"></span>Looking up ${"this hospital"}'s published financial assistance policy… this takes a minute and will appear here. You don't need to wait for it.</div>`;
    if (!fp.found) return head + `<div class="fap none"><b>We couldn't find this hospital's policy published online.</b> That doesn't mean there isn't one — under IRS 501(r) a nonprofit hospital must have a written policy and must give you the application if you ask. Use the script above and ask them to send it to you.</div>`;
    const rows = [
      fp.free_care_up_to_fpl != null ? ["Free care", `Household income up to ${fp.free_care_up_to_fpl}% of the poverty level`] : null,
      fp.discount_up_to_fpl != null ? ["Partial discount", `Up to ${fp.discount_up_to_fpl}% of the poverty level`] : null,
      fp.application_period_days != null ? ["You have", `${fp.application_period_days} days from your first bill to apply`] : null,
      fp.asset_test && fp.asset_test !== "unclear" ? ["Savings counted?", fp.asset_test === "yes" ? "Yes — they look at savings too" : "No — income only"] : null,
      fp.residency_required && fp.residency_required !== "unclear" ? ["Must live locally?", fp.residency_required === "yes" ? "Yes" : "No"] : null,
    ].filter(Boolean);
    return head + `<div class="fap found">
      ${fp.facility ? `<div class="fac">${esc(fp.facility)}</div>` : ""}
      ${rows.length ? `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`).join("")}</table>` : ""}
      ${fp.separate_providers ? `<p class="np"><b>Doctors who bill separately:</b> ${esc(fp.separate_providers)}</p>` : ""}
      ${fp.how_to_apply ? `<p class="np"><b>How to apply:</b> ${esc(fp.how_to_apply)}</p>` : ""}
      ${fp.notable ? `<p class="np">${esc(fp.notable)}</p>` : ""}
      <p class="src">Read from ${fp.source_url ? `<a href="${esc(fp.source_url)}" rel="noopener" target="_blank">the hospital's own policy</a>` : "the hospital's own policy"}${fp.checked_on ? ` on ${esc(fp.checked_on)}` : ""}. Policies change — confirm the numbers when you call.</p>
    </div>`;
  }

  // The lookup runs after the plan is delivered, so check back for it a few times.
  function pollPolicy(id, root, tries = 0) {
    if (!id || tries > 10) return;
    setTimeout(async () => {
      try {
        const b = await fetch(API + "/case/" + id).then((r) => r.json());
        const fp = b?.analysis?.facility_policy;
        const box = $("#fap", root);
        if (fp && box) { box.innerHTML = renderPolicy(fp); return; }
      } catch {}
      pollPolicy(id, root, tries + 1);
    }, tries < 3 ? 8000 : 15000);
  }

  function toast(t) { const el = $("#toast"); if (!el) return; el.setAttribute("role","status"); el.setAttribute("aria-live","polite"); el.textContent = t; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1600); }

  // ── Funnel ping. No cookie, no third-party script, no identity — just which step was
  // reached, so a drop-off between landing and upload is visible. Never blocks a page.
  function hit(step) {
    try {
      fetch(API + "/hit", {
        method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
        body: JSON.stringify({ step, ref: new URLSearchParams(location.search).get("ref") || (document.referrer || "").slice(0, 80) || null }),
      }).catch(() => {});
    } catch {}
  }

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
    if (opts.returning && id && opts.outcomeDone == null) h.push(`<div class="outcome-top"><b>Welcome back.</b> Made the call yet? When something comes off, <a href="#outcome" style="color:var(--teal)">tell us the number</a> — it's how we know this works.</div>`);

    if (a.do_first) h.push(`<section><h2 class="sec">Do this first</h2>
      <div class="first"><div class="a">${esc(a.do_first.action)}</div><div class="w">${esc(a.do_first.why)}</div><span class="when">${esc(a.do_first.when || "today")}</span></div></section>`);

    if ((a.deadlines || []).length) h.push(`<section><h2 class="sec">Deadlines</h2>${a.deadlines.map((d) => `<div class="dl"><b>${esc(d.what)} — ${esc(d.by)}</b><span>${esc(d.consequence)}</span></div>`).join("")}</section>`);

    // A glossary after the jargon has already appeared thirty times is a glossary
    // nobody reads. This sits above the levers, where the words first turn up.
    // What THIS hospital's own posted policy says, rather than a national average.
    // Arrives after the plan (it needs a web lookup), so render a placeholder and let
    // pollPolicy swap it in. Medical bills only.
    if (a.bill_type === "medical") {
      const fp = a.facility_policy;
      h.push(`<section id="fap">${renderPolicy(fp)}</section>`);
    }

    if ((a.plain_words || []).length) h.push(`<section><h2 class="sec">What these words mean</h2><div class="words">${a.plain_words.map((w) => `
      <div class="word"><b>${esc(w.term)}</b><span>${esc(w.means)}</span></div>`).join("")}</div></section>`);

    if (levers.length) h.push(`<section><h2 class="sec">Ways to lower this bill — biggest first</h2>${levers.map((l, i) => `
      <details class="lever" ${i === 0 ? "open" : ""}>
        <summary>
          <div class="top"><div class="nm">${esc(l.name)}</div><div class="amt">${money(l.reduction_low)}–${money(l.reduction_high)}</div></div>
          <div class="bc">${esc(l.applies_because)}</div>
          <div class="meta"><span class="pill conf-${esc(l.confidence)}">${esc(l.confidence)} confidence</span><span class="pill">${esc(l.effort)}</span></div>
        </summary>
        <div class="body">
          ${l.blocked_by ? `<div class="wait"><b>Wait — don't do this one yet.</b> Finish “${esc(l.blocked_by)}” first.${l.blocked_why ? ` ${esc(l.blocked_why)}` : ""}</div>` : ""}
          ${(l.steps || []).length ? `<ol>${l.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
          ${l.script ? `<div class="script"><div class="lab">Say or send this</div><p>${esc(l.script)}</p><button class="copy" data-copy="${esc(l.script)}">copy</button></div>` : ""}
          ${l.who_to_contact ? `<div class="who">Contact: ${esc(l.who_to_contact)}</div>` : ""}
        </div></details>`).join("")}</section>`);

    if ((a.errors_found || []).length) h.push(`<section><h2 class="sec">What looks wrong on the bill</h2><table>${a.errors_found.map((e) => `
      <tr><td><b>${esc(e.issue)}</b><br><span style="color:var(--ink3);font-size:13px">${esc(e.where)} — ${esc(e.how_to_dispute)}</span></td><td class="r">${money(e.estimated_overcharge)}</td></tr>`).join("")}</table></section>`);

    if ((a.line_items || []).length) h.push(`<section><h2 class="sec">What Sokra read on your bill</h2><table>${a.line_items.map((li) => `
      <tr><td>${esc(li.description)}${li.flag ? `<br><span style="color:#F0A48A;font-size:12px">⚑ ${esc(li.flag)}</span>` : ""}</td><td class="r">${money(li.amount)}</td></tr>`).join("")}</table></section>`);

    if ((a.teach || []).length) h.push(`<section><h2 class="sec">So you never need this again</h2>${a.teach.map((t) => `
      <details class="q"><summary class="qq">${esc(t.q)}</summary><p>${esc(t.a)}</p></details>`).join("")}</section>`);

    // ── Pro tier
    if (id && opts.pricing?.enabled !== false) {
      if (opts.tier === "pro") {
        h.push(`<section id="pro"><h2 class="sec">Your documents</h2><div id="docs"><div class="analyzing" style="padding:28px 0"><div class="ring" style="width:36px;height:36px"></div><div class="steps">Writing your letters from this bill…</div></div></div></section>`);
      } else {
        const price = opts.pricing?.pro_price_cents ? "$" + (opts.pricing.pro_price_cents / 100).toFixed(0) : "$29";
        const topLever = levers[0]?.name ? esc(levers[0].name) : "the top lever";
        h.push(`<div class="pro" id="pro">
          <div class="k">Want it written for you?</div>
          <h3>Ready-to-send letters, drafted from this bill.</h3>
          <p>Sokra Pro turns the plan above into the actual documents — filled in with your bill's numbers, account, dates and the laws that apply. Print, sign, send.</p>
          <ul>
            <li>Letter for <b>${topLever}</b>${levers[1] ? ` and ${esc(levers[1].name)}` : ""}</li>
            <li>One-page call sheet: what to say, what they'll say back, what to write down</li>
            <li>Document checklist and a dated timeline</li>
          </ul>
          <div class="price">${price} <small>one time · this bill · no subscription</small></div>
          <button class="btn" id="pro_btn">Get my documents</button>
          <div class="guar">If the letters aren't usable, reply to your receipt and it's refunded. The free plan above never goes away.</div>
        </div>`);
      }
    }

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
    root.querySelectorAll(".copy").forEach((b) => b.addEventListener("click", () => copyText(b.dataset.copy, "Copied — go make the call", b)));
    $("#oc_btn", root)?.addEventListener("click", async () => {
      const amt = $("#oc_amt", root).value.replace(/[^0-9.]/g, ""); if (!amt) return;
      const r = await fetch(API + "/outcome", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, amount: +amt }) });
      if (r.ok) { $("#outcome", root).innerHTML = `<div class="t">Thank you.</div><div class="d">${money(+amt)} reported. That's the number that matters.</div>`; }
      else toast("Couldn't save — try again");
    });
    if (a.bill_type === "medical" && !a.facility_policy) pollPolicy(id, root);
    $("#share_btn", root)?.addEventListener("click", () => copyText(opts.planUrl, "Link copied"));
    if ($("#pro_btn", root)) hit("pro_shown");
    $("#pro_btn", root)?.addEventListener("click", async () => {
      hit("pro_clicked");
      const b = $("#pro_btn", root); b.disabled = true; b.textContent = "Opening secure checkout…";
      try {
        const r = await fetch(API + "/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
        const j = await r.json();
        if (j.already) { location.href = "./plan.html?id=" + id + "&paid=1"; return; }
        if (!r.ok || !j.url) throw new Error(j.error || "Couldn't start checkout");
        location.href = j.url;
      } catch (e) { toast(e.message); b.disabled = false; b.textContent = "Get my documents"; }
    });
    if (opts.tier === "pro") loadDocs(root, id);
    $("#del_btn", root)?.addEventListener("click", async () => {
      if (!confirm("Delete this plan and any uploaded files permanently?")) return;
      const r = await fetch(API + "/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (r.ok) { root.innerHTML = `<div class="card" style="margin-top:28px"><b>Deleted.</b><p class="hint">Your plan and files are gone. Nothing else was kept.</p><a class="btn ghost" href="./">Start over</a></div>`; }
      else toast("Couldn't delete — try again");
    });
  }

  // ── Pro documents
  async function loadDocs(root, id, attempt = 0) {
    const box = $("#docs", root); if (!box) return;
    try {
      const r = await fetch(API + "/docs/" + id);
      const j = await r.json();
      if (r.status === 402) { box.innerHTML = `<div class="hint">Payment is still processing — this usually takes a few seconds. <a href="#" id="docs_retry">Refresh</a></div>`; $("#docs_retry", root)?.addEventListener("click", (e) => { e.preventDefault(); loadDocs(root, id, attempt + 1); }); if (attempt < 6) setTimeout(() => loadDocs(root, id, attempt + 1), 3000); return; }
      if (!r.ok || !j.docs) throw new Error(j.error || "Couldn't load documents");
      renderDocs(box, j.docs);
    } catch (e) {
      box.innerHTML = `<div class="err" style="display:block">${esc(e.message)} <a href="#" id="docs_retry" style="color:inherit">Try again</a></div>`;
      $("#docs_retry", root)?.addEventListener("click", (ev) => { ev.preventDefault(); box.innerHTML = `<div class="analyzing" style="padding:28px 0"><div class="ring" style="width:36px;height:36px"></div></div>`; loadDocs(root, id, attempt + 1); });
    }
  }
  function renderDocs(box, d) {
    const h = [];
    (d.letters || []).forEach((L, i) => h.push(`<details class="doc" ${i === 0 ? "open" : ""}>
      <summary><div><div class="t">${esc(L.title)}</div><div class="to">To: ${esc(L.to)} · ${esc(L.how)}</div></div></summary>
      <div class="body"><pre>${esc(L.body)}</pre>
        <div class="acts"><button data-copy="${esc(L.body)}" class="copyb">Copy letter</button><button data-print="${i}" class="printb">Print / save PDF</button></div></div></details>`));
    const c = d.call_sheet;
    if (c) h.push(`<details class="doc" open><summary><div><div class="t">${esc(c.title || "Call sheet")}</div><div class="to">${esc(c.who)} · ${esc(c.number_hint)}</div></div></summary>
      <div class="body"><div class="cs">
        <b>Open with</b><div class="say">"${esc(c.opening)}"</div>
        <b>Ask for, in order</b><ul>${(c.asks || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        ${(c.if_they_say || []).length ? `<b>If they say…</b><ul>${c.if_they_say.map((x) => `<li><i>"${esc(x.they)}"</i> → ${esc(x.you)}</li>`).join("")}</ul>` : ""}
        <b>Before hanging up</b><ul>${(c.before_hanging_up || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <b>Write down</b><ul>${(c.write_down || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </div><div class="acts"><button class="printb" data-print="cs">Print call sheet</button></div></div></details>`);
    if ((d.checklist || []).length) h.push(`<details class="doc"><summary><div class="t">Documents to gather</div></summary><div class="body"><div class="cs"><ul>${d.checklist.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div></details>`);
    if ((d.timeline || []).length) h.push(`<details class="doc"><summary><div class="t">Timeline</div></summary><div class="body"><div class="cs"><ul>${d.timeline.map((x) => `<li><b style="display:inline;margin:0 6px 0 0;color:var(--gold)">${esc(x.when)}</b>${esc(x.what)}</li>`).join("")}</ul></div></div></details>`);
    box.innerHTML = h.join("");
    box.querySelectorAll(".copyb").forEach((b) => b.addEventListener("click", () => copyText(b.dataset.copy, "Letter copied", b)));
    box.querySelectorAll(".printb").forEach((b) => b.addEventListener("click", () => { box.querySelectorAll("details").forEach((x) => x.open = true); window.print(); }));
  }

  // ── PWA
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; const el = $("#install"); if (el) el.style.display = "block"; });
  function install() { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } }

  return { API, $, money, esc, toast, prepare, renderPlan, install, loadDocs, hit };
})();
