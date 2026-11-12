-- =====================================================================
-- Rotax Reservedele – migrering 002
--   * Importører: hver importør ser KUN sine egne typer, forhandlere og dele
--   * Underdele: dele kan kobles på en hoveddel (fx en motor)
--   * Historik over flytninger af underdele
--
-- Kør hele filen i Supabase → SQL Editor → New query → Run.
-- Kør den EFTER schema.sql. Eksisterende data flyttes til importøren "Danmark".
-- Filen kan køres flere gange uden at ødelægge noget.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Importører og brugerprofiler
-- ---------------------------------------------------------------------
create table if not exists public.importers (
  id          bigint generated always as identity primary key,
  name        text not null,
  country     text,                      -- ISO-kode, fx DK, DE, SE
  created_at  timestamptz not null default now()
);
create unique index if not exists importers_name_uq on public.importers (lower(name));

insert into public.importers (name, country)
select 'Danmark', 'DK'
where not exists (select 1 from public.importers where lower(name) = 'danmark');

-- role: 'user'       = almindelig bruger hos importøren
--       'admin'      = (reserveret til senere brugeradministration)
--       'superadmin' = Rotax – kan SE alle importørers data
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  importer_id bigint references public.importers(id) on delete restrict,
  role        text not null default 'user' check (role in ('user','admin','superadmin')),
  created_at  timestamptz not null default now()
);

-- Alle eksisterende brugere tilknyttes Danmark
insert into public.profiles (user_id, importer_id, role)
select u.id, (select id from public.importers where lower(name) = 'danmark'), 'admin'
from auth.users u
on conflict (user_id) do nothing;

-- Hjælpefunktioner (security definer, så de kan bruges i RLS uden rekursion)
create or replace function public.my_importer_id()
returns bigint language sql stable security definer set search_path = public as $$
  select importer_id from public.profiles where user_id = auth.uid()
$$;

create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'superadmin' from public.profiles where user_id = auth.uid()), false)
$$;

grant execute on function public.my_importer_id() to authenticated;
grant execute on function public.is_superadmin()  to authenticated;

-- ---------------------------------------------------------------------
-- 2. importer_id på typer, forhandlere og dele
-- ---------------------------------------------------------------------
alter table public.part_types add column if not exists importer_id bigint references public.importers(id) on delete restrict;
alter table public.dealers    add column if not exists importer_id bigint references public.importers(id) on delete restrict;
alter table public.parts      add column if not exists importer_id bigint references public.importers(id) on delete restrict;

update public.part_types set importer_id = (select id from public.importers where lower(name) = 'danmark') where importer_id is null;
update public.dealers    set importer_id = (select id from public.importers where lower(name) = 'danmark') where importer_id is null;
update public.parts      set importer_id = (select id from public.importers where lower(name) = 'danmark') where importer_id is null;

alter table public.part_types alter column importer_id set not null;
alter table public.dealers    alter column importer_id set not null;
alter table public.parts      alter column importer_id set not null;

alter table public.part_types alter column importer_id set default public.my_importer_id();
alter table public.dealers    alter column importer_id set default public.my_importer_id();
alter table public.parts      alter column importer_id set default public.my_importer_id();

