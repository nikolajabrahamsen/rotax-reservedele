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

## Ny importør og nye brugere
Brugere oprettes i Supabase → **Authentication → Users → Add user** (sæt *Auto Confirm User*).
En ny bruger kan **ikke** se noget, før den er tilknyttet en importør. Kør i SQL Editor:

```sql
-- 1) Opret importøren (én gang)
insert into public.importers (name, country) values ('Sverige', 'SE');

-- 2) Tilknyt brugeren til importøren
insert into public.profiles (user_id, importer_id, role)
select u.id, i.id, 'user'
from auth.users u, public.importers i
where u.email = 'person@firma.se' and i.name = 'Sverige'
on conflict (user_id) do update set importer_id = excluded.importer_id, role = excluded.role;
```

Rotax-bruger, der kan se alle importører:

```sql
insert into public.profiles (user_id, importer_id, role)
select id, null, 'superadmin' from auth.users where email = 'navn@rotax.com'
on conflict (user_id) do update set importer_id = null, role = 'superadmin';
```

## Installér som app
- **iOS (Safari):** Del → *Føj til hjemmeskærm*
- **Android (Chrome):** menu → *Installér app*
- **Windows (Edge/Chrome):** installér-ikonet i adresselinjen

## Opdatering af appen
Ved ændringer i filerne: hæv `CACHE`-versionen i `sw.js`, så enhederne henter den nye version.

## Filer
| Fil | Indhold |
|---|---|
| `index.html` | Forside, Dele, Setup, login, scanner og detaljedialog |
| `app.js` | Al logik (Supabase, scanner, søgning, underdele, setup) |
| `styles.css` | Rotax-farver, stor og tydelig tekst |
| `config.js` | Supabase-nøgler |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |
| `supabase/schema.sql` | Grundtabeller (version 1) |
| `supabase/002-importoerer-og-underdele.sql` | Importører, underdele, historik og adgangsregler |
