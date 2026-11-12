-- =====================================================================
-- Rotax Reservedele – migrering 004: Brugeradministration
--   * Importør-admin (rolle 'admin') kan administrere brugere hos sin egen importør
--   * Midlertidig kode: brugeren skal vælge ny adgangskode ved første login
--   * Selve oprettelsen af login-brugere sker i Edge Function "manage-users"
-- Kør EFTER 003. Filen kan køres flere gange.
-- =====================================================================

begin;

alter table public.profiles add column if not exists must_change_password boolean not null default false;

create or replace function public.is_importer_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' and importer_id is not null
                   from public.profiles where user_id = auth.uid()), false)
$$;
grant execute on function public.is_importer_admin() to authenticated;

-- Brugeren har selv skiftet sin midlertidige kode
create or replace function public.clear_must_change_password()
returns void language sql security definer set search_path = public as $$
  update public.profiles set must_change_password = false where user_id = auth.uid()
$$;
grant execute on function public.clear_must_change_password() to authenticated;

-- Admin må nu også give rollen 'admin' (importør-admin)
create or replace function public.admin_set_user(p_user uuid, p_importer bigint, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'Kun for administratorer' using errcode = 'P0001';
  end if;
  if p_role not in ('user', 'admin', 'superadmin') then
    raise exception 'Ugyldig rolle' using errcode = 'P0001';
  end if;
  insert into public.profiles (user_id, importer_id, role)
  values (p_user, p_importer, p_role)
  on conflict (user_id) do update set importer_id = excluded.importer_id, role = excluded.role;
end $$;

-- Brugere hos min egen importør (til importør-admin og app-admin)
create or replace function public.importer_list_users()
returns table (user_id uuid, email text, role text, last_sign_in_at timestamptz,
               must_change_password boolean, is_admin boolean)
language plpgsql stable security definer set search_path = public, auth as $$
declare imp bigint := public.my_importer_id();
begin
  if not (public.is_importer_admin() or (public.is_app_admin() and imp is not null)) then
    raise exception 'Kun for importør-administratorer' using errcode = 'P0001';
  end if;
  return query
    select u.id, u.email::text, p.role, u.last_sign_in_at, p.must_change_password, p.is_admin
    from public.profiles p join auth.users u on u.id = p.user_id
    where p.importer_id = imp
    order by u.email;
end $$;

-- Skift rolle (bruger / importør-admin) for en bruger hos min egen importør
create or replace function public.importer_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare imp bigint := public.my_importer_id();
begin
  if not (public.is_importer_admin() or (public.is_app_admin() and imp is not null)) then
    raise exception 'Kun for importør-administratorer' using errcode = 'P0001';
  end if;
  if p_role not in ('user', 'admin') then
    raise exception 'Ugyldig rolle' using errcode = 'P0001';
  end if;
  if p_user = auth.uid() then
    raise exception 'Du kan ikke ændre din egen rolle' using errcode = 'P0001';
  end if;
  update public.profiles set role = p_role
  where user_id = p_user and importer_id = imp and role <> 'superadmin';
  if not found then
    raise exception 'Brugeren findes ikke' using errcode = 'P0001';
  end if;
end $$;

revoke all on function public.importer_list_users() from public, anon;
revoke all on function public.importer_set_role(uuid, text) from public, anon;
grant execute on function public.importer_list_users() to authenticated;
grant execute on function public.importer_set_role(uuid, text) to authenticated;

commit;
