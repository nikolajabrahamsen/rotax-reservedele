-- =====================================================================
-- Rotax Reservedele – Supabase schema
-- Kør hele filen i Supabase → SQL Editor → "New query" → Run
-- =====================================================================

-- ---------- Typer (dropdown 1) ----------
create table if not exists public.part_types (
  id          bigint generated always as identity primary key,
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists part_types_name_uq on public.part_types (lower(name));

-- ---------- Forhandlere (dropdown 2) ----------
create table if not exists public.dealers (
  id          bigint generated always as identity primary key,
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists dealers_name_uq on public.dealers (lower(name));

-- ---------- Reservedele ----------
create table if not exists public.parts (
  id          bigint generated always as identity primary key,
  barcode     text not null,
  type_id     bigint not null references public.part_types(id) on delete restrict,
  dealer_id   bigint not null references public.dealers(id)    on delete restrict,
  note        text,
  created_at  timestamptz not null default now(),          -- automatisk timestamp
  created_by  uuid default auth.uid() references auth.users(id) on delete set null
);
-- Hver stregkode kan kun registreres én gang (fjern denne linje hvis samme
-- stregkode skal kunne leveres flere gange)
create unique index if not exists parts_barcode_uq on public.parts (barcode);
create index if not exists parts_created_at_idx on public.parts (created_at desc);

-- Tidsstemplet sættes ALTID af serveren – kan ikke overskrives fra appen
create or replace function public.parts_force_timestamp()
returns trigger language plpgsql as $$
begin
  new.created_at := now();
  new.created_by := auth.uid();
  return new;
end $$;

drop trigger if exists parts_force_timestamp on public.parts;
create trigger parts_force_timestamp
  before insert on public.parts
  for each row execute function public.parts_force_timestamp();

-- ---------- Visning med navne (bruges af appen) ----------
create or replace view public.parts_view
with (security_invoker = true) as
select p.id, p.barcode, p.note, p.created_at,
       p.type_id,   t.name as type_name,
       p.dealer_id, d.name as dealer_name
from public.parts p
join public.part_types t on t.id = p.type_id
join public.dealers    d on d.id = p.dealer_id;

-- ---------- Sikkerhed (RLS) ----------
-- Kun brugere der er logget ind kan læse/skrive. Opret brugere under
-- Authentication → Users → "Add user" i Supabase.
alter table public.part_types enable row level security;
alter table public.dealers    enable row level security;
alter table public.parts      enable row level security;

drop policy if exists "auth all part_types" on public.part_types;
create policy "auth all part_types" on public.part_types
  for all to authenticated using (true) with check (true);

drop policy if exists "auth all dealers" on public.dealers;
create policy "auth all dealers" on public.dealers
  for all to authenticated using (true) with check (true);

drop policy if exists "auth read parts" on public.parts;
create policy "auth read parts" on public.parts
  for select to authenticated using (true);

drop policy if exists "auth insert parts" on public.parts;
create policy "auth insert parts" on public.parts
  for insert to authenticated with check (true);

drop policy if exists "auth update parts" on public.parts;
create policy "auth update parts" on public.parts
  for update to authenticated using (true) with check (true);

drop policy if exists "auth delete parts" on public.parts;
create policy "auth delete parts" on public.parts
  for delete to authenticated using (true);

-- Eksplicitte rettigheder (nyere Supabase-projekter giver dem ikke altid automatisk)
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.part_types, public.dealers, public.parts to authenticated;
grant select on public.parts_view to authenticated;

-- ---------- Eksempeldata (valgfrit – slet hvis ikke ønsket) ----------
insert into public.part_types (name) values
  ('Cylinder'), ('Stempel'), ('Krumtap'), ('Karburator'), ('Tændspole')
on conflict do nothing;
