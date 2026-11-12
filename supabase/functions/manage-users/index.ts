// Supabase Edge Function: manage-users
// Opretter, nulstiller og fjerner login-brugere for Rotax Reservedele.
//
//   POST { action: "create", email, role: "user"|"admin", importer_id?, lang? }
//   POST { action: "reset",  user_id, lang? }
//   POST { action: "delete", user_id }
//
// Adgang:
//   * App-admin (profiles.is_admin)          – alle importører
//   * Importør-admin (profiles.role='admin') – kun egen importør
//
// Secrets (Edge Functions → Secrets):
//   RESEND_API_KEY  – API-nøgle fra resend.com (krævet for at sende mails)
//   MAIL_FROM       – afsender, fx  Rotax Parts <noreply@nha-automation.dk>
//   APP_URL         – (valgfri) appens adresse til linket i mailen

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys.default) return keys.default;
    const first = Object.values(keys)[0];
    if (typeof first === "string" && first) return first;
  } catch { /* fald tilbage til legacy-nøglen */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

// Midlertidig kode, fx "Kx7m-Qa3P-v9Td" (ingen forvekslelige tegn som 0/O, 1/l)
function tempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  let s = "";
  for (const n of buf) s += chars[n % chars.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

type Lang = "da" | "en" | "de";
const MAIL: Record<Lang, Record<string, string>> = {
  da: {
    subjectNew: "Din adgang til Rotax Parts",
    subjectReset: "Ny midlertidig kode til Rotax Parts",
    hello: "Hej",
    intro: "Der er oprettet en bruger til dig i Rotax Parts hos {importer}.",
    introReset: "Der er lavet en ny midlertidig kode til din bruger i Rotax Parts.",
    login: "Log ind med",
    email: "E-mail",
    code: "Midlertidig kode",
    open: "Åbn Rotax Parts",
    change: "Første gang du logger ind, bliver du bedt om at vælge din egen adgangskode.",
  },
  en: {
    subjectNew: "Your access to Rotax Parts",
    subjectReset: "New temporary code for Rotax Parts",
    hello: "Hello",
    intro: "A user has been created for you in Rotax Parts at {importer}.",
    introReset: "A new temporary code has been created for your Rotax Parts user.",
    login: "Sign in with",
    email: "Email",
    code: "Temporary code",
    open: "Open Rotax Parts",
    change: "The first time you sign in, you will be asked to choose your own password.",
  },
  de: {
    subjectNew: "Ihr Zugang zu Rotax Parts",
    subjectReset: "Neuer vorläufiger Code für Rotax Parts",
    hello: "Hallo",
    intro: "Für Sie wurde bei {importer} ein Benutzer in Rotax Parts angelegt.",
    introReset: "Für Ihren Benutzer in Rotax Parts wurde ein neuer vorläufiger Code erstellt.",
    login: "Anmelden mit",
    email: "E-Mail",
    code: "Vorläufiger Code",
    open: "Rotax Parts öffnen",
    change: "Bei der ersten Anmeldung werden Sie gebeten, ein eigenes Passwort zu wählen.",
  },
};

async function sendMail(opts: { to: string; password: string; importer: string; lang: Lang; reset: boolean; appUrl: string }) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return false;
  const from = Deno.env.get("MAIL_FROM") ?? "Rotax Parts <noreply@nha-automation.dk>";
  const m = MAIL[opts.lang];
  const intro = (opts.reset ? m.introReset : m.intro).replace("{importer}", opts.importer);
  const link = opts.appUrl
    ? `<p style="margin:24px 0"><a href="${esc(opts.appUrl)}" style="background:#e53138;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${m.open}</a></p>`
    : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#111;max-width:520px">
    <p style="color:#e53138;font-size:22px;font-weight:bold;margin:0 0 16px">ROTAX <span style="color:#111">Parts</span></p>
    <p>${m.hello},</p>
    <p>${esc(intro)}</p>
    <p>${m.login}:</p>
    <table style="border-collapse:collapse;margin:8px 0 4px">
      <tr><td style="padding:4px 16px 4px 0;color:#555">${m.email}</td><td style="padding:4px 0"><b>${esc(opts.to)}</b></td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#555">${m.code}</td><td style="padding:4px 0;font-family:Consolas,monospace;font-size:20px"><b>${esc(opts.password)}</b></td></tr>
    </table>
    ${link}
    <p style="color:#555">${m.change}</p>
  </div>`;
  const text = `${m.hello},\n\n${intro}\n\n${m.email}: ${opts.to}\n${m.code}: ${opts.password}\n${opts.appUrl ? "\n" + opts.appUrl + "\n" : ""}\n${m.change}\n`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [opts.to], subject: opts.reset ? m.subjectReset : m.subjectNew, html, text }),
    });
    if (!res.ok) console.error("Resend:", res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error("Resend:", e);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "bad_request" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Hvem kalder?
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
  if (whoErr || !who?.user) return json({ error: "not_authenticated" }, 401);
  const caller = who.user;

  const { data: cp } = await admin.from("profiles")
    .select("role, importer_id, is_admin").eq("user_id", caller.id).maybeSingle();
  const isAppAdmin = !!cp?.is_admin;
  const isImpAdmin = cp?.role === "admin" && !!cp?.importer_id;
  if (!isAppAdmin && !isImpAdmin) return json({ error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const lang: Lang = ["da", "en", "de"].includes(body.lang as string) ? body.lang as Lang : "en";
  const appUrl = Deno.env.get("APP_URL") ?? req.headers.get("origin") ?? "";

  const importerName = async (id: number) =>
    (await admin.from("importers").select("name").eq("id", id).maybeSingle()).data?.name ?? "";

  // Må kalderen administrere denne bruger?
  async function loadTarget(userId: string) {
    const { data: tp } = await admin.from("profiles")
      .select("role, importer_id, is_admin").eq("user_id", userId).maybeSingle();
    // App-admin må også håndtere brugere uden profil/importør
    if (!tp) return isAppAdmin ? { role: null, importer_id: null, is_admin: false } : null;
    if (!isAppAdmin) {
      if (tp.importer_id !== cp!.importer_id || tp.role === "superadmin" || tp.is_admin) return null;
    }
    return tp;
  }

  try {
    switch (body.action) {
      // ---------------------------------------------------------------- CREATE
      case "create": {
        const email = String(body.email ?? "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);
        const role = body.role === "admin" ? "admin" : "user";
        // App-admin kan vælge importør; ellers (eller hvis ingen er valgt) bruges kalderens egen
        const importerId = (isAppAdmin && Number(body.importer_id)) || cp!.importer_id;
        if (!importerId) return json({ error: "importer_required" }, 400);
        const impName = await importerName(importerId);
        if (!impName) return json({ error: "importer_required" }, 400);

        const password = tempPassword();
        const { data: created, error: cErr } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
        });
        if (cErr || !created?.user) {
          const exists = /already|exists|registered/i.test(cErr?.message ?? "") || (cErr as { code?: string })?.code === "email_exists";
          return json({ error: exists ? "exists" : "failed", detail: cErr?.message }, exists ? 409 : 500);
        }
        const { error: pErr } = await admin.from("profiles").upsert({
          user_id: created.user.id, importer_id: importerId, role, must_change_password: true,
        });
        if (pErr) {
          await admin.auth.admin.deleteUser(created.user.id);
          return json({ error: "failed", detail: pErr.message }, 500);
        }
        const emailed = await sendMail({ to: email, password, importer: impName, lang, reset: false, appUrl });
        return json({ ok: true, user_id: created.user.id, emailed, ...(emailed ? {} : { temp_password: password }) });
      }

      // ----------------------------------------------------------------- RESET
      case "reset": {
        const userId = String(body.user_id ?? "");
        const tp = await loadTarget(userId);
        if (!tp) return json({ error: "not_found" }, 404);
        const { data: tu } = await admin.auth.admin.getUserById(userId);
        if (!tu?.user?.email) return json({ error: "not_found" }, 404);
        const password = tempPassword();
        const { error: uErr } = await admin.auth.admin.updateUserById(userId, { password });
        if (uErr) return json({ error: "failed", detail: uErr.message }, 500);
        await admin.from("profiles").update({ must_change_password: true }).eq("user_id", userId);
        const emailed = await sendMail({
          to: tu.user.email, password, importer: tp.importer_id ? await importerName(tp.importer_id) : "", lang, reset: true, appUrl,
        });
        return json({ ok: true, emailed, ...(emailed ? {} : { temp_password: password }) });
      }

      // ---------------------------------------------------------------- DELETE
      case "delete": {
        const userId = String(body.user_id ?? "");
        if (userId === caller.id) return json({ error: "self" }, 400);
        const tp = await loadTarget(userId);
        if (!tp) return json({ error: "not_found" }, 404);
        const { error: dErr } = await admin.auth.admin.deleteUser(userId);
        if (dErr) return json({ error: "failed", detail: dErr.message }, 500);
        return json({ ok: true });
      }

      default:
        return json({ error: "bad_request" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: "failed", detail: String(e) }, 500);
  }
});
