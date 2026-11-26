-- Acceso restringido: la app es pública en internet, pero solo los correos de esta lista pueden crear cuenta.
-- El bloqueo vive en la base de datos (trigger sobre auth.users), así que también frena
-- registros hechos directamente contra la API de Supabase, sin pasar por la pantalla de la app.
create table if not exists public.lmi_acceso_permitido (
  email      text primary key check (email = lower(trim(email)) and position('@' in email) > 1),
  created_at timestamptz not null default now()
);
alter table public.lmi_acceso_permitido enable row level security;
revoke all on public.lmi_acceso_permitido from anon, authenticated;   -- sin políticas: solo el panel / service_role

create or replace function public.lmi_bloquear_registro()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.lmi_acceso_permitido a where a.email = lower(trim(new.email))) then
    raise exception 'Registro no autorizado: este correo no tiene acceso a la aplicación.' using errcode = '42501';
  end if;
  return new;
end $$;

revoke execute on function public.lmi_bloquear_registro() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.lmi_bloquear_registro() to supabase_auth_admin;
  end if;
end $$;

drop trigger if exists lmi_bloquear_registro on auth.users;
create trigger lmi_bloquear_registro before insert on auth.users
  for each row execute function public.lmi_bloquear_registro();

-- Para autorizar otro correo:  insert into public.lmi_acceso_permitido (email) values ('otro@correo.com');
insert into public.lmi_acceso_permitido (email) values ('tu-correo@ejemplo.com')
on conflict do nothing;
