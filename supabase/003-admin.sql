-- =====================================================================
-- Rotax Reservedele – migrering 003: Admin
--   * Admin-brugere kan oprette importører og tilknytte brugere i appen
--   * Kør EFTER 002. Filen kan køres flere gange.
--
-- !! Ret e-mailen nederst i filen til din egen, før du kører den !!
-- =====================================================================

begin;

alter table public.profiles add column if not exists is_admin boolean not null default false;

create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where user_id = auth.uid()), false)
$$;
grant execute on function public.is_app_admin() to authenticated;

-- Admin må se alle profiler og alle importører, og oprette/rette/slette importører
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_superadmin() or public.is_app_admin());

drop policy if exists "read own importer" on public.importers;
create policy "read own importer" on public.importers for select to authenticated
  using (id = public.my_importer_id() or public.is_superadmin() or public.is_app_admin());

drop policy if exists "admin insert importer" on public.importers;
create policy "admin insert importer" on public.importers for insert to authenticated
  with check (public.is_app_admin());
drop policy if exists "admin update importer" on public.importers;
create policy "admin update importer" on public.importers for update to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists "admin delete importer" on public.importers;
create policy "admin delete importer" on public.importers for delete to authenticated
  using (public.is_app_admin());
grant insert, update, delete on public.importers to authenticated;

-- ---------------------------------------------------------------------
-- Admin-funktioner (kan kun kaldes af admin)
-- ---------------------------------------------------------------------
create or replace function public.admin_list_users()
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
               importer_id bigint, importer_name text, role text, is_admin boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_app_admin() then
    raise exception 'Kun for administratorer' using errcode = 'P0001';
  end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at,
           p.importer_id, i.name, coalesce(p.role, 'user'), coalesce(p.is_admin, false)
    from auth.users u
    left join public.profiles p on p.user_id = u.id
    left join public.importers i on i.id = p.importer_id
    order by (p.importer_id is null and coalesce(p.role,'user') <> 'superadmin') desc, i.name nulls first, u.email;
end $$;

create or replace function public.admin_list_importers()
returns table (id bigint, name text, country text, users int, parts int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'Kun for administratorer' using errcode = 'P0001';
  end if;
  return query
    select i.id, i.name, i.country,
           (select count(*) from public.profiles p where p.importer_id = i.id)::int,
           (select count(*) from public.parts x where x.importer_id = i.id)::int
    from public.importers i
    order by i.name;
end $$;

-- Tilknyt bruger til importør og rolle.
--   p_role: 'user' (almindelig bruger) eller 'superadmin' (Rotax – ser alle importører)
create or replace function public.admin_set_user(p_user uuid, p_importer bigint, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'Kun for administratorer' using errcode = 'P0001';
  end if;
  if p_role not in ('user', 'superadmin') then
    raise exception 'Ugyldig rolle' using errcode = 'P0001';
  end if;
  insert into public.profiles (user_id, importer_id, role)
  values (p_user, p_importer, p_role)
  on conflict (user_id) do update set importer_id = excluded.importer_id, role = excluded.role;
end $$;

create or replace function public.admin_set_admin(p_user uuid, p_is_admin boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'Kun for administratorer' using errcode = 'P0001';
  end if;
  if p_user = auth.uid() and not p_is_admin then
    raise exception 'Du kan ikke fjerne din egen admin-adgang' using errcode = 'P0001';
  end if;
  insert into public.profiles (user_id, is_admin) values (p_user, p_is_admin)
  on conflict (user_id) do update set is_admin = excluded.is_admin;
end $$;

revoke all on function public.admin_list_users() from public, anon;
revoke all on function public.admin_list_importers() from public, anon;
revoke all on function public.admin_set_user(uuid, bigint, text) from public, anon;
revoke all on function public.admin_set_admin(uuid, boolean) from public, anon;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_list_importers() to authenticated;
grant execute on function public.admin_set_user(uuid, bigint, text) to authenticated;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Gør dig selv til admin  ←  RET E-MAILEN
-- ---------------------------------------------------------------------
insert into public.profiles (user_id, importer_id, role, is_admin)
select u.id, (select id from public.importers where lower(name) = 'danmark'), 'user', true
from auth.users u
where lower(u.email) = lower('nikolaj@nha-automation.dk')
on conflict (user_id) do update set is_admin = true;

commit;

-- Tjek: skal vise din e-mail med is_admin = true
select u.email, p.is_admin, i.name as importer
from auth.users u join public.profiles p on p.user_id = u.id
left join public.importers i on i.id = p.importer_id
where p.is_admin;
