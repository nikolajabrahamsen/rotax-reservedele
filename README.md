# Rotax Reservedele

PWA til registrering af reservedele med stregkode. Kører på iOS, Android og Windows (installérbar fra browseren).
Frontend: ren HTML/CSS/JS hostet på GitHub Pages. Backend: Supabase (Postgres + login).

## Funktioner
- **Forside**
  - Søg på stregkode – scan med kamera, brug USB-/Bluetooth-scanner eller skriv manuelt (eksakt match, ellers delvis match)
  - Opret ny komponent: stregkode (scan/skriv), type, forhandler, valgfri note
  - Dato/tid sættes automatisk af serveren ved gem
  - Seneste registreringer med filter på type/forhandler, klik for at redigere/slette
  - Eksport til CSV (åbner direkte i dansk Excel)
- **Setup**
  - Tilføj, omdøb, skjul/aktivér og slet typer og forhandlere
  - Typer/forhandlere der er brugt kan ikke slettes, kun skjules (historikken bevares)

Hver stregkode kan kun registreres én gang. Skal samme stregkode kunne leveres flere gange, fjernes linjen med `parts_barcode_uq` i `supabase/schema.sql`.

## Opsætning

### 1. Supabase
1. Opret et nyt projekt på supabase.com (region: EU / Frankfurt)
2. **SQL Editor → New query** → indsæt hele `supabase/schema.sql` → **Run**
3. **Authentication → Sign In / Providers**: slå *Allow new users to sign up* **fra** (kun inviterede brugere)
4. **Authentication → Users → Add user**: opret importørens login (e-mail + adgangskode, sæt "Auto confirm")
5. **Project Settings → API**: kopiér *Project URL* og *anon public key*

### 2. Konfiguration
Udfyld `config.js` med URL og anon key.

### 3. GitHub Pages
1. Opret repo (fx `rotax-reservedele`) og push alle filer
2. **Settings → Pages → Source: Deploy from branch → main / root**
3. Appen ligger på `https://<bruger>.github.io/rotax-reservedele/` (eller eget domæne via CNAME)

### 4. Installér som app
- **iOS (Safari):** Del → *Føj til hjemmeskærm*
- **Android (Chrome):** menu → *Installér app*
- **Windows (Edge/Chrome):** installér-ikonet i adresselinjen

Kameraet kræver HTTPS – det har GitHub Pages automatisk.

## Opdatering
Ved ændringer i filerne: hæv `CACHE`-versionen i `sw.js` (fx `reservedele-v2`), så enhederne henter den nye version.

## Filer
| Fil | Indhold |
|---|---|
| `index.html` | Forside, setup, login, scanner og redigeringsdialog |
| `app.js` | Al logik (Supabase, scanner, søgning, setup) |
| `styles.css` | Lyst tema med stor, tydelig tekst |
| `config.js` | Supabase-nøgler |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |
| `supabase/schema.sql` | Tabeller, view, trigger og sikkerhed (RLS) |
