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
    me: { userId: null, email: "", importerId: null, importerName: "", role: "user", isAdmin: false, mustChange: false },
    types: [],        // {id,name,active,importer_id,can_have_children}
    dealers: [],
    importers: [],    // kun for Rotax (superadmin)
    childParent: null,
    detail: null,
    parts: { offset: 0, items: [] },
    admin: { users: [], importers: [] },
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

  const t = (k, v) => I18N.t(k, v);
  const fmtDate = (iso) => new Date(iso).toLocaleString(I18N.locale(), {
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
    if (!error) return t("err.unknown");
    if (error.code === "P0001") return I18N.dbError(error.message);   // regler fra databasen
    if (error.code === "23505") return t("err.exists");
    if (error.code === "23503") return t("err.inUse");
    if (error.code === "42501") return t("err.noAccess");
    if (/Failed to fetch|NetworkError/i.test(error.message)) return t("err.network");
    return error.message || t("err.unknown");
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
      $("#login-error").textContent = t("login.notConfigured");
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
    if (!loggedIn) $("#view-newpw").hidden = true;
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
        ? t("login.wrong") : errMsg(error);
      $("#login-error").hidden = false;
    }
  });

  async function logout() {
    if (!confirm(t("confirm.logout"))) return;
    await sb.auth.signOut();
  }
  $("#logout-btn").addEventListener("click", logout);
  $("#topbar-logout").addEventListener("click", logout);

  // ---------------- Profil / importør ----------------
  async function loadProfile() {
    // Prøv med de nyeste kolonner først; fald tilbage hvis en migrering endnu ikke er kørt
    let data, error;
    for (const cols of [
      "role, importer_id, is_admin, must_change_password, importers(name)",
      "role, importer_id, is_admin, importers(name)",
      "role, importer_id, importers(name)",
    ]) {
      ({ data, error } = await sb.from("profiles").select(cols).eq("user_id", state.me.userId).maybeSingle());
      if (!error || !/is_admin|must_change_password/.test(error.message)) break;
    }
    if (error) {
      const missing = /profiles|schema cache|does not exist/i.test(error.message);
      if (missing) showBlocker("", "db.update"); else showBlocker(errMsg(error));
      return false;
    }
    state.me.role = data?.role || "user";
    state.me.importerId = data?.importer_id ?? null;
    state.me.importerName = data?.importers?.name || "";
    state.me.isAdmin = !!data?.is_admin;
    state.me.mustChange = !!data?.must_change_password;
    $('.tab[data-route="admin"]').hidden = !state.me.isAdmin;

    if (!state.me.importerId && !isSuper()) {
      showBlocker("", "noimp.text");
      return false;
    }
    if (isSuper()) {
      const { data: imps } = await sb.from("importers").select("id,name").order("name");
      state.importers = imps || [];
      renderImporterFilter();
      $("#filter-importer").hidden = false;
    }
    renderAccount();
    $("#readonly-banner").hidden = canEdit();
    $$(".add-row[data-table]").forEach((f) => (f.hidden = !canEdit()));
    return true;
  }

  function renderImporterFilter() {
    const sel = $("#filter-importer"), v = sel.value;
    sel.innerHTML = `<option value="">${esc(t("filter.allImporters"))}</option>` +
      state.importers.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join("");
    sel.value = v;
  }
  function renderAccount() {
    $("#user-importer").textContent = (state.me.importerName || "–") + (isSuper() ? t("setup.importerSuper") : "");
  }

  function showBlocker(msg, key) {
    $("#no-importer").hidden = false;
    const p = $("#no-importer p");
    if (key) { p.dataset.i18n = key; p.textContent = t(key); }
    else { delete p.dataset.i18n; p.textContent = msg; }
    $$(".view", $("main")).forEach((v) => (v.hidden = true));
    $(".tabs").hidden = true;
  }

  // ---------------- Routing ----------------
  let currentRoute = "home";
  function route() {
    if (!$("#no-importer").hidden) return;
    const r = location.hash.replace(/^#\/?/, "") || "home";
    const routes = ["setup", "parts"].concat(state.me.isAdmin ? ["admin"] : []);
    const name = routes.includes(r) ? r : "home";
    currentRoute = name;
    $("#view-home").hidden = name !== "home";
    $("#view-parts").hidden = name !== "parts";
    $("#view-setup").hidden = name !== "setup";
    $("#view-admin").hidden = name !== "admin";
    $$(".tab").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    if (name === "parts") loadParts(true);
    if (name === "admin") loadAdmin();
    if (name === "setup" && canManageUsers()) loadUsers();
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
    return esc(it.name) + imp + (it.active ? "" : " " + t("inactive"));
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
      ["#create-type", ownTypes(), { placeholder: t("select.type") }],
      ["#create-dealer", ownDealers(), { placeholder: t("select.dealer") }],
      ["#child-type", ownTypes().filter((x) => !x.can_have_children), { placeholder: t("select.type") }],
      ["#filter-type", state.types, { placeholder: t("filter.allTypes"), allInactive: true }],
      ["#filter-dealer", state.dealers, { placeholder: t("filter.allDealers"), allInactive: true }],
    ];
    for (const [sel, items, opts] of sets) {
      const el = $(sel), v = el.value;
      el.innerHTML = optionsHtml(items, opts);
      el.value = v;
    }
    updateCreateHint();
  }

  function updateCreateHint() {
    const ty = typeById(Number($("#create-type").value));
    $("#create-hint").textContent = ty && ty.can_have_children ? t("create.hintParent") : t("create.hint");
  }
  $("#create-type").addEventListener("change", updateCreateHint);

  // ---------------- Rækker ----------------
  function rowHtml(p, { child = false } = {}) {
    const bits = [`<span class="pill">${esc(p.type_name)}</span>${esc(p.dealer_name)}`];
    if (isSuper()) bits.push(`<span class="imp">${esc(p.importer_name)}</span>`);
    if (p.parent_id && !child) bits.push(`<span class="link-ish">${esc(t("row.inParent", { type: p.parent_type_name, code: p.parent_barcode }))}</span>`);
    if (p.child_count > 0) bits.push(`<span class="kids">${esc(t("kids", { n: p.child_count }))}</span>`);
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
    out.innerHTML = `<p class="muted">${t("search.searching")}</p>`;

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
          <h3>${t("search.found")}</h3>
          <dl class="kv">
            <dt>${t("field.barcode")}</dt><dd>${esc(p.barcode)}</dd>
            <dt>${t("field.type")}</dt><dd>${esc(p.type_name)}</dd>
            <dt>${t("field.dealer")}</dt><dd>${esc(p.dealer_name)}</dd>
            <dt>${t("field.registered")}</dt><dd>${fmtDate(p.created_at)}</dd>
            ${isSuper() ? `<dt>${t("field.importer")}</dt><dd>${esc(p.importer_name)}</dd>` : ""}
            ${p.parent_id ? `<dt>${t("field.sitsIn")}</dt><dd><a href="#" data-open="${p.parent_id}">${esc(p.parent_type_name)} ${esc(p.parent_barcode)}</a></dd>` : ""}
            ${p.note ? `<dt>${t("field.note")}</dt><dd>${esc(p.note)}</dd>` : ""}
          </dl>
          ${kids.length ? `<h3 class="sub-head">${t("detail.children")} (${kids.length})</h3><div class="list">${kids.map((k) => rowHtml(k, { child: true })).join("")}</div>` : ""}
          <div class="actions">
            <button type="button" class="btn ghost" data-open="${p.id}">${isOwn(p) ? t("btn.openEdit") : t("btn.open")}</button>
            ${isOwn(p) && p.can_have_children && !p.parent_id ? `<button type="button" class="btn primary" data-kids="${p.id}">${t("detail.scanChildren")}</button>` : ""}
          </div>
        </div>`;
      bindRows(out);
      $$("[data-open]", out).forEach((a) => (a.onclick = (e) => { e.preventDefault(); openDetail(Number(a.dataset.open)); }));
      const kb = $("[data-kids]", out);
      if (kb) kb.onclick = () => openChildPanel(p);
      $("#search-input").select();
      return;
    }

    const createBtn = canEdit() ? `<button type="button" class="btn primary" id="create-from-search">${esc(t("search.createAsNew", { code }))}</button>` : "";
    if (data.length > 0) {
      hideCreate();
      out.innerHTML = `
        <div class="result none">
          <h3>${exact ? t("search.sameCode", { n: data.length }) : t("search.similar", { n: data.length })}</h3>
          <div class="list">${data.map((p) => rowHtml(p)).join("")}</div>
          ${exact ? "" : `<div class="actions">${createBtn}</div>`}
        </div>`;
      bindRows(out);
    } else if (canEdit()) {
      // Ikke fundet: vis opret-formularen direkte med stregkoden udfyldt
      out.innerHTML = `<div class="result none"><h3>${t("search.notRegistered")}</h3>
        <p style="margin:0">${t("search.fillIn", { code: esc(code) })}</p></div>`;
      showCreate(code);
      return;
    } else {
      out.innerHTML = `<div class="result none"><h3>${t("search.notFound")}</h3>
        <p style="margin:0">${t("search.notFoundText", { code: esc(code) })}</p></div>`;
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
    if (!barcode || !type_id || !dealer_id) { toast(t("create.missing"), "err"); return; }

    const btn = e.submitter; btn.disabled = true;
    const { data, error } = await sb.from("parts").insert({ barcode, type_id, dealer_id, note }).select("id").single();
    btn.disabled = false;

    if (error) {
      if (error.code === "23505") {
        toast(t("create.dup"), "err");
        $("#search-input").value = barcode;
        search(barcode);
      } else {
        toast(errMsg(error), "err");
      }
      return;
    }
    resetHome();
    loadRecent();

    const ty = typeById(type_id);
    if (ty && ty.can_have_children) {
      const p = await fetchPart(data.id);
      toast(t("create.savedParent", { type: ty.name }), "ok");
      if (p) openChildPanel(p);
    } else {
      toast(t("create.saved"), "ok");
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
      const guess = ownTypes().find((x) => !x.can_have_children && x.active && /cylind|zylind/i.test(x.name));
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
      : `<p class="empty">${t("child.empty")}</p>`;
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
    if (existing.id === parent.id) { toast(t("child.ownCode"), "err"); return false; }
    if (existing.parent_id === parent.id) { toast(t("child.already"), "err"); return false; }
    const q = existing.parent_id
      ? t("child.confirmMove", { code: existing.barcode, ptype: existing.parent_type_name, pcode: existing.parent_barcode, target: parent.barcode })
      : t("child.confirmAttach", { code: existing.barcode, type: existing.type_name, target: parent.barcode });
    if (!confirm(q)) return false;
    const { error } = await sb.from("parts").update({ parent_id: parent.id }).eq("id", existing.id);
    if (error) { toast(errMsg(error), "err"); return false; }
    toast(existing.parent_id ? t("child.moved") : t("child.attached"), "ok");
    return true;
  }

  $("#child-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const parent = state.childParent;
    if (!parent) return;
    const barcode = cleanCode($("#child-barcode").value);
    const type_id = Number($("#child-type").value);
    if (!barcode || !type_id) { toast(t("child.missing"), "err"); return; }
    if (barcode === parent.barcode) { toast(t("child.ownCode"), "err"); return; }

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
      toast(t("child.added"), "ok");
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
    list.innerHTML = data.length ? data.map((p) => rowHtml(p)).join("") : `<p class="empty">${t("recent.empty")}</p>`;
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
    if (reset) list.innerHTML = `<p class="muted">${t("loading")}</p>`;

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
      ? t("parts.modeGrouped")
      : t("parts.modeFlat");
    list.innerHTML = state.parts.items.length
      ? state.parts.items.map(({ p, kids }) =>
          `<div class="group">${rowHtml(p)}${kids.map((k) => rowHtml(k, { child: true })).join("")}</div>`).join("")
      : `<p class="empty">${t("parts.empty")}</p>`;
    bindRows(list);
    $("#more-btn").hidden = data.length < PAGE;
  }

  $("#more-btn").addEventListener("click", () => loadParts(false));
  ["#filter-type", "#filter-dealer", "#filter-importer"].forEach((s) =>
    $(s).addEventListener("change", () => loadParts(true)));
  let qTimer;
  $("#parts-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => loadParts(true), 300); });

  // ---------------- Excel-eksport ----------------
  const EXCELJS_URL = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  let excelLoading = null;
  function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve();
    return (excelLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = EXCELJS_URL;
      s.onload = resolve;
      s.onerror = () => { excelLoading = null; reject(new Error(t("export.loadFail"))); };
      document.head.appendChild(s);
    }));
  }

  // Lokal tid som "Excel-tid" (Excel kender ikke tidszoner)
  const excelDate = (iso) => {
    const d = new Date(iso);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
  };

  // Hoveddele efterfulgt af deres underdele
  function groupForExport(all) {
    const byId = new Map(all.map((p) => [p.id, p]));
    const kids = new Map();
    for (const p of all) if (p.parent_id && byId.has(p.parent_id)) {
      if (!kids.has(p.parent_id)) kids.set(p.parent_id, []);
      kids.get(p.parent_id).push(p);
    }
    const out = [];
    for (const p of all) {
      if (p.parent_id && byId.has(p.parent_id)) continue;
      out.push(p);
      for (const k of (kids.get(p.id) || []).sort((x, y) => x.barcode.localeCompare(y.barcode))) out.push(k);
    }
    return out;
  }

  $("#export-btn").addEventListener("click", async () => {
    const btn = $("#export-btn");
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = t("loading");
    try {
      const f = partsFilters();
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await applyFilters(sb.from("parts_view").select("*"), f, { grouped: false })
          .order("created_at", { ascending: false }).order("id", { ascending: false })
          .range(from, from + 999);
        if (error) throw new Error(errMsg(error));
        all.push(...data);
        if (data.length < 1000) break;
      }
      if (!all.length) { toast(t("export.none"), "err"); return; }
      await loadExcelJS();

      const rows = groupForExport(all);
      const wb = new ExcelJS.Workbook();
      wb.creator = "Rotax Reservedele";
      wb.created = new Date();
      const ws = wb.addWorksheet(t("export.sheet"), {
        views: [{ state: "frozen", ySplit: 4 }],
        pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
      });

      // Titel og filteroplysninger
      const filterTxt = [
        ["#filter-importer", f.importer], ["#filter-type", f.type], ["#filter-dealer", f.dealer],
      ].filter(([, v]) => v).map(([sel]) => $(sel).selectedOptions[0].textContent);
      if (f.q) filterTxt.push(t("export.contains", { q: f.q }));
      ws.getCell("A1").value = t("export.title");
      ws.getCell("A1").font = { name: "Calibri", bold: true, size: 16, color: { argb: "FFE53138" } };
      ws.getCell("A2").value = [
        isSuper() ? t("export.allImporters") : t("export.importer", { name: state.me.importerName }),
        t("export.exported", { date: fmtDate(new Date().toISOString()) }),
        t("export.count", { n: rows.length }),
        filterTxt.length ? t("export.filter", { list: filterTxt.join(", ") }) : "",
      ].filter(Boolean).join("   ·   ");
      ws.getCell("A2").font = { name: "Calibri", size: 11, color: { argb: "FF555555" } };

      const cols = [
        ...(isSuper() ? [{ name: t("field.importer"), w: 16, get: (p) => p.importer_name }] : []),
        { key: "code", name: t("field.barcode"), w: 22, get: (p) => p.barcode },
        { name: t("field.type"), w: 16, get: (p) => p.type_name },
        { name: t("field.dealer"), w: 24, get: (p) => p.dealer_name },
        { name: t("field.registered"), w: 18, get: (p) => excelDate(p.created_at), fmt: t("export.dateFmt") },
        { name: t("col.level"), w: 13, get: (p) => (p.parent_id ? t("level.child") : p.child_count > 0 ? t("level.parent") : t("level.single")) },
        { name: t("field.sitsIn"), w: 22, get: (p) => p.parent_barcode || "" },
        { name: t("col.childCount"), w: 18, get: (p) => (p.parent_id ? null : p.child_count || 0) },
        { name: t("field.note"), w: 32, get: (p) => p.note || "" },
      ];

      ws.addTable({
        name: "Dele",
        ref: "A4",
        headerRow: true,
        style: { theme: "TableStyleMedium1", showRowStripes: true },
        columns: cols.map((c) => ({ name: c.name, filterButton: true })),
        rows: rows.map((p) => cols.map((c) => c.get(p))),
      });

      cols.forEach((c, i) => {
        const col = ws.getColumn(i + 1);
        col.width = c.w;
        if (c.fmt) rows.forEach((_, r) => (ws.getRow(5 + r).getCell(i + 1).numFmt = c.fmt));
      });
      // Underdele rykkes lidt ind og skrives i grå, så de ses som del af hoveddelen
      const codeCol = cols.findIndex((c) => c.key === "code") + 1;
      rows.forEach((p, i) => {
        if (!p.parent_id) return;
        const r = ws.getRow(5 + i);
        r.getCell(codeCol).alignment = { indent: 2 };
        r.eachCell({ includeEmpty: true }, (cell) => (cell.font = { name: "Calibri", size: 11, color: { argb: "FF666666" } }));
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const imp = isSuper() ? t("export.all") : (state.me.importerName || "").toLowerCase().replace(/[^a-z0-9æøåäöüß]+/gi, "-");
      a.download = `${t("export.filename")}-${imp}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(t("export.done"), "ok");
    } catch (err) {
      toast(err.message || t("export.failed"), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  });

  // ---------------- Detalje / redigér ----------------
  const dlg = $("#detail-dialog");

  async function openDetail(id) {
    const p = await fetchPart(id);
    if (!p) { toast(t("detail.gone"), "err"); afterChange(); return; }
    state.detail = p;
    const own = isOwn(p);

    $("#detail-title").textContent = p.type_name;
    $("#detail-barcode").textContent = p.barcode;
    $("#detail-date").textContent = t("detail.registeredAt", { date: fmtDate(p.created_at) }) + (isSuper() ? ` · ${p.importer_name}` : "");

    // Hoveddel
    const pb = $("#detail-parent");
    if (p.parent_id) {
      pb.hidden = false;
      pb.innerHTML = `
        <div>${t("detail.childOf")} <a href="#" data-open="${p.parent_id}"><strong>${esc(p.parent_type_name)} ${esc(p.parent_barcode)}</strong></a></div>
        ${own ? `<div class="row-actions">
          <button type="button" class="btn ghost small-btn" data-act="move">${t("btn.moveOther")}</button>
          <button type="button" class="btn ghost small-btn" data-act="detach">${t("btn.detach")}</button>
        </div>` : ""}`;
    } else if (own && !p.can_have_children && !p.child_count && ownTypes().some((t) => t.can_have_children)) {
      pb.hidden = false;
      pb.innerHTML = `
        <div class="muted">${t("detail.notAttached")}</div>
        <div class="row-actions"><button type="button" class="btn ghost small-btn" data-act="move">${t("btn.attachToEngine")}</button></div>`;
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
    $("#detail-dealer-note").textContent = t("detail.dealerInherited");
    if (!p.parent_id && p.child_count > 0) {
      $("#detail-dealer-note").hidden = false;
      $("#detail-dealer-note").textContent = t("detail.dealerFollows");
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
        : `<p class="empty">${t("detail.noChildren")}</p>`;
      bindRows($("#detail-children"));
    }

    // Historik
    const { data: moves } = await sb.from("part_moves").select("*").eq("part_id", p.id).order("moved_at", { ascending: false });
    $("#detail-history-wrap").hidden = !(moves && moves.length);
    $("#detail-history").innerHTML = (moves || []).map((m) => {
      const from = m.from_parent_id ? esc(m.from_parent_barcode || t("hist.deletedParent")) : null;
      const to = m.to_parent_id ? esc(m.to_parent_barcode || "?") : null;
      const txt = from && to ? t("hist.moved", { from, to })
        : to ? t("hist.attached", { to }) : t("hist.detached", { from });
      return `<li><span class="muted">${fmtDate(m.moved_at)}</span> ${txt}</li>`;
    }).join("");

    // Knapper
    $("#detail-delete").hidden = !own;
    $("#detail-save").hidden = !own;
    $("#detail-cancel").textContent = own ? t("btn.cancel") : t("btn.close");

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
    if (!code) { toast(t("move.missing"), "err"); return; }
    const target = await findOwnByBarcode(code);
    if (!target) { toast(t("move.notReg", { code }), "err"); return; }
    if (target.id === p.id) { toast(t("move.self"), "err"); return; }
    if (target.id === p.parent_id) { toast(t("move.already"), "err"); return; }
    if (!target.can_have_children) { toast(t("move.typeNo", { type: target.type_name }), "err"); return; }
    if (target.parent_id) { toast(t("move.targetIsChild"), "err"); return; }
    const { error } = await sb.from("parts").update({ parent_id: target.id }).eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    toast(p.parent_id ? t("move.movedTo", { code: target.barcode }) : t("move.attachedTo", { code: target.barcode }), "ok");
    afterChange();
    openDetail(p.id);
  }

  async function detach() {
    const p = state.detail;
    if (!confirm(t("detach.confirm", { code: p.barcode, parent: p.parent_barcode }))) return;
    const { error } = await sb.from("parts").update({ parent_id: null }).eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    toast(t("detach.done"), "ok");
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
    toast(t("detail.saved"), "ok");
    afterChange();
  });

  $("#detail-delete").onclick = async () => {
    const p = state.detail;
    const extra = p.child_count > 0 ? t("delete.childrenNote", { n: String(p.child_count) }) : "";
    if (!confirm(t("delete.confirm", { code: p.barcode, extra }))) return;
    const { error } = await sb.from("parts").delete().eq("id", p.id);
    if (error) { toast(errMsg(error), "err"); return; }
    dlg.close();
    if (state.childParent && state.childParent.id === p.id) closeChildPanel();
    toast(t("delete.done"), "ok");
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
          <span class="name">${esc(it.name)}${it.can_have_children ? ` <span class="badge">${t("setup.badge")}</span>` : ""}</span>
          ${edit ? `<span class="li-actions">
            ${table === "part_types" ? `<button class="btn ghost icon-btn" data-act="children">${it.can_have_children ? t("setup.removeChildren") : t("setup.allowChildren")}</button>` : ""}
            <button class="btn ghost icon-btn" data-act="rename">${t("btn.rename")}</button>
            <button class="btn ghost icon-btn" data-act="toggle">${it.active ? t("btn.hide") : t("btn.activate")}</button>
            <button class="btn danger icon-btn" data-act="delete">${t("btn.delete")}</button>
          </span>` : ""}
        </li>`).join("") : `<li class="empty">${t("setup.none")}${edit ? t("setup.addAbove") : ""}.</li>`;
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
      const name = prompt(t("setup.newName"), item.name);
      if (!name || !name.trim() || name.trim() === item.name) return;
      res = await sb.from(table).update({ name: name.trim() }).eq("id", id);
    } else if (act === "toggle") {
      res = await sb.from(table).update({ active: !item.active }).eq("id", id);
    } else if (act === "children") {
      if (item.can_have_children && !confirm(t("setup.confirmRemoveChildren", { name: item.name }))) return;
      res = await sb.from(table).update({ can_have_children: !item.can_have_children }).eq("id", id);
    } else if (act === "delete") {
      if (!confirm(t("setup.confirmDelete", { name: item.name }))) return;
      res = await sb.from(table).delete().eq("id", id);
      if (res.error && res.error.code === "23503") {
        toast(t("setup.inUse", { name: item.name }), "err");
        return;
      }
    }
    if (res.error) { toast(errMsg(res.error), "err"); return; }
    await loadLookups();
    if (act !== "toggle") afterChange();
  }

  $$(".add-row[data-table]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("input[type=text]", form);
      const name = input.value.trim();
      if (!name) return;
      const row = { name };
      const cb = $("input[name=children]", form);
      if (cb) row.can_have_children = cb.checked;
      const { error } = await sb.from(form.dataset.table).insert(row);
      if (error) { toast(error.code === "23505" ? t("setup.exists", { name }) : errMsg(error), "err"); return; }
      input.value = "";
      if (cb) cb.checked = false;
      toast(t("setup.added", { name }), "ok");
      loadLookups();
    });
  });

  // ---------------- Admin ----------------
  async function loadAdmin() {
    const [u, i] = await Promise.all([sb.rpc("admin_list_users"), sb.rpc("admin_list_importers")]);
    if (u.error || i.error) { toast(errMsg(u.error || i.error), "err"); return; }
    state.admin.users = u.data || [];
    state.admin.importers = i.data || [];
    renderAdmin();
  }

  const isUnassigned = (u) => !u.importer_id && u.role !== "superadmin";

  function renderAdmin() {
    const { users, importers } = state.admin;
    const missing = users.filter(isUnassigned).length;
    const badge = $("#admin-unassigned");
    badge.hidden = !missing;
    badge.textContent = t("admin.unassigned", { n: missing });

    const only = $("#admin-only-unassigned").checked;
    const list = only ? users.filter(isUnassigned) : users;
    const impOpts = (sel) => `<option value="">${esc(t("admin.noImporter"))}</option>` +
      importers.map((i) => `<option value="${i.id}"${i.id === sel ? " selected" : ""}>${esc(i.name)}${i.country ? ` (${esc(i.country)})` : ""}</option>`).join("");

    $("#admin-users").innerHTML = list.length ? list.map((u) => {
      const me = u.user_id === state.me.userId;
      const role = ["superadmin", "admin"].includes(u.role) ? u.role : "user";
      return `<div class="admin-user${isUnassigned(u) ? " missing" : ""}" data-user="${u.user_id}">
        <div class="admin-user-head">
          <strong class="email">${esc(u.email)} ${me ? `<span class="muted small">${t("admin.you")}</span>` : ""}</strong>
          <span class="muted small">${u.last_sign_in_at ? esc(t("admin.lastLogin", { date: fmtDate(u.last_sign_in_at) })) : t("admin.neverLogin")}</span>
        </div>
        <div class="admin-user-ctrl">
          <select data-f="importer" aria-label="${esc(t("field.importer"))}">${impOpts(u.importer_id)}</select>
          <select data-f="role">
            <option value="user"${role === "user" ? " selected" : ""}>${t("admin.roleUser")}</option>
            <option value="admin"${role === "admin" ? " selected" : ""}>${t("users.roleImpAdmin")}</option>
            <option value="superadmin"${role === "superadmin" ? " selected" : ""}>${t("admin.roleSuper")}</option>
          </select>
          <label class="check"><input type="checkbox" data-f="admin"${u.is_admin ? " checked" : ""}${me ? " disabled" : ""}> ${t("admin.isAdmin")}</label>
        </div>
        ${me ? "" : `<div class="row-actions admin-user-actions">
          <button type="button" class="btn ghost icon-btn" data-a="reset">${t("users.resend")}</button>
          <button type="button" class="btn danger icon-btn" data-a="delete">${t("users.remove")}</button>
        </div>`}
      </div>`;
    }).join("") : `<p class="empty">${t("admin.noUsers")}</p>`;

    const aui = $("#admin-user-importer"), auiV = aui.value;
    aui.innerHTML = `<option value="">${esc(t("admin.noImporter"))}</option>` +
      importers.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join("");
    aui.value = auiV;

    $("#admin-importers").innerHTML = importers.length ? importers.map((i) => `
      <li data-id="${i.id}">
        <span class="name">${esc(i.name)}${i.country ? ` <span class="muted">(${esc(i.country)})</span>` : ""}
          <span class="muted small imp-stats">${esc(t("admin.stats", { users: i.users, parts: i.parts }))}</span></span>
        <span class="li-actions">
          <button class="btn ghost icon-btn" data-act="rename">${t("btn.rename")}</button>
          <button class="btn danger icon-btn" data-act="delete">${t("btn.delete")}</button>
        </span>
      </li>`).join("") : `<li class="empty">${t("setup.none")}.</li>`;
  }

  $("#admin-only-unassigned").addEventListener("change", renderAdmin);

  // Admin: send ny kode / fjern bruger (alle importører)
  $("#admin-users").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-a]");
    if (!btn) return;
    const row = btn.closest(".admin-user");
    const userId = row.dataset.user;
    const email = (state.admin.users.find((u) => u.user_id === userId) || {}).email || "";
    if (btn.dataset.a === "reset") {
      if (!confirm(t("users.confirmResend", { email }))) return;
      btn.disabled = true;
      const { data, code } = await usersFn({ action: "reset", user_id: userId });
      btn.disabled = false;
      if (code) { toast(usersErr(code), "err"); return; }
      if (data.emailed) toast(t("users.resent", { email }), "ok"); else showTempCode(email, data.temp_password);
    } else {
      if (!confirm(t("users.confirmRemove", { email }))) return;
      btn.disabled = true;
      const { code } = await usersFn({ action: "delete", user_id: userId });
      if (code) { btn.disabled = false; toast(usersErr(code), "err"); return; }
      toast(t("users.removed"), "ok");
    }
    loadAdmin();
  });
  $("#admin-refresh").addEventListener("click", loadAdmin);

  $("#admin-users").addEventListener("change", async (e) => {
    const el = e.target.closest("[data-f]");
    if (!el) return;
    const row = el.closest(".admin-user");
    const userId = row.dataset.user;
    const me = userId === state.me.userId;
    let res;
    if (el.dataset.f === "admin") {
      res = await sb.rpc("admin_set_admin", { p_user: userId, p_is_admin: el.checked });
    } else {
      const imp = $('[data-f="importer"]', row).value;
      res = await sb.rpc("admin_set_user", {
        p_user: userId, p_importer: imp ? Number(imp) : null, p_role: $('[data-f="role"]', row).value,
      });
    }
    if (res.error) { toast(errMsg(res.error), "err"); loadAdmin(); return; }
    if (me && el.dataset.f !== "admin") {
      toast(t("admin.reloadSelf"), "ok");
      setTimeout(() => location.reload(), 1200);
      return;
    }
    toast(t("admin.saved"), "ok");
    loadAdmin();
  });

  $("#admin-importer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#admin-imp-name").value.trim();
    const country = $("#admin-imp-country").value.trim().toUpperCase() || null;
    const firstEmail = $("#admin-imp-email").value.trim();
    if (!name) return;
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      const { data, error } = await sb.from("importers").insert({ name, country }).select("id").single();
      if (error) { toast(error.code === "23505" ? t("setup.exists", { name }) : errMsg(error), "err"); return; }
      $("#admin-imp-name").value = "";
      $("#admin-imp-country").value = "";
      $("#admin-imp-email").value = "";
      toast(t("setup.added", { name }), "ok");
      if (firstEmail) await createUser({ email: firstEmail, role: "admin", importer_id: data.id });
      loadAdmin();
    } finally { if (btn) btn.disabled = false; }
  });

  $("#admin-importers").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.closest("li").dataset.id);
    const imp = state.admin.importers.find((x) => x.id === id);
    let res;
    if (btn.dataset.act === "rename") {
      const name = prompt(t("setup.newName"), imp.name);
      if (!name || !name.trim() || name.trim() === imp.name) return;
      res = await sb.from("importers").update({ name: name.trim() }).eq("id", id);
    } else {
      if (!confirm(t("setup.confirmDelete", { name: imp.name }))) return;
      res = await sb.from("importers").delete().eq("id", id);
      if (res.error && res.error.code === "23503") { toast(t("admin.importerInUse", { name: imp.name }), "err"); return; }
    }
    if (res.error) { toast(errMsg(res.error), "err"); return; }
    loadAdmin();
  });

  // ---------------- Brugere (importør-admin) ----------------
  const canManageUsers = () =>
    !!state.me.importerId && (state.me.role === "admin" || state.me.isAdmin);

  // Kald Edge Function "manage-users". Returnerer { data } eller { code }.
  async function usersFn(body) {
    try {
      const { data, error } = await sb.functions.invoke(cfg.USERS_FUNCTION || "manage-users", { body: { ...body, lang: I18N.lang() } });
      if (!error) return { data };
      let code = null;
      try { code = (await error.context.json()).error || null; } catch {}
      // Intet svar fra vores egen funktion → den findes ikke (endnu) i Supabase
      if (!code) code = error.name === "FunctionsFetchError" || error.context?.status === 404 ? "not_deployed" : "failed";
      return { code };
    } catch {
      return { code: "not_deployed" };
    }
  }
  const usersErr = (code) => t("users.err." + code) !== "users.err." + code ? t("users.err." + code) : t("users.err.failed");

  function showTempCode(email, code) {
    const d = $("#code-dialog");
    $("#code-msg").textContent = t("users.mailFailed", { email });
    $("#code-value").textContent = code;
    d.showModal();
  }
  $("#code-close").onclick = () => $("#code-dialog").close();
  $("#code-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#code-value").textContent); toast(t("users.copied"), "ok"); } catch {}
  };

  async function createUser({ email, role, importer_id }) {
    const { data, code } = await usersFn({ action: "create", email, role, importer_id });
    if (code) { toast(usersErr(code), "err"); return false; }
    if (data.emailed) toast(t("users.created", { email }), "ok");
    else showTempCode(email, data.temp_password);
    return true;
  }

  let usersList = [];
  async function loadUsers() {
    if (!canManageUsers()) return;
    $("#users-card").hidden = false;
    const { data, error } = await sb.rpc("importer_list_users");
    if (error) {
      // 004 ikke kørt endnu → skjul sektionen
      if (/importer_list_users|schema cache|does not exist/i.test(error.message)) $("#users-card").hidden = true;
      else toast(errMsg(error), "err");
      return;
    }
    usersList = data || [];
    renderUsers();
  }

  function renderUsers() {
    $("#users-help").textContent = t("users.help", { importer: state.me.importerName });
    $("#users-list").innerHTML = usersList.map((u) => {
      const me = u.user_id === state.me.userId;
      const locked = me || u.is_admin;            // egen bruger og app-admins røres ikke her
      const status = u.must_change_password ? `<span class="pending">${t("users.pending")}</span>`
        : u.last_sign_in_at ? esc(t("admin.lastLogin", { date: fmtDate(u.last_sign_in_at) })) : t("admin.neverLogin");
      return `<li data-user="${u.user_id}" data-email="${esc(u.email)}">
        <span class="name"><span class="email">${esc(u.email)}</span> ${me ? `<span class="muted small">${t("admin.you")}</span>` : ""}
          <span class="muted small imp-stats">${status}</span></span>
        <span class="li-actions">
          <select class="role-select" data-act="role"${locked ? " disabled" : ""}>
            <option value="user"${u.role !== "admin" ? " selected" : ""}>${t("users.roleUser")}</option>
            <option value="admin"${u.role === "admin" ? " selected" : ""}>${t("users.roleImpAdmin")}</option>
          </select>
          ${locked ? "" : `<button class="btn ghost icon-btn" data-act="reset">${t("users.resend")}</button>
          <button class="btn danger icon-btn" data-act="delete">${t("users.remove")}</button>`}
        </span>
      </li>`;
    }).join("") || `<li class="empty">${t("admin.noUsers")}</li>`;
  }

  $("#users-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#users-email").value.trim();
    if (!email) return;
    const btn = e.submitter; btn.disabled = true; const label = btn.textContent; btn.textContent = t("users.working");
    const ok = await createUser({ email, role: $("#users-role").value, importer_id: state.me.importerId });
    btn.disabled = false; btn.textContent = label;
    if (ok) { $("#users-email").value = ""; $("#users-role").value = "user"; loadUsers(); }
  });

  $("#users-list").addEventListener("change", async (e) => {
    const sel = e.target.closest('select[data-act="role"]');
    if (!sel) return;
    const li = sel.closest("li");
    const { error } = await sb.rpc("importer_set_role", { p_user: li.dataset.user, p_role: sel.value });
    if (error) toast(errMsg(error), "err"); else toast(t("admin.saved"), "ok");
    loadUsers();
  });

  $("#users-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const li = btn.closest("li");
    const email = li.dataset.email, userId = li.dataset.user;
    if (btn.dataset.act === "reset") {
      if (!confirm(t("users.confirmResend", { email }))) return;
      btn.disabled = true;
      const { data, code } = await usersFn({ action: "reset", user_id: userId });
      btn.disabled = false;
      if (code) { toast(usersErr(code), "err"); return; }
      if (data.emailed) toast(t("users.resent", { email }), "ok"); else showTempCode(email, data.temp_password);
    } else if (btn.dataset.act === "delete") {
      if (!confirm(t("users.confirmRemove", { email }))) return;
      btn.disabled = true;
      const { code } = await usersFn({ action: "delete", user_id: userId });
      if (code) { btn.disabled = false; toast(usersErr(code), "err"); return; }
      toast(t("users.removed"), "ok");
    }
    loadUsers();
  });

  // Admin: opret bruger hos en vilkårlig importør
  $("#admin-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#admin-user-email").value.trim();
    const importer_id = Number($("#admin-user-importer").value);
    if (!importer_id) { toast(usersErr("importer_required"), "err"); return; }
    const btn = e.submitter; btn.disabled = true;
    const ok = await createUser({ email, role: $("#admin-user-role").value, importer_id });
    btn.disabled = false;
    if (ok) { $("#admin-user-email").value = ""; loadAdmin(); }
  });

  // ---------------- Ny adgangskode (efter midlertidig kode) ----------------
  function askNewPassword() {
    return new Promise((resolve) => {
      $("#app").hidden = true;
      $("#view-newpw").hidden = false;
      $("#newpw-user").value = state.me.email;
      $("#newpw-1").focus();
      const form = $("#newpw-form");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const err = $("#newpw-error");
        const p1 = $("#newpw-1").value, p2 = $("#newpw-2").value;
        err.hidden = true;
        if (p1.length < 8) { err.textContent = t("newpw.short"); err.hidden = false; return; }
        if (p1 !== p2) { err.textContent = t("newpw.mismatch"); err.hidden = false; return; }
        const btn = e.submitter; btn.disabled = true;
        const { error } = await sb.auth.updateUser({ password: p1 });
        if (error) {
          btn.disabled = false;
          err.textContent = /different/i.test(error.message) ? t("newpw.same") : errMsg(error);
          err.hidden = false;
          return;
        }
        await sb.rpc("clear_must_change_password");
        btn.disabled = false;
        state.me.mustChange = false;
        $("#newpw-1").value = $("#newpw-2").value = "";
        $("#view-newpw").hidden = true;
        $("#app").hidden = false;
        toast(t("newpw.saved"), "ok");
        resolve();
      };
    });
  }

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
    $("#scanner-msg").textContent = t("scanner.starting");
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
      $("#scanner-msg").textContent = t("scanner.hold");
    } catch (err) {
      $("#scanner-msg").textContent = t("scanner.fail");
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
  let ready = false;
  async function boot() {
    const ok = await loadProfile();
    if (!ok) return;
    if (state.me.mustChange) await askNewPassword();
    route();
    await loadLookups();
    loadRecent();
    if (canManageUsers()) loadUsers();
    ready = true;
  }

  // Sprogskift: tegn alt dynamisk indhold igen på det nye sprog
  window.addEventListener("langchange", () => {
    if (!ready) return;
    if (isSuper()) renderImporterFilter();
    renderAccount();
    renderDropdowns();
    renderSetupLists();
    loadRecent();
    if (currentRoute === "parts") loadParts(true);
    if (cleanCode($("#search-input").value)) search($("#search-input").value);
    if (state.childParent) openChildPanel(state.childParent);
    if (dlg.open && state.detail) openDetail(state.detail.id);
    if (currentRoute === "admin") renderAdmin();
    if (canManageUsers()) renderUsers();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  initAuth();
})();