-- Navne og stregkoder er nu unikke PR. IMPORTØR
drop index if exists public.part_types_name_uq;
drop index if exists public.dealers_name_uq;
drop index if exists public.parts_barcode_uq;
create unique index if not exists part_types_imp_name_uq on public.part_types (importer_id, lower(name));
create unique index if not exists dealers_imp_name_uq    on public.dealers    (importer_id, lower(name));
create unique index if not exists parts_imp_barcode_uq   on public.parts      (importer_id, barcode);
create index if not exists parts_importer_created_idx on public.parts (importer_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. Underdele
-- ---------------------------------------------------------------------
alter table public.part_types add column if not exists can_have_children boolean not null default false;
update public.part_types set can_have_children = true
where lower(name) in ('motor', 'engine') and can_have_children = false;

alter table public.parts add column if not exists parent_id bigint references public.parts(id) on delete set null;
create index if not exists parts_parent_idx on public.parts (parent_id);

-- Historik over til-/frakobling og flytning af underdele
create table if not exists public.part_moves (
  id                  bigint generated always as identity primary key,
  importer_id         bigint not null references public.importers(id) on delete cascade,
  part_id             bigint not null references public.parts(id) on delete cascade,
  from_parent_id      bigint,
  from_parent_barcode text,
  to_parent_id        bigint,
  to_parent_barcode   text,
  moved_at            timestamptz not null default now(),
  moved_by            uuid references auth.users(id) on delete set null
);
create index if not exists part_moves_part_idx on public.part_moves (part_id, moved_at desc);

-- ---------------------------------------------------------------------
-- 4. Regler for dele (triggere)
-- ---------------------------------------------------------------------
drop trigger if exists parts_force_timestamp on public.parts;
drop function if exists public.parts_force_timestamp();

create or replace function public.parts_before_write()
returns trigger language plpgsql as $$
declare
  p public.parts%rowtype;
  can_children boolean;
begin
  if tg_op = 'INSERT' then
    new.importer_id := coalesce(new.importer_id, public.my_importer_id());
    if new.importer_id is null then
      raise exception 'Brugeren er ikke tilknyttet en importør' using errcode = 'P0001';
    end if;
    new.created_at := now();
    new.created_by := auth.uid();
  else
    -- Kan ikke flyttes til en anden importør, og oprettelse kan ikke ændres
    new.importer_id := old.importer_id;
    new.created_by  := old.created_by;
    new.created_at  := old.created_at;
  end if;

  if new.parent_id is not null then
    if tg_op = 'UPDATE' and new.parent_id = new.id then
      raise exception 'En del kan ikke være underdel af sig selv' using errcode = 'P0001';
    end if;

    select * into p from public.parts where id = new.parent_id;
    if not found or p.importer_id <> new.importer_id then
      raise exception 'Hoveddelen findes ikke' using errcode = 'P0001';
    end if;
    if p.parent_id is not null then
      raise exception 'Hoveddelen er selv en underdel' using errcode = 'P0001';
    end if;
    select t.can_have_children into can_children from public.part_types t where t.id = p.type_id;
    if not coalesce(can_children, false) then
      raise exception 'Hoveddelens type kan ikke have underdele' using errcode = 'P0001';
    end if;
    if tg_op = 'UPDATE' and exists (select 1 from public.parts c where c.parent_id = new.id) then
      raise exception 'Delen har selv underdele og kan ikke kobles på en anden del' using errcode = 'P0001';
    end if;

    -- Underdelen arver forhandler og dato fra hoveddelen (solgt som samlet pakke)
    new.dealer_id  := p.dealer_id;
    new.created_at := p.created_at;
  end if;

  return new;
end $$;

drop trigger if exists parts_before_write on public.parts;
create trigger parts_before_write
  before insert or update on public.parts
  for each row execute function public.parts_before_write();

-- Efter ændring: log flytninger og send ny forhandler videre til underdele
create or replace function public.parts_after_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.parent_id is distinct from old.parent_id then
    insert into public.part_moves (importer_id, part_id, from_parent_id, from_parent_barcode,
                                   to_parent_id, to_parent_barcode, moved_by)
    values (new.importer_id, new.id,
            old.parent_id, (select barcode from public.parts where id = old.parent_id),
            new.parent_id, (select barcode from public.parts where id = new.parent_id),
            auth.uid());
  end if;

  if new.dealer_id is distinct from old.dealer_id then
    update public.parts set dealer_id = new.dealer_id
    where parent_id = new.id and dealer_id is distinct from new.dealer_id;
  end if;
  return null;
end $$;

drop trigger if exists parts_after_update on public.parts;
create trigger parts_after_update
  after update on public.parts
  for each row execute function public.parts_after_update();

-- ---------------------------------------------------------------------
-- 5. Visninger (views) som appen bruger
-- ---------------------------------------------------------------------
drop view if exists public.parts_view;
create view public.parts_view with (security_invoker = true) as
select p.id, p.barcode, p.note, p.created_at, p.importer_id,
       p.type_id,   t.name as type_name, t.can_have_children,
       p.dealer_id, d.name as dealer_name,
       p.parent_id, pp.barcode as parent_barcode, pt.name as parent_type_name,
       (select count(*) from public.parts c where c.parent_id = p.id)::int as child_count,
       i.name as importer_name
from public.parts p
join public.part_types t on t.id = p.type_id
join public.dealers    d on d.id = p.dealer_id
join public.importers  i on i.id = p.importer_id
left join public.parts      pp on pp.id = p.parent_id
left join public.part_types pt on pt.id = pp.type_id;

-- ---------------------------------------------------------------------
-- 6. Sikkerhed (RLS): hver importør ser kun sine egne data
-- ---------------------------------------------------------------------
alter table public.importers  enable row level security;
alter table public.profiles   enable row level security;
alter table public.part_moves enable row level security;

-- Gamle "alle må alt"-regler fjernes
drop policy if exists "auth all part_types" on public.part_types;
drop policy if exists "auth all dealers"    on public.dealers;
drop policy if exists "auth read parts"     on public.parts;
drop policy if exists "auth insert parts"   on public.parts;
drop policy if exists "auth update parts"   on public.parts;
drop policy if exists "auth delete parts"   on public.parts;

-- importers / profiles: læs egen (Rotax: alle)
drop policy if exists "read own importer" on public.importers;
create policy "read own importer" on public.importers for select to authenticated
  using (id = public.my_importer_id() or public.is_superadmin());

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_superadmin());

-- part_types, dealers, parts: samme regler
do $$
declare tbl text;
begin
  foreach tbl in array array['part_types','dealers','parts'] loop
    execute format('drop policy if exists "imp select" on public.%I', tbl);
    execute format('drop policy if exists "imp insert" on public.%I', tbl);
    execute format('drop policy if exists "imp update" on public.%I', tbl);
    execute format('drop policy if exists "imp delete" on public.%I', tbl);
    execute format($p$create policy "imp select" on public.%I for select to authenticated
                     using (importer_id = public.my_importer_id() or public.is_superadmin())$p$, tbl);
    execute format($p$create policy "imp insert" on public.%I for insert to authenticated
                     with check (importer_id = public.my_importer_id())$p$, tbl);
    execute format($p$create policy "imp update" on public.%I for update to authenticated
                     using (importer_id = public.my_importer_id())
                     with check (importer_id = public.my_importer_id())$p$, tbl);
    execute format($p$create policy "imp delete" on public.%I for delete to authenticated
                     using (importer_id = public.my_importer_id())$p$, tbl);
  end loop;
end $$;

drop policy if exists "imp select" on public.part_moves;
create policy "imp select" on public.part_moves for select to authenticated
  using (importer_id = public.my_importer_id() or public.is_superadmin());
-- (part_moves skrives kun af triggeren)

grant usage on schema public to authenticated;
grant select on public.importers, public.profiles, public.part_moves to authenticated;
grant select, insert, update, delete on public.part_types, public.dealers, public.parts to authenticated;
grant select on public.parts_view to authenticated;

commit;
