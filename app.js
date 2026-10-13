/* Rotax Reservedele – PWA frontend (vanilla JS + Supabase) */
(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const PAGE = 25;

  const state = {
    types: [],     // {id,name,active}
    dealers: [],
    recentOffset: 0,
    detail: null,  // part being edited
  };

  // ---------------- Helpers ----------------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtDate = (iso) => new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  const cleanCode = (s) => String(s || "").trim();

  let toastTimer;
  function toast(msg, kind = "") {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast " + kind;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  function errMsg(error) {
    if (!error) return "Ukendt fejl";
    if (error.code === "23505") return "Findes allerede";
    if (error.code === "23503") return "Er i brug og kan ikke slettes";
    if (/Failed to fetch|NetworkError/i.test(error.message)) return "Ingen forbindelse til serveren";
    return error.message || "Ukendt fejl";
  }

  // ---------------- Auth ----------------
  async function initAuth() {
    if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("DIT-PROJEKT")) {
      $("#view-login").hidden = false;
      $("#login-error").textContent = "Supabase er ikke sat op endnu – udfyld config.js.";
      $("#login-error").hidden = false;
      return;
    }
    const { data: { session } } = await sb.auth.getSession();
    setSession(session);
    sb.auth.onAuthStateChange((_e, s) => setSession(s));
  }

  let booted = false;
  function setSession(session) {
    const loggedIn = !!session;
    $("#view-login").hidden = loggedIn;
    $("#app").hidden = !loggedIn;
    if (loggedIn) {
      $("#user-email").textContent = session.user.email || "";
      if (!booted) { booted = true; boot(); }
    } else {
      booted = false;
    }
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    $("#login-error").hidden = true;
    const { error } = await sb.auth.signInWithPassword({
      email: $("#login-email").value.trim(),
      password: $("#login-pass").value
    });
    btn.disabled = false;
    if (error) {
      $("#login-error").textContent = error.message === "Invalid login credentials"
        ? "Forkert e-mail eller adgangskode" : errMsg(error);
      $("#login-error").hidden = false;
    }
  });

  async function logout() {
    if (!confirm("Vil du logge ud?")) return;
    await sb.auth.signOut();
  }
  $("#logout-btn").addEventListener("click", logout);
  $("#topbar-logout").addEventListener("click", logout);

  // ---------------- Routing ----------------
  function route() {
    const r = location.hash.replace(/^#\/?/, "") || "home";
    const name = r === "setup" ? "setup" : "home";
    $("#view-home").hidden = name !== "home";
    $("#view-setup").hidden = name !== "setup";
    $$(".tab").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // ---------------- Lookups (typer/forhandlere) ----------------
  async function loadLookups() {
    const [t, d] = await Promise.all([
      sb.from("part_types").select("id,name,active").order("name"),
      sb.from("dealers").select("id,name,active").order("name"),
    ]);
    if (t.error || d.error) { toast(errMsg(t.error || d.error), "err"); return; }
    state.types = t.data;
    state.dealers = d.data;
    renderDropdowns();
    renderSetupLists();
  }

  function optionsHtml(items, { placeholder, includeId, allInactive } = {}) {
    let html = placeholder ? `<option value="">${esc(placeholder)}</option>` : "";
    for (const it of items) {
      if (!it.active && !allInactive && it.id !== includeId) continue;
      html += `<option value="${it.id}">${esc(it.name)}${it.active ? "" : " (inaktiv)"}</option>`;
    }
    return html;
  }

  function renderDropdowns() {
    const keep = (sel) => sel.value;
    const ct = $("#create-type"), cd = $("#create-dealer");
    const ft = $("#filter-type"), fd = $("#filter-dealer");
    const [vct, vcd, vft, vfd] = [keep(ct), keep(cd), keep(ft), keep(fd)];
    ct.innerHTML = optionsHtml(state.types,   { placeholder: "Vælg type…" });
    cd.innerHTML = optionsHtml(state.dealers, { placeholder: "Vælg forhandler…" });
    ft.innerHTML = optionsHtml(state.types,   { placeholder: "Alle typer", allInactive: true });
    fd.innerHTML = optionsHtml(state.dealers, { placeholder: "Alle forhandlere", allInactive: true });
    ct.value = vct; cd.value = vcd; ft.value = vft; fd.value = vfd;
  }

  // ---------------- Søg ----------------
  async function search(code) {
    code = cleanCode(code);
    const out = $("#search-result");
    if (!code) { out.innerHTML = ""; return; }
    out.innerHTML = `<p class="muted">Søger…</p>`;

    let { data, error } = await sb.from("parts_view").select("*").eq("barcode", code).limit(1);
    let exact = true;
    if (!error && data.length === 0) {
      exact = false;
      ({ data, error } = await sb.from("parts_view").select("*")
        .ilike("barcode", `%${code.replace(/[%_]/g, "\\$&")}%`)
        .order("created_at", { ascending: false }).limit(20));
    }
    if (error) { out.innerHTML = `<p class="error">${esc(errMsg(error))}</p>`; return; }

    if (exact && data.length === 1) {
      const p = data[0];
      out.innerHTML = `
        <div class="result found">
          <h3>✓ Fundet</h3>
          <dl class="kv">
            <dt>Stregkode</dt><dd>${esc(p.barcode)}</dd>
            <dt>Type</dt><dd>${esc(p.type_name)}</dd>
            <dt>Forhandler</dt><dd>${esc(p.dealer_name)}</dd>
            <dt>Registreret</dt><dd>${fmtDate(p.created_at)}</dd>
            ${p.note ? `<dt>Note</dt><dd>${esc(p.note)}</dd>` : ""}
          </dl>
          <div class="actions"><button class="btn ghost" data-open="${p.id}">Redigér</button></div>
        </div>`;
      out.querySelector("[data-open]").onclick = () => openDetail(p);
      return;
    }

    if (data.length > 0) {
      out.innerHTML = `
        <div class="result none">
          <h3>Ingen præcis match – ${data.length} der ligner</h3>
          <div class="list">${data.map(rowHtml).join("")}</div>
          <div class="actions"><button class="btn primary" id="create-from-search">Opret "${esc(code)}"</button></div>
        </div>`;
      bindRows(out, data);
    } else {
      out.innerHTML = `
        <div class="result none">
          <h3>Ikke fundet</h3>
          <p style="margin:0">Stregkoden <strong>${esc(code)}</strong> er ikke registreret.</p>
          <div class="actions"><button class="btn primary" id="create-from-search">Opret som ny komponent</button></div>
        </div>`;
    }
    $("#create-from-search").onclick = () => {
      $("#create-barcode").value = code;
      $("#create-form").scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => $("#create-type").focus(), 300);
    };
  }

  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    search($("#search-input").value);
  });

  // ---------------- Opret ----------------
  $("#create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const barcode = cleanCode($("#create-barcode").value);
    const type_id = Number($("#create-type").value);
    const dealer_id = Number($("#create-dealer").value);
    const note = $("#create-note").value.trim() || null;
    if (!barcode || !type_id || !dealer_id) { toast("Udfyld stregkode, type og forhandler", "err"); return; }

    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.from("parts").insert({ barcode, type_id, dealer_id, note });
    btn.disabled = false;

    if (error) {
      if (error.code === "23505") {
        toast("Stregkoden er allerede registreret", "err");
        $("#search-input").value = barcode;
        search(barcode);
        $("#search-form").scrollIntoView({ behavior: "smooth" });
      } else {
        toast(errMsg(error), "err");
      }
      return;
    }
    toast("Komponent gemt ✓", "ok");
    // Behold type + forhandler så man hurtigt kan scanne flere af samme slags
    $("#create-barcode").value = "";
    $("#create-note").value = "";
    $("#create-barcode").focus();
    loadRecent(true);
  });

  // Enter i stregkode-feltet (fx fra USB-scanner) springer til næste felt i stedet for at sende formularen for tidligt
  $("#create-barcode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if ($("#create-type").value && $("#create-dealer").value) $("#create-form").requestSubmit();
      else ($("#create-type").value ? $("#create-dealer") : $("#create-type")).focus();
    }
  });

  // ---------------- Seneste ----------------
  function rowHtml(p) {
    return `<button type="button" class="row" data-id="${p.id}">
      <span class="code">${esc(p.barcode)}</span>
      <span class="date">${fmtDate(p.created_at)}</span>
      <span class="meta"><span class="pill">${esc(p.type_name)}</span>${esc(p.dealer_name)}</span>
    </button>`;
  }
  function bindRows(root, items) {
    $$(".row", root).forEach((el) => {
      el.onclick = () => openDetail(items.find((x) => String(x.id) === el.dataset.id));
    });
  }

  function filteredQuery(q) {
    const ft = $("#filter-type").value, fd = $("#filter-dealer").value;
    if (ft) q = q.eq("type_id", Number(ft));
    if (fd) q = q.eq("dealer_id", Number(fd));
    return q;
  }

  let recentItems = [];
  async function loadRecent(reset = false) {
    if (reset) { state.recentOffset = 0; recentItems = []; }
    const list = $("#recent-list");
    const { data, error } = await filteredQuery(sb.from("parts_view").select("*"))
      .order("created_at", { ascending: false })
      .range(state.recentOffset, state.recentOffset + PAGE - 1);
    if (error) { list.innerHTML = `<p class="error">${esc(errMsg(error))}</p>`; return; }
    recentItems = recentItems.concat(data);
    state.recentOffset += data.length;
    list.innerHTML = recentItems.length
      ? recentItems.map(rowHtml).join("")
      : `<p class="empty">Ingen registreringer endnu.</p>`;
    bindRows(list, recentItems);
    $("#more-btn").hidden = data.length < PAGE;
  }
  $("#more-btn").addEventListener("click", () => loadRecent(false));
  $("#filter-type").addEventListener("change", () => loadRecent(true));
  $("#filter-dealer").addEventListener("change", () => loadRecent(true));

  // ---------------- CSV-eksport ----------------
  $("#export-btn").addEventListener("click", async () => {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await filteredQuery(sb.from("parts_view").select("*"))
        .order("created_at", { ascending: false }).range(from, from + 999);
      if (error) { toast(errMsg(error), "err"); return; }
      all.push(...data);
      if (data.length < 1000) break;
    }
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Stregkode", "Type", "Forhandler", "Dato", "Note"].map(cell).join(";")];
    for (const p of all) lines.push([p.barcode, p.type_name, p.dealer_name, fmtDate(p.created_at), p.note].map(cell).join(";"));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `reservedele-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------------- Detalje / redigér ----------------
  const dlg = $("#detail-dialog");
  function openDetail(p) {
    if (!p) return;
    state.detail = p;
    $("#detail-barcode").textContent = p.barcode;
    $("#detail-date").textContent = "Registreret " + fmtDate(p.created_at);
    $("#detail-type").innerHTML = optionsHtml(state.types, { includeId: p.type_id });
    $("#detail-dealer").innerHTML = optionsHtml(state.dealers, { includeId: p.dealer_id });
    $("#detail-type").value = p.type_id;
    $("#detail-dealer").value = p.dealer_id;
    $("#detail-note").value = p.note || "";
    dlg.showModal();
  }
  $("#detail-cancel").onclick = () => dlg.close();
  $("#detail-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = state.detail;
    const { error } = await sb.from("parts").update({
      type_id: Number($("#detail-type").value),
      dealer_id: Number($("#detail-dealer").value),
      note: $("#detail-note").value.trim() || null,
    }).eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    dlg.close();
    toast("Ændringer gemt ✓", "ok");
    afterChange(p.barcode);
  });
  $("#detail-delete").onclick = async () => {
    const p = state.detail;
    if (!confirm(`Slet komponenten ${p.barcode}?\nDet kan ikke fortrydes.`)) return;
    const { error } = await sb.from("parts").delete().eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    dlg.close();
    toast("Komponent slettet", "ok");
    afterChange(p.barcode);
  };
  function afterChange(code) {
    loadRecent(true);
    if (cleanCode($("#search-input").value)) search($("#search-input").value);
  }

  // ---------------- Setup ----------------
  function renderSetupLists() {
    for (const [table, items] of [["part_types", state.types], ["dealers", state.dealers]]) {
      const ul = $("#list-" + table);
      ul.innerHTML = items.length ? items.map((it) => `
        <li class="${it.active ? "" : "inactive"}" data-id="${it.id}">
          <span class="name">${esc(it.name)}</span>
          <button class="btn ghost icon-btn" data-act="rename">Omdøb</button>
          <button class="btn ghost icon-btn" data-act="toggle">${it.active ? "Skjul" : "Aktivér"}</button>
          <button class="btn danger icon-btn" data-act="delete" aria-label="Slet">Slet</button>
        </li>`).join("") : `<li class="empty">Ingen endnu – tilføj ovenfor.</li>`;
      ul.onclick = (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const id = Number(btn.closest("li").dataset.id);
        setupAction(table, id, btn.dataset.act, items.find((x) => x.id === id));
      };
    }
  }

  async function setupAction(table, id, act, item) {
    let res;
    if (act === "rename") {
      const name = prompt("Nyt navn:", item.name);
      if (!name || !name.trim() || name.trim() === item.name) return;
      res = await sb.from(table).update({ name: name.trim() }).eq("id", id);
    } else if (act === "toggle") {
      res = await sb.from(table).update({ active: !item.active }).eq("id", id);
    } else if (act === "delete") {
      if (!confirm(`Slet "${item.name}"?`)) return;
      res = await sb.from(table).delete().eq("id", id);
      if (res.error && res.error.code === "23503") {
        toast(`"${item.name}" er brugt på komponenter – brug "Skjul" i stedet`, "err");
        return;
      }
    }
    if (res.error) { toast(errMsg(res.error), "err"); return; }
    await loadLookups();
    if (act !== "toggle") loadRecent(true);
  }

  $$(".add-row").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("input", form);
      const name = input.value.trim();
      if (!name) return;
      const { error } = await sb.from(form.dataset.table).insert({ name });
      if (error) { toast(error.code === "23505" ? `"${name}" findes allerede` : errMsg(error), "err"); return; }
      input.value = "";
      toast(`"${name}" tilføjet ✓`, "ok");
      loadLookups();
    });
  });

  // ---------------- Kamera-scanner ----------------
  let scanner = null, scanTarget = null;
  const FORMATS = (typeof Html5QrcodeSupportedFormats !== "undefined") ? [
    "CODE_128", "CODE_39", "CODE_93", "EAN_13", "EAN_8", "UPC_A", "UPC_E",
    "ITF", "CODABAR", "QR_CODE", "DATA_MATRIX"
  ].map((f) => Html5QrcodeSupportedFormats[f]).filter((v) => v !== undefined) : undefined;

  async function openScanner(targetId) {
    scanTarget = targetId;
    $("#scanner").hidden = false;
    $("#scanner-msg").textContent = "Starter kamera…";
    try {
      scanner = new Html5Qrcode("scanner-view", {
        formatsToSupport: FORMATS,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
      });
      await scanner.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.45) }) },
        onScan,
        () => {}
      );
      $("#scanner-msg").textContent = "Hold stregkoden inden for rammen";
    } catch (err) {
      $("#scanner-msg").textContent = "Kunne ikke starte kameraet. Tjek at appen har adgang til kameraet.";
      console.error(err);
    }
  }

  async function closeScanner() {
    try { if (scanner && scanner.isScanning) await scanner.stop(); } catch {}
    try { scanner && scanner.clear(); } catch {}
    scanner = null;
    $("#scanner").hidden = true;
  }

  async function onScan(text) {
    const code = cleanCode(text);
    if (!code) return;
    if (navigator.vibrate) navigator.vibrate(80);
    await closeScanner();
    const input = document.getElementById(scanTarget);
    input.value = code;
    if (scanTarget === "search-input") {
      search(code);
    } else {
      // Advar med det samme hvis koden allerede er registreret
      const { data } = await sb.from("parts").select("id").eq("barcode", code).limit(1);
      if (data && data.length) toast("OBS: stregkoden er allerede registreret", "err");
      ($("#create-type").value ? $("#create-dealer") : $("#create-type")).focus();
    }
  }

  $$("[data-scan-target]").forEach((b) => b.addEventListener("click", () => openScanner(b.dataset.scanTarget)));
  $("#scanner-close").addEventListener("click", closeScanner);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#scanner").hidden) closeScanner(); });

  // ---------------- Opstart ----------------
  async function boot() {
    route();
    await loadLookups();
    loadRecent(true);
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  initAuth();
})();
