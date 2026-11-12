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
    me: { userId: null, email: "", importerId: null, importerName: "", role: "user" },
    types: [],        // {id,name,active,importer_id,can_have_children}
    dealers: [],
    importers: [],    // kun for Rotax (superadmin)
    childParent: null,
    detail: null,
    parts: { offset: 0, items: [] },
  };

  const canEdit = () => !!state.me.importerId;
  const isSuper = () => state.me.role === "superadmin";
  const isOwn = (p) => p && p.importer_id === state.me.importerId && canEdit();
  const ownTypes = () => state.types.filter((t) => t.importer_id === state.me.importerId);
  const ownDealers = () => state.dealers.filter((d) => d.importer_id === state.me.importerId);
  const typeById = (id) => state.types.find((t) => t.id === id);
  const importerName = (id) => (state.importers.find((i) => i.id === id) || {}).name || "";

  // ---------------- Helpers ----------------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtDate = (iso) => new Date(iso).toLocaleString("da-DK", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  });

  const cleanCode = (s) => String(s || "").trim();
  const likeEsc = (s) => s.replace(/[%_\\]/g, "\\$&");

  let toastTimer;
  function toast(msg, kind = "") {
    const t = $("#toast");
    // Vis beskeden oven på en åben dialog (dialoger ligger i et eget lag)
    const host = [...document.querySelectorAll("dialog[open]")].pop() || document.body;
    if (t.parentElement !== host) host.appendChild(t);
    t.textContent = msg;
    t.className = "toast " + kind;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  function errMsg(error) {
    if (!error) return "Ukendt fejl";
    if (error.code === "P0001") return error.message;          // regler fra databasen
    if (error.code === "23505") return "Findes allerede";
    if (error.code === "23503") return "Er i brug og kan ikke slettes";
    if (error.code === "42501") return "Ingen adgang";
    if (/Failed to fetch|NetworkError/i.test(error.message)) return "Ingen forbindelse til serveren";
    return error.message || "Ukendt fejl";
  }

  const fetchPart = async (id) => {
    const { data, error } = await sb.from("parts_view").select("*").eq("id", id).maybeSingle();
    if (error) toast(errMsg(error), "err");
    return data;
  };
  const fetchChildren = async (parentId) => {
    const { data, error } = await sb.from("parts_view").select("*").eq("parent_id", parentId).order("barcode");
    if (error) toast(errMsg(error), "err");
    return data || [];
  };
  // Find en del på stregkode hos egen importør
  const findOwnByBarcode = async (code) => {
    const { data } = await sb.from("parts_view").select("*")
      .eq("barcode", code).eq("importer_id", state.me.importerId).maybeSingle();
    return data;
  };

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
      state.me.userId = session.user.id;
      state.me.email = session.user.email || "";
      $("#user-email").textContent = state.me.email;
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

  // ---------------- Profil / importør ----------------
  async function loadProfile() {
    const { data, error } = await sb.from("profiles")
      .select("role, importer_id, importers(name)").eq("user_id", state.me.userId).maybeSingle();
    if (error) {
      const missing = /profiles|schema cache|does not exist/i.test(error.message);
      showBlocker(missing
        ? "Databasen skal opdateres: kør filen supabase/002-importoerer-og-underdele.sql i Supabase."
        : errMsg(error));
      return false;
    }
    state.me.role = data?.role || "user";
    state.me.importerId = data?.importer_id ?? null;
    state.me.importerName = data?.importers?.name || "";

    if (!state.me.importerId && !isSuper()) {
      showBlocker("Din bruger er ikke tilknyttet en importør endnu. Kontakt administratoren.");
      return false;
    }
    if (isSuper()) {
      const { data: imps } = await sb.from("importers").select("id,name").order("name");
      state.importers = imps || [];
      const sel = $("#filter-importer");
      sel.innerHTML = `<option value="">Alle importører</option>` +
        state.importers.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join("");
      sel.hidden = false;
    }
    $("#user-importer").textContent = (state.me.importerName || "–") + (isSuper() ? " (Rotax – alle importører)" : "");
    $("#readonly-banner").hidden = canEdit();
    $$(".add-row").forEach((f) => (f.hidden = !canEdit()));
    return true;
  }

  function showBlocker(msg) {
    $("#no-importer").hidden = false;
    $("#no-importer p").textContent = msg;
    $$(".view", $("main")).forEach((v) => (v.hidden = true));
    $(".tabs").hidden = true;
  }

  // ---------------- Routing ----------------
  let currentRoute = "home";
  function route() {
    if (!$("#no-importer").hidden) return;
    const r = location.hash.replace(/^#\/?/, "") || "home";
    const name = ["setup", "parts"].includes(r) ? r : "home";
    currentRoute = name;
    $("#view-home").hidden = name !== "home";
    $("#view-parts").hidden = name !== "parts";
    $("#view-setup").hidden = name !== "setup";
    $$(".tab").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    if (name === "parts") loadParts(true);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // ---------------- Lookups (typer/forhandlere) ----------------
  async function loadLookups() {
    const [t, d] = await Promise.all([
      sb.from("part_types").select("id,name,active,importer_id,can_have_children").order("name"),
      sb.from("dealers").select("id,name,active,importer_id").order("name"),
    ]);
    if (t.error || d.error) { toast(errMsg(t.error || d.error), "err"); return; }
    state.types = t.data;
    state.dealers = d.data;
    renderDropdowns();
    renderSetupLists();
  }

  function label(it) {
    const imp = isSuper() && it.importer_id !== state.me.importerId ? ` – ${importerName(it.importer_id)}` : "";
    return esc(it.name) + imp + (it.active ? "" : " (inaktiv)");
  }

  function optionsHtml(items, { placeholder, includeId, allInactive } = {}) {
    let html = placeholder ? `<option value="">${esc(placeholder)}</option>` : "";
    for (const it of items) {
      if (!it.active && !allInactive && it.id !== includeId) continue;
      html += `<option value="${it.id}">${label(it)}</option>`;
    }
    return html;
  }

  function renderDropdowns() {
    const sets = [
      ["#create-type", ownTypes(), { placeholder: "Vælg type…" }],
      ["#create-dealer", ownDealers(), { placeholder: "Vælg forhandler…" }],
      ["#child-type", ownTypes().filter((t) => !t.can_have_children), { placeholder: "Vælg type…" }],
      ["#filter-type", state.types, { placeholder: "Alle typer", allInactive: true }],
      ["#filter-dealer", state.dealers, { placeholder: "Alle forhandlere", allInactive: true }],
    ];
    for (const [sel, items, opts] of sets) {
      const el = $(sel), v = el.value;
      el.innerHTML = optionsHtml(items, opts);
      el.value = v;
    }
    updateCreateHint();
  }

  function updateCreateHint() {
    const t = typeById(Number($("#create-type").value));
    $("#create-hint").textContent = t && t.can_have_children
      ? "Efter du har gemt, kan du scanne underdele (fx cylinder og plombe) ind under denne del."
      : "Dato og tid gemmes automatisk.";
  }
  $("#create-type").addEventListener("change", updateCreateHint);

  // ---------------- Rækker ----------------
  function rowHtml(p, { child = false } = {}) {
    const bits = [`<span class="pill">${esc(p.type_name)}</span>${esc(p.dealer_name)}`];
    if (isSuper()) bits.push(`<span class="imp">${esc(p.importer_name)}</span>`);
    if (p.parent_id && !child) bits.push(`<span class="link-ish">↳ i ${esc(p.parent_type_name)} ${esc(p.parent_barcode)}</span>`);
    if (p.child_count > 0) bits.push(`<span class="kids">${p.child_count} underdel${p.child_count === 1 ? "" : "e"}</span>`);
    return `<button type="button" class="row${child ? " child" : ""}" data-id="${p.id}">
      <span class="code">${child ? '<span class="branch">↳</span>' : ""}${esc(p.barcode)}</span>
      <span class="date">${child ? "" : fmtDate(p.created_at)}</span>
      <span class="meta">${bits.join(" · ")}</span>
    </button>`;
  }
  function bindRows(root) {
    $$(".row[data-id]", root).forEach((el) => (el.onclick = () => openDetail(Number(el.dataset.id))));
  }

  // ---------------- Søg (forside) ----------------
  async function search(code) {
    code = cleanCode(code);
    const out = $("#search-result");
    if (!code) { out.innerHTML = ""; return; }
    out.innerHTML = `<p class="muted">Søger…</p>`;

    let { data, error } = await sb.from("parts_view").select("*").eq("barcode", code).limit(20);
    let exact = true;
    if (!error && data.length === 0) {
      exact = false;
      ({ data, error } = await sb.from("parts_view").select("*")
        .ilike("barcode", `%${likeEsc(code)}%`)
        .order("created_at", { ascending: false }).limit(20));
    }
    if (error) { out.innerHTML = `<p class="error">${esc(errMsg(error))}</p>`; return; }

    if (exact && data.length === 1) {
      hideCreate();
      const p = data[0];
      const kids = p.child_count > 0 ? await fetchChildren(p.id) : [];
      out.innerHTML = `
        <div class="result found">
          <h3>✓ Fundet</h3>
          <dl class="kv">
            <dt>Stregkode</dt><dd>${esc(p.barcode)}</dd>
            <dt>Type</dt><dd>${esc(p.type_name)}</dd>
            <dt>Forhandler</dt><dd>${esc(p.dealer_name)}</dd>
            <dt>Registreret</dt><dd>${fmtDate(p.created_at)}</dd>
            ${isSuper() ? `<dt>Importør</dt><dd>${esc(p.importer_name)}</dd>` : ""}
            ${p.parent_id ? `<dt>Sidder i</dt><dd><a href="#" data-open="${p.parent_id}">${esc(p.parent_type_name)} ${esc(p.parent_barcode)}</a></dd>` : ""}
            ${p.note ? `<dt>Note</dt><dd>${esc(p.note)}</dd>` : ""}
          </dl>
          ${kids.length ? `<h3 class="sub-head">Underdele (${kids.length})</h3><div class="list">${kids.map((k) => rowHtml(k, { child: true })).join("")}</div>` : ""}
          <div class="actions">
            <button type="button" class="btn ghost" data-open="${p.id}">${isOwn(p) ? "Åbn / redigér" : "Åbn"}</button>
            ${isOwn(p) && p.can_have_children && !p.parent_id ? `<button type="button" class="btn primary" data-kids="${p.id}">Scan underdele</button>` : ""}
          </div>
        </div>`;
      bindRows(out);
      $$("[data-open]", out).forEach((a) => (a.onclick = (e) => { e.preventDefault(); openDetail(Number(a.dataset.open)); }));
      const kb = $("[data-kids]", out);
      if (kb) kb.onclick = () => openChildPanel(p);
      $("#search-input").select();
      return;
    }

    const createBtn = canEdit() ? `<button type="button" class="btn primary" id="create-from-search">Opret "${esc(code)}" som ny</button>` : "";
    if (data.length > 0) {
      hideCreate();
      out.innerHTML = `
        <div class="result none">
          <h3>${exact ? `${data.length} dele med denne stregkode` : `Ingen præcis match – ${data.length} der ligner`}</h3>
          <div class="list">${data.map((p) => rowHtml(p)).join("")}</div>
          ${exact ? "" : `<div class="actions">${createBtn}</div>`}
        </div>`;
      bindRows(out);
    } else if (canEdit()) {
      // Ikke fundet: vis opret-formularen direkte med stregkoden udfyldt
      out.innerHTML = `<div class="result none"><h3>Ikke registreret</h3>
        <p style="margin:0">Udfyld type og forhandler herunder for at oprette <strong>${esc(code)}</strong>.</p></div>`;
      showCreate(code);
      return;
    } else {
      out.innerHTML = `<div class="result none"><h3>Ikke fundet</h3>
        <p style="margin:0">Stregkoden <strong>${esc(code)}</strong> er ikke registreret.</p></div>`;
    }
    const cb = $("#create-from-search");
    if (cb) cb.onclick = () => showCreate(code);
  }

  function showCreate(code) {
    $("#create-barcode").value = code;
    $("#create-code").textContent = code;
    $("#create-card").hidden = false;
    updateCreateHint();
    setTimeout(() => {
      $("#create-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
      $("#create-type").focus();
    }, 50);
  }
  function hideCreate() {
    $("#create-card").hidden = true;
    $("#create-barcode").value = "";
    $("#create-code").textContent = "";
    $("#create-note").value = "";
  }
  // Ryd forsiden, klar til næste scanning
  function resetHome() {
    hideCreate();
    $("#search-input").value = "";
    $("#search-result").innerHTML = "";
    $("#search-input").focus();
  }
  $("#create-cancel").addEventListener("click", resetHome);

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
    const { data, error } = await sb.from("parts").insert({ barcode, type_id, dealer_id, note }).select("id").single();
    btn.disabled = false;

    if (error) {
      if (error.code === "23505") {
        toast("Stregkoden er allerede registreret", "err");
        $("#search-input").value = barcode;
        search(barcode);
      } else {
        toast(errMsg(error), "err");
      }
      return;
    }
    resetHome();
    loadRecent();

    const t = typeById(type_id);
    if (t && t.can_have_children) {
      const p = await fetchPart(data.id);
      toast(`${t.name} gemt ✓ – scan nu underdele`, "ok");
      if (p) openChildPanel(p);
    } else {
      toast("Komponent gemt ✓", "ok");
    }
  });

  // ---------------- Underdele-panel ----------------
  async function openChildPanel(parent) {
    state.childParent = parent;
    if (currentRoute !== "home") location.hash = "#/";
    if ($("#detail-dialog").open) $("#detail-dialog").close();
    hideCreate();
    $("#search-input").value = "";
    $("#search-result").innerHTML = "";
    $("#child-panel").hidden = false;
    $("#child-parent").innerHTML = `
      <span class="pill">${esc(parent.type_name)}</span>
      <strong class="code">${esc(parent.barcode)}</strong>
      <span class="muted small">${esc(parent.dealer_name)} · ${fmtDate(parent.created_at)}</span>`;
    if (!$("#child-type").value) {
      const guess = ownTypes().find((t) => !t.can_have_children && t.active && /cylind/i.test(t.name));
      if (guess) $("#child-type").value = guess.id;
    }
    await renderChildList();
    setTimeout(() => {
      $("#child-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      $("#child-barcode").focus();
    }, 50);
  }

  async function renderChildList() {
    const p = state.childParent;
    if (!p) return;
    const kids = await fetchChildren(p.id);
    $("#child-list").innerHTML = kids.length
      ? kids.map((k) => rowHtml(k, { child: true })).join("")
      : `<p class="empty">Ingen underdele endnu – scan den første.</p>`;
    bindRows($("#child-list"));
  }

  function closeChildPanel() {
    state.childParent = null;
    $("#child-panel").hidden = true;
    $("#child-barcode").value = "";
  }
  $("#child-done").addEventListener("click", () => {
    closeChildPanel();
    resetHome();
    loadRecent();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  async function attachExisting(existing, parent) {
    if (existing.id === parent.id) { toast("Det er hoveddelens egen stregkode", "err"); return false; }
    if (existing.parent_id === parent.id) { toast("Delen sidder allerede på denne hoveddel", "err"); return false; }
    const q = existing.parent_id
      ? `Delen ${existing.barcode} sidder i ${existing.parent_type_name} ${existing.parent_barcode}.\nFlyt den til ${parent.barcode}?`
      : `Delen ${existing.barcode} (${existing.type_name}) findes allerede.\nKobl den på ${parent.barcode}?`;
    if (!confirm(q)) return false;
    const { error } = await sb.from("parts").update({ parent_id: parent.id }).eq("id", existing.id);
    if (error) { toast(errMsg(error), "err"); return false; }
    toast(existing.parent_id ? "Underdel flyttet ✓" : "Underdel koblet på ✓", "ok");
    return true;
  }

  $("#child-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const parent = state.childParent;
    if (!parent) return;
    const barcode = cleanCode($("#child-barcode").value);
    const type_id = Number($("#child-type").value);
    if (!barcode || !type_id) { toast("Udfyld stregkode og type", "err"); return; }
    if (barcode === parent.barcode) { toast("Det er hoveddelens egen stregkode", "err"); return; }

    const btn = e.submitter; if (btn) btn.disabled = true;
    const { error } = await sb.from("parts").insert({
      barcode, type_id, dealer_id: parent.dealer_id, parent_id: parent.id
    });
    if (btn) btn.disabled = false;

    let ok = !error;
    if (error && error.code === "23505") {
      const existing = await findOwnByBarcode(barcode);
      ok = existing ? await attachExisting(existing, parent) : false;
    } else if (error) {
      toast(errMsg(error), "err");
    } else {
      toast("Underdel tilføjet ✓", "ok");
    }
    if (ok) {
      $("#child-barcode").value = "";
      await renderChildList();
      afterChange();
    }
    $("#child-barcode").focus();
  });

  $("#child-barcode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if ($("#child-type").value) $("#child-form").requestSubmit();
      else $("#child-type").focus();
    }
  });

  // ---------------- Seneste (forside) ----------------
  async function loadRecent() {
    const list = $("#recent-list");
    const { data, error } = await sb.from("parts_view").select("*")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(5);
    if (error) { list.innerHTML = `<p class="error">${esc(errMsg(error))}</p>`; return; }
    list.innerHTML = data.length ? data.map((p) => rowHtml(p)).join("") : `<p class="empty">Ingen registreringer endnu.</p>`;
    bindRows(list);
  }

  // ---------------- Dele-siden ----------------
  function partsFilters() {
    return {
      q: cleanCode($("#parts-q").value),
      type: $("#filter-type").value,
      dealer: $("#filter-dealer").value,
      importer: $("#filter-importer").value,
    };
  }
  function applyFilters(query, f, { grouped }) {
    if (f.dealer) query = query.eq("dealer_id", Number(f.dealer));
    if (f.importer) query = query.eq("importer_id", Number(f.importer));
    if (f.type) query = query.eq("type_id", Number(f.type));
    if (f.q) query = query.ilike("barcode", `%${likeEsc(f.q)}%`);
    if (grouped) query = query.is("parent_id", null);
    return query;
  }

  let partsSeq = 0;
  async function loadParts(reset = false) {
    const seq = ++partsSeq;
    if (reset) state.parts = { offset: 0, items: [] };
    const f = partsFilters();
    const grouped = !f.q && !f.type;
    const list = $("#parts-list");
    if (reset) list.innerHTML = `<p class="muted">Henter…</p>`;

    const { data, error, count } = await applyFilters(
      sb.from("parts_view").select("*", { count: "exact" }), f, { grouped })
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(state.parts.offset, state.parts.offset + PAGE - 1);
    if (seq !== partsSeq) return;
    if (error) { list.innerHTML = `<p class="error">${esc(errMsg(error))}</p>`; return; }

    let kidsByParent = {};
    if (grouped) {
      const ids = data.filter((p) => p.child_count > 0).map((p) => p.id);
      if (ids.length) {
        const { data: kids } = await sb.from("parts_view").select("*").in("parent_id", ids).order("barcode");
        for (const k of kids || []) (kidsByParent[k.parent_id] ||= []).push(k);
      }
    }
    if (seq !== partsSeq) return;

    state.parts.items = state.parts.items.concat(data.map((p) => ({ p, kids: kidsByParent[p.id] || [] })));
    state.parts.offset += data.length;

    $("#parts-count").textContent = `(${count ?? 0})`;
    $("#parts-mode").textContent = grouped
      ? "Underdele vises under deres hoveddel."
      : "Viser alle dele der matcher – også underdele.";
    list.innerHTML = state.parts.items.length
      ? state.parts.items.map(({ p, kids }) =>
          `<div class="group">${rowHtml(p)}${kids.map((k) => rowHtml(k, { child: true })).join("")}</div>`).join("")
      : `<p class="empty">Ingen dele fundet.</p>`;
    bindRows(list);
    $("#more-btn").hidden = data.length < PAGE;
  }

  $("#more-btn").addEventListener("click", () => loadParts(false));
  ["#filter-type", "#filter-dealer", "#filter-importer"].forEach((s) =>
    $(s).addEventListener("change", () => loadParts(true)));
  let qTimer;
  $("#parts-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => loadParts(true), 300); });

  // CSV-eksport (alle dele der matcher filtrene – også underdele)
  $("#export-btn").addEventListener("click", async () => {
    const f = partsFilters();
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await applyFilters(sb.from("parts_view").select("*"), f, { grouped: false })
        .order("created_at", { ascending: false })
        .order("parent_id", { ascending: true, nullsFirst: true })
        .order("barcode").range(from, from + 999);
      if (error) { toast(errMsg(error), "err"); return; }
      all.push(...data);
      if (data.length < 1000) break;
    }
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Stregkode", "Type", "Forhandler", "Dato", "Hoveddel", "Hoveddel type", "Antal underdele", "Note"];
    if (isSuper()) head.unshift("Importør");
    const lines = [head.map(cell).join(";")];
    for (const p of all) {
      const row = [p.barcode, p.type_name, p.dealer_name, fmtDate(p.created_at),
        p.parent_barcode, p.parent_type_name, p.child_count || "", p.note];
      if (isSuper()) row.unshift(p.importer_name);
      lines.push(row.map(cell).join(";"));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `reservedele-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------------- Detalje / redigér ----------------
  const dlg = $("#detail-dialog");

  async function openDetail(id) {
    const p = await fetchPart(id);
    if (!p) { toast("Delen findes ikke længere", "err"); afterChange(); return; }
    state.detail = p;
    const own = isOwn(p);

    $("#detail-title").textContent = p.type_name;
    $("#detail-barcode").textContent = p.barcode;
    $("#detail-date").textContent = "Registreret " + fmtDate(p.created_at) + (isSuper() ? ` · ${p.importer_name}` : "");

    // Hoveddel
    const pb = $("#detail-parent");
    if (p.parent_id) {
      pb.hidden = false;
      pb.innerHTML = `
        <div>Underdel af <a href="#" data-open="${p.parent_id}"><strong>${esc(p.parent_type_name)} ${esc(p.parent_barcode)}</strong></a></div>
        ${own ? `<div class="row-actions">
          <button type="button" class="btn ghost small-btn" data-act="move">Flyt til anden</button>
          <button type="button" class="btn ghost small-btn" data-act="detach">Løsn</button>
        </div>` : ""}`;
    } else if (own && !p.can_have_children && !p.child_count && ownTypes().some((t) => t.can_have_children)) {
      pb.hidden = false;
      pb.innerHTML = `
        <div class="muted">Ikke koblet på en hoveddel</div>
        <div class="row-actions"><button type="button" class="btn ghost small-btn" data-act="move">Kobl på motor</button></div>`;
    } else {
      pb.hidden = true;
      pb.innerHTML = "";
    }
    $$("[data-open]", pb).forEach((a) => (a.onclick = (e) => { e.preventDefault(); openDetail(Number(a.dataset.open)); }));
    $$("[data-act]", pb).forEach((b) => (b.onclick = () => (b.dataset.act === "move" ? showMove() : detach())));
    $("#move-box").hidden = true;
    $("#move-barcode").value = "";

    // Felter
    const typeItems = own ? ownTypes() : state.types.filter((t) => t.id === p.type_id);
    const dealerItems = own ? ownDealers() : state.dealers.filter((d) => d.id === p.dealer_id);
    $("#detail-type").innerHTML = optionsHtml(typeItems, { includeId: p.type_id });
    $("#detail-dealer").innerHTML = optionsHtml(dealerItems, { includeId: p.dealer_id });
    $("#detail-type").value = p.type_id;
    $("#detail-dealer").value = p.dealer_id;
    $("#detail-note").value = p.note || "";
    $("#detail-type").disabled = !own;
    $("#detail-dealer").disabled = !own || !!p.parent_id;
    $("#detail-note").disabled = !own;
    $("#detail-dealer-note").hidden = !p.parent_id;
    $("#detail-dealer-note").textContent = "Forhandler arves fra hoveddelen.";
    if (!p.parent_id && p.child_count > 0) {
      $("#detail-dealer-note").hidden = false;
      $("#detail-dealer-note").textContent = "Ændres forhandleren, følger alle underdele med.";
    }

    // Underdele
    const showKids = !p.parent_id && (p.can_have_children || p.child_count > 0);
    $("#detail-children-wrap").hidden = !showKids;
    $("#detail-add-children").hidden = !(own && p.can_have_children);
    if (showKids) {
      const kids = await fetchChildren(p.id);
      $("#detail-child-count").textContent = `(${kids.length})`;
      $("#detail-children").innerHTML = kids.length
        ? kids.map((k) => rowHtml(k, { child: true })).join("")
        : `<p class="empty">Ingen underdele.</p>`;
      bindRows($("#detail-children"));
    }

    // Historik
    const { data: moves } = await sb.from("part_moves").select("*").eq("part_id", p.id).order("moved_at", { ascending: false });
    $("#detail-history-wrap").hidden = !(moves && moves.length);
    $("#detail-history").innerHTML = (moves || []).map((m) => {
      const from = m.from_parent_id ? esc(m.from_parent_barcode || "slettet hoveddel") : null;
      const to = m.to_parent_id ? esc(m.to_parent_barcode || "?") : null;
      const txt = from && to ? `Flyttet fra <b>${from}</b> til <b>${to}</b>`
        : to ? `Koblet på <b>${to}</b>` : `Løsnet fra <b>${from}</b>`;
      return `<li><span class="muted">${fmtDate(m.moved_at)}</span> ${txt}</li>`;
    }).join("");

    // Knapper
    $("#detail-delete").hidden = !own;
    $("#detail-save").hidden = !own;
    $("#detail-cancel").textContent = own ? "Annullér" : "Luk";

    if (!dlg.open) dlg.showModal();
  }

  const closeDetail = () => dlg.close();
  $("#detail-cancel").onclick = closeDetail;
  $("#detail-x").onclick = closeDetail;
  $("#detail-add-children").onclick = () => { const p = state.detail; closeDetail(); openChildPanel(p); };

  function showMove() {
    $("#move-box").hidden = false;
    $("#move-barcode").focus();
  }
  $("#move-cancel").onclick = () => { $("#move-box").hidden = true; };
  $("#move-go").onclick = () => doMove();
  $("#move-barcode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doMove(); }
  });

  async function doMove() {
    const p = state.detail;
    const code = cleanCode($("#move-barcode").value);
    if (!code) { toast("Scan eller skriv hoveddelens stregkode", "err"); return; }
    const target = await findOwnByBarcode(code);
    if (!target) { toast(`Stregkoden ${code} er ikke registreret`, "err"); return; }
    if (target.id === p.id) { toast("En del kan ikke kobles på sig selv", "err"); return; }
    if (target.id === p.parent_id) { toast("Delen sidder allerede der", "err"); return; }
    if (!target.can_have_children) { toast(`${target.type_name} kan ikke have underdele`, "err"); return; }
    if (target.parent_id) { toast("Den valgte del er selv en underdel", "err"); return; }
    const { error } = await sb.from("parts").update({ parent_id: target.id }).eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    toast(p.parent_id ? `Flyttet til ${target.barcode} ✓` : `Koblet på ${target.barcode} ✓`, "ok");
    afterChange();
    openDetail(p.id);
  }

  async function detach() {
    const p = state.detail;
    if (!confirm(`Løsn ${p.barcode} fra ${p.parent_barcode}?`)) return;
    const { error } = await sb.from("parts").update({ parent_id: null }).eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    toast("Underdel løsnet", "ok");
    afterChange();
    openDetail(p.id);
  }

  $("#detail-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = state.detail;
    const upd = {
      type_id: Number($("#detail-type").value),
      note: $("#detail-note").value.trim() || null,
    };
    if (!p.parent_id) upd.dealer_id = Number($("#detail-dealer").value);
    const { error } = await sb.from("parts").update(upd).eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    dlg.close();
    toast("Ændringer gemt ✓", "ok");
    afterChange();
  });

  $("#detail-delete").onclick = async () => {
    const p = state.detail;
    const extra = p.child_count > 0 ? `\n\nDens ${p.child_count} underdel(e) bliver løsnet, men ikke slettet.` : "";
    if (!confirm(`Slet komponenten ${p.barcode}?\nDet kan ikke fortrydes.${extra}`)) return;
    const { error } = await sb.from("parts").delete().eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    dlg.close();
    if (state.childParent && state.childParent.id === p.id) closeChildPanel();
    toast("Komponent slettet", "ok");
    afterChange();
  };

  function afterChange() {
    loadRecent();
    if (currentRoute === "parts") loadParts(true);
    if (cleanCode($("#search-input").value)) search($("#search-input").value);
    if (state.childParent) renderChildList();
  }

  // ---------------- Setup ----------------
  function renderSetupLists() {
    for (const [table, items] of [["part_types", ownTypes()], ["dealers", ownDealers()]]) {
      const ul = $("#list-" + table);
      const edit = canEdit();
      ul.innerHTML = items.length ? items.map((it) => `
        <li class="${it.active ? "" : "inactive"}" data-id="${it.id}">
          <span class="name">${esc(it.name)}${it.can_have_children ? ' <span class="badge">Underdele</span>' : ""}</span>
          ${edit ? `<span class="li-actions">
            ${table === "part_types" ? `<button class="btn ghost icon-btn" data-act="children">${it.can_have_children ? "Fjern underdele" : "Tillad underdele"}</button>` : ""}
            <button class="btn ghost icon-btn" data-act="rename">Omdøb</button>
            <button class="btn ghost icon-btn" data-act="toggle">${it.active ? "Skjul" : "Aktivér"}</button>
            <button class="btn danger icon-btn" data-act="delete" aria-label="Slet">Slet</button>
          </span>` : ""}
        </li>`).join("") : `<li class="empty">Ingen endnu${edit ? " – tilføj ovenfor" : ""}.</li>`;
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
    } else if (act === "children") {
      if (item.can_have_children && !confirm(`Fjern muligheden for underdele på "${item.name}"?\nEksisterende underdele bliver siddende.`)) return;
      res = await sb.from(table).update({ can_have_children: !item.can_have_children }).eq("id", id);
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
    if (act !== "toggle") afterChange();
  }

  $$(".add-row").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("input[type=text]", form);
      const name = input.value.trim();
      if (!name) return;
      const row = { name };
      const cb = $("input[name=children]", form);
      if (cb) row.can_have_children = cb.checked;
      const { error } = await sb.from(form.dataset.table).insert(row);
      if (error) { toast(error.code === "23505" ? `"${name}" findes allerede` : errMsg(error), "err"); return; }
      input.value = "";
      if (cb) cb.checked = false;
      toast(`"${name}" tilføjet ✓`, "ok");
      loadLookups();
    });
  });

  // ---------------- Kamera-scanner ----------------
  const scanDlg = $("#scanner");
  let scanner = null, scanTarget = null;
  const FORMATS = (typeof Html5QrcodeSupportedFormats !== "undefined") ? [
    "CODE_128", "CODE_39", "CODE_93", "EAN_13", "EAN_8", "UPC_A", "UPC_E",
    "ITF", "CODABAR", "QR_CODE", "DATA_MATRIX"
  ].map((f) => Html5QrcodeSupportedFormats[f]).filter((v) => v !== undefined) : undefined;

  async function openScanner(targetId) {
    scanTarget = targetId;
    scanDlg.showModal();
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
    if (scanDlg.open) scanDlg.close();
  }

  async function onScan(text) {
    const code = cleanCode(text);
    if (!code) return;
    if (navigator.vibrate) navigator.vibrate(80);
    await closeScanner();
    const input = document.getElementById(scanTarget);
    input.value = code;
    switch (scanTarget) {
      case "search-input":
        search(code);
        break;
      case "child-barcode":
        if ($("#child-type").value) $("#child-form").requestSubmit();
        else $("#child-type").focus();
        break;
      case "move-barcode":
        doMove();
        break;
    }
  }

  $$("[data-scan-target]").forEach((b) => b.addEventListener("click", () => openScanner(b.dataset.scanTarget)));
  $("#scanner-close").addEventListener("click", closeScanner);
  scanDlg.addEventListener("cancel", (e) => { e.preventDefault(); closeScanner(); });

  // ---------------- Opstart ----------------
  async function boot() {
    const ok = await loadProfile();
    if (!ok) return;
    route();
    await loadLookups();
    loadRecent();
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  initAuth();
})();
