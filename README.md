# Rotax Reservedele

PWA til registrering af reservedele med stregkode. Kører på iOS, Android og Windows (installérbar fra browseren).
Frontend: ren HTML/CSS/JS hostet på GitHub Pages. Backend: Supabase (Postgres + login).

## Funktioner
- **Forside**
  - Søg på stregkode: scan med kamera, brug USB-/Bluetooth-scanner eller skriv manuelt
  - Opret ny komponent: stregkode, type, forhandler, valgfri note. Dato/tid sættes automatisk af serveren
  - **Underdele:** gemmer du en del, hvis type "kan have underdele" (fx Motor), åbner et panel hvor du scanner cylinder, plombe osv. ind under den
  - De 5 seneste registreringer
- **Dele**
  - Alle importørens dele, med underdele vist under deres hoveddel
  - Søg i stregkoder, filtrér på type og forhandler, eksportér til Excel (formateret tabel med filtre)
- **Detaljer** (klik på en del)
  - Redigér type, forhandler og note
  - Flyt en underdel til en anden motor, løsn den, eller kobl en løs del på en motor
  - Historik over flytninger
- **Setup**
  - Typer og forhandlere: tilføj, omdøb, skjul, slet
  - Markér hvilke typer der kan have underdele

### Regler for underdele
- En underdel arver **forhandler og dato** fra hoveddelen (den sælges som en samlet pakke)
- Ændres forhandleren på hoveddelen, følger alle underdele med
- To niveauer: en underdel kan ikke selv have underdele
- Slettes en hoveddel, bliver underdelene løsnet (ikke slettet)
- Scanner du en stregkode der allerede findes, tilbyder appen at koble/flytte den eksisterende del

### Sprog
- Engelsk, dansk og tysk
- Første gang følger appen telefonens/computerens sprog (ellers engelsk). Sproget kan skiftes i topbjælken, på login-siden og under Setup → Konto, og valget huskes på enheden
- Alle tekster ligger i `i18n.js`. Nyt sprog: kopiér `en`-blokken, oversæt og tilføj sprogkoden i `SUPPORTED` og `LOCALES`
- Typer og forhandlere er importørens egne navne og oversættes ikke

### Importører
- Hver bruger hører til én importør og ser **kun** sin egen importørs typer, forhandlere og dele
- Det håndhæves i databasen (RLS), ikke kun i appen
- Stregkoder er unikke pr. importør
- Rotax-brugere (rolle `superadmin`) kan se alle importørers dele, men ikke oprette eller rette

## Opdatering fra version 1 (eksisterende installation)
1. Supabase → **SQL Editor → New query** → indsæt hele `supabase/002-importoerer-og-underdele.sql` → **Run**
   - Alle eksisterende data og brugere tilknyttes automatisk importøren **Danmark**
   - Typer der hedder "Motor" får automatisk "Kan have underdele"
2. Upload alle filer til GitHub (config.js med dine nøgler er med)

## Ny installation
1. Kør `supabase/schema.sql` og derefter `supabase/002-importoerer-og-underdele.sql`
2. Slå *Allow new users to sign up* fra under Authentication
3. Udfyld `config.js` og upload til GitHub Pages

## Brugere og roller
| Rolle | Kan |
|---|---|
| Bruger | Scanne, oprette og rette dele hos sin importør |
| Importør-admin | Som bruger + oprette, nulstille og fjerne brugere hos sin egen importør (Setup → Brugere) |
| Rotax (ser alle) | Se alle importørers dele, ikke rette |
| Admin (flueben) | Fanen Admin: importører og brugere hos alle importører |

**Ny bruger:** oprettes i appen (Setup → Brugere eller Admin). Brugeren får en mail med en midlertidig kode
og skal vælge sin egen adgangskode ved første login. Kan mailen ikke sendes, vises koden i stedet, så den kan gives videre.

**Ny importør:** Admin → Importører. Udfyld evt. "Første bruger", så oprettes importørens importør-admin samtidig.

## Opsætning af brugeroprettelse (én gang)
1. Kør `supabase/003-admin.sql` (ret e-mailen nederst) og `supabase/004-brugeradmin.sql` i SQL Editor
2. **Edge Function:** Supabase → Edge Functions → *Deploy a new function* → *Via Editor*
   - Navn: `manage-users`
   - Indsæt hele `supabase/functions/manage-users/index.ts` → *Deploy*
3. **Resend:** opret en API-nøgle på resend.com (afsenderdomænet skal være verificeret i Resend)
4. **Secrets:** Supabase → Edge Functions → *Secrets* → tilføj
   - `RESEND_API_KEY` = nøglen fra Resend
   - `MAIL_FROM` = fx `Rotax Parts <noreply@nha-automation.dk>`
   - `APP_URL` = appens adresse (link i mailen)

Uden `RESEND_API_KEY` virker alt stadig – koden vises bare på skærmen i stedet for at blive mailet.

## Installér som app
- **iOS (Safari):** Del → *Føj til hjemmeskærm*
- **Android (Chrome):** menu → *Installér app*
- **Windows (Edge/Chrome):** installér-ikonet i adresselinjen

## Opdatering af appen
Ved ændringer i filerne: hæv `VERSION` i `sw.js` og `?v=` på styles.css, i18n.js, config.js og app.js i `index.html` (samme tal). Så henter alle enheder den nye version med det samme.

## Filer
| Fil | Indhold |
|---|---|
| `index.html` | Forside, Dele, Setup, login, scanner og detaljedialog |
| `app.js` | Al logik (Supabase, scanner, søgning, underdele, setup) |
| `i18n.js` | Oversættelser (engelsk, dansk, tysk) |
| `styles.css` | Rotax-farver, stor og tydelig tekst |
| `config.js` | Supabase-nøgler |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |
| `supabase/schema.sql` | Grundtabeller (version 1) |
| `supabase/002-importoerer-og-underdele.sql` | Importører, underdele, historik og adgangsregler |
| `supabase/003-admin.sql` | Admin-adgang og admin-funktioner |
| `supabase/004-brugeradmin.sql` | Importør-admin og midlertidige koder |
| `supabase/functions/manage-users/index.ts` | Edge Function der opretter/nulstiller/fjerner brugere og sender mail |
