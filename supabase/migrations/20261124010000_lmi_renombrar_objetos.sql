-- Renombra los objetos de base de datos del prefijo sire_ a lmi_ (liquidacion_mensual_impuestos).
-- Las tablas estaban vacías al aplicarla; si hubiera datos, hay que migrarlos antes de borrar.
drop policy if exists sire_archivos_select on storage.objects;
drop table if exists public.sire_datos, public.sire_tickets, public.sire_credenciales,
                      public.sire_miembros, public.sire_empresas cascade;
drop function if exists
  public.sire_rol(uuid), public.sire_es_miembro(uuid), public.sire_puede_editar(uuid),
  public.sire_es_admin(uuid), public.sire_agregar_miembro(uuid,text,text),
  public.sire_guardar_credenciales(uuid,text,text,text,text,text),
  public.sire_eliminar_credenciales(uuid), public.sire_credenciales_estado(uuid),
  public.sire_obtener_credenciales(uuid), public.sire_marcar_credenciales(uuid,boolean,text),
  public.sire_storage_empresa(text), public.sire_empresa_alta_admin(), public.sire_touch_updated_at();

-- =====================================================================
--  SIRE → CONTASIS · Esquema multiempresa para Supabase
--  Ejecútalo con la CLI (supabase db push) o pégalo COMPLETO en
--  Supabase → SQL Editor → New query → Run. Se puede volver a ejecutar.
--
--  Las tablas llevan el prefijo lmi_ para no chocar con otras apps que
--  compartan el mismo proyecto (p. ej. Planillas PRo usa "empresas").
--  Aun así, se recomienda un proyecto Supabase propio para esta app:
--  aquí se guardan credenciales API SUNAT y claves SOL.
--
--  Modelo de seguridad
--   · Cada empresa (RUC) tiene miembros con rol admin / editor / lector.
--   · TODAS las tablas tienen RLS: solo ves lo de tus empresas.
--   · client_secret y clave SOL se guardan CIFRADOS en Supabase Vault.
--     La tabla lmi_credenciales solo guarda los UUID de esos secretos:
--     ningún rol del navegador (anon / authenticated) puede leerla,
--     ni siquiera el dueño. Solo la Edge Function (service_role) descifra.
-- =====================================================================


-- ---------------------------------------------------------------------
--  0. Utilidades
-- ---------------------------------------------------------------------
create or replace function public.lmi_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
--  1. Empresas y miembros
-- ---------------------------------------------------------------------
create table if not exists public.lmi_empresas (
  id           uuid primary key default gen_random_uuid(),
  ruc          text not null check (ruc ~ '^[0-9]{11}$'),
  razon_social text not null check (length(trim(razon_social)) > 0),
  created_by   uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (created_by, ruc)
);

create table if not exists public.lmi_miembros (
  empresa_id uuid not null references public.lmi_empresas(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  rol        text not null default 'editor' check (rol in ('admin','editor','lector')),
  created_at timestamptz not null default now(),
  primary key (empresa_id, user_id)
);
create index if not exists lmi_miembros_user_idx on public.lmi_miembros(user_id);

drop trigger if exists lmi_empresas_touch on public.lmi_empresas;
create trigger lmi_empresas_touch before update on public.lmi_empresas
  for each row execute function public.lmi_touch_updated_at();

-- Funciones de pertenencia. SECURITY DEFINER para no caer en recursión de RLS.
create or replace function public.lmi_rol(p_empresa uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.rol from public.lmi_miembros m
   where m.empresa_id = p_empresa and m.user_id = auth.uid()
$$;

create or replace function public.lmi_es_miembro(p_empresa uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lmi_miembros m
                  where m.empresa_id = p_empresa and m.user_id = auth.uid())
$$;

create or replace function public.lmi_puede_editar(p_empresa uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lmi_miembros m
                  where m.empresa_id = p_empresa and m.user_id = auth.uid()
                    and m.rol in ('admin','editor'))
$$;

create or replace function public.lmi_es_admin(p_empresa uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lmi_miembros m
                  where m.empresa_id = p_empresa and m.user_id = auth.uid()
                    and m.rol = 'admin')
$$;

-- Quien crea la empresa queda como admin.
create or replace function public.lmi_empresa_alta_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lmi_miembros (empresa_id, user_id, rol)
  values (new.id, new.created_by, 'admin')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists lmi_empresas_alta_admin on public.lmi_empresas;
create trigger lmi_empresas_alta_admin after insert on public.lmi_empresas
  for each row execute function public.lmi_empresa_alta_admin();

alter table public.lmi_empresas enable row level security;
alter table public.lmi_miembros enable row level security;

drop policy if exists lmi_empresas_select on public.lmi_empresas;
create policy lmi_empresas_select on public.lmi_empresas for select to authenticated
  using (created_by = auth.uid() or public.lmi_es_miembro(id));
drop policy if exists lmi_empresas_insert on public.lmi_empresas;
create policy lmi_empresas_insert on public.lmi_empresas for insert to authenticated
  with check (created_by = auth.uid());
drop policy if exists lmi_empresas_update on public.lmi_empresas;
create policy lmi_empresas_update on public.lmi_empresas for update to authenticated
  using (public.lmi_es_admin(id)) with check (public.lmi_es_admin(id));
drop policy if exists lmi_empresas_delete on public.lmi_empresas;
create policy lmi_empresas_delete on public.lmi_empresas for delete to authenticated
  using (public.lmi_es_admin(id));

drop policy if exists lmi_miembros_select on public.lmi_miembros;
create policy lmi_miembros_select on public.lmi_miembros for select to authenticated
  using (user_id = auth.uid() or public.lmi_es_admin(empresa_id));
drop policy if exists lmi_miembros_update on public.lmi_miembros;
create policy lmi_miembros_update on public.lmi_miembros for update to authenticated
  using (public.lmi_es_admin(empresa_id)) with check (public.lmi_es_admin(empresa_id));
drop policy if exists lmi_miembros_delete on public.lmi_miembros;
create policy lmi_miembros_delete on public.lmi_miembros for delete to authenticated
  using (public.lmi_es_admin(empresa_id));
-- No hay política de INSERT: los miembros se agregan con lmi_agregar_miembro().

revoke all on public.lmi_empresas, public.lmi_miembros from anon;

-- Agregar un miembro por correo (solo admin de la empresa; el usuario ya debe estar registrado).
create or replace function public.lmi_agregar_miembro(p_empresa uuid, p_email text, p_rol text default 'editor')
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not public.lmi_es_admin(p_empresa) then
    raise exception 'Solo un administrador de la empresa puede agregar miembros' using errcode = '42501';
  end if;
  if p_rol not in ('admin','editor','lector') then
    raise exception 'Rol inválido: %', p_rol using errcode = '22023';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No existe un usuario registrado con ese correo' using errcode = 'P0002';
  end if;
  insert into public.lmi_miembros (empresa_id, user_id, rol)
  values (p_empresa, v_user, p_rol)
  on conflict (empresa_id, user_id) do update set rol = excluded.rol;
end $$;

-- ---------------------------------------------------------------------
--  2. Credenciales API SUNAT por empresa (cifradas en Vault)
-- ---------------------------------------------------------------------
create table if not exists public.lmi_credenciales (
  empresa_id          uuid primary key references public.lmi_empresas(id) on delete cascade,
  ruc                 text not null check (ruc ~ '^[0-9]{11}$'),
  client_id           text not null,
  usuario_sol         text not null,
  vault_client_secret uuid not null,   -- id del secreto en vault.secrets (cifrado)
  vault_clave_sol     uuid not null,   -- id del secreto en vault.secrets (cifrado)
  ultimo_ok           timestamptz,
  ultimo_error        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists lmi_credenciales_touch on public.lmi_credenciales;
create trigger lmi_credenciales_touch before update on public.lmi_credenciales
  for each row execute function public.lmi_touch_updated_at();

-- RLS activado SIN políticas + sin privilegios: el navegador no puede leerla ni escribirla.
alter table public.lmi_credenciales enable row level security;
revoke all on public.lmi_credenciales from anon, authenticated;

-- Guardar / actualizar credenciales (solo admin). Un secreto en blanco conserva el anterior.
create or replace function public.lmi_guardar_credenciales(
  p_empresa uuid, p_ruc text, p_client_id text, p_client_secret text,
  p_usuario_sol text, p_clave_sol text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cur public.lmi_credenciales%rowtype;
  v_sec uuid;
  v_sol uuid;
begin
  if not public.lmi_es_admin(p_empresa) then
    raise exception 'Solo un administrador de la empresa puede guardar credenciales' using errcode = '42501';
  end if;
  if p_ruc !~ '^[0-9]{11}$' then raise exception 'RUC inválido (11 dígitos)' using errcode = '22023'; end if;
  if coalesce(trim(p_client_id),'') = '' or coalesce(trim(p_usuario_sol),'') = '' then
    raise exception 'client_id y usuario SOL son obligatorios' using errcode = '22023';
  end if;

  select * into v_cur from public.lmi_credenciales where empresa_id = p_empresa;

  if not found then
    if coalesce(p_client_secret,'') = '' or coalesce(p_clave_sol,'') = '' then
      raise exception 'client_secret y clave SOL son obligatorios la primera vez' using errcode = '22023';
    end if;
    v_sec := vault.create_secret(p_client_secret, 'sire:'||p_empresa||':client_secret', 'SIRE client_secret');
    v_sol := vault.create_secret(p_clave_sol,     'sire:'||p_empresa||':clave_sol',     'SIRE clave SOL');
    insert into public.lmi_credenciales
      (empresa_id, ruc, client_id, usuario_sol, vault_client_secret, vault_clave_sol)
    values (p_empresa, p_ruc, trim(p_client_id), trim(p_usuario_sol), v_sec, v_sol);
  else
    if coalesce(p_client_secret,'') <> '' then
      perform vault.update_secret(v_cur.vault_client_secret, p_client_secret);
    end if;
    if coalesce(p_clave_sol,'') <> '' then
      perform vault.update_secret(v_cur.vault_clave_sol, p_clave_sol);
    end if;
    update public.lmi_credenciales
       set ruc = p_ruc, client_id = trim(p_client_id), usuario_sol = trim(p_usuario_sol),
           ultimo_error = null
     where empresa_id = p_empresa;
  end if;
end $$;

create or replace function public.lmi_eliminar_credenciales(p_empresa uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_cur public.lmi_credenciales%rowtype;
begin
  if not public.lmi_es_admin(p_empresa) then
    raise exception 'Solo un administrador de la empresa puede eliminar credenciales' using errcode = '42501';
  end if;
  select * into v_cur from public.lmi_credenciales where empresa_id = p_empresa;
  if found then
    delete from public.lmi_credenciales where empresa_id = p_empresa;
    delete from vault.secrets where id in (v_cur.vault_client_secret, v_cur.vault_clave_sol);
  end if;
end $$;

-- Estado no sensible (para pintar el formulario): nunca devuelve secretos.
create or replace function public.lmi_credenciales_estado(p_empresa uuid)
returns table (configurado boolean, ruc text, client_id text, usuario_sol text,
               actualizado_en timestamptz, ultimo_ok timestamptz, ultimo_error text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.lmi_puede_editar(p_empresa) then
    raise exception 'Sin permiso sobre esta empresa' using errcode = '42501';
  end if;
  return query
    select true, c.ruc, c.client_id, c.usuario_sol, c.updated_at, c.ultimo_ok, c.ultimo_error
      from public.lmi_credenciales c where c.empresa_id = p_empresa;
  if not found then
    return query select false, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text;
  end if;
end $$;

-- SOLO service_role (Edge Function): devuelve las credenciales descifradas.
create or replace function public.lmi_obtener_credenciales(p_empresa uuid)
returns table (ruc text, client_id text, client_secret text, usuario_sol text, clave_sol text)
language sql stable security definer set search_path = '' as $$
  select c.ruc, c.client_id, s1.decrypted_secret, c.usuario_sol, s2.decrypted_secret
    from public.lmi_credenciales c
    join vault.decrypted_secrets s1 on s1.id = c.vault_client_secret
    join vault.decrypted_secrets s2 on s2.id = c.vault_clave_sol
   where c.empresa_id = p_empresa
$$;

-- SOLO service_role: deja constancia del último intento de autenticación.
create or replace function public.lmi_marcar_credenciales(p_empresa uuid, p_ok boolean, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.lmi_credenciales
     set ultimo_ok = case when p_ok then now() else ultimo_ok end,
         ultimo_error = case when p_ok then null else left(p_error, 500) end
   where empresa_id = p_empresa
$$;

-- ---------------------------------------------------------------------
--  3. Tickets de sincronización SIRE (Compras RCE / Ventas RVIE)
-- ---------------------------------------------------------------------
create table if not exists public.lmi_tickets (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         uuid not null references public.lmi_empresas(id) on delete cascade,
  libro              text not null check (libro in ('compras','ventas')),
  periodo            text not null check (periodo ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  num_ticket         text not null,
  estado             text not null default 'solicitado'
                       check (estado in ('solicitado','en_proceso','terminado','descargado','error')),
  cod_estado_proceso text,
  des_estado_proceso text,
  cod_proceso        text,
  archivos           jsonb not null default '[]'::jsonb,  -- [{nombre, codTipo, path}] ya guardados en Storage
  detalle_error      text,
  solicitado_por     uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (empresa_id, libro, num_ticket)
);
create index if not exists lmi_tickets_emp_idx on public.lmi_tickets(empresa_id, libro, periodo, created_at desc);

drop trigger if exists lmi_tickets_touch on public.lmi_tickets;
create trigger lmi_tickets_touch before update on public.lmi_tickets
  for each row execute function public.lmi_touch_updated_at();

alter table public.lmi_tickets enable row level security;
drop policy if exists lmi_tickets_select on public.lmi_tickets;
create policy lmi_tickets_select on public.lmi_tickets for select to authenticated
  using (public.lmi_es_miembro(empresa_id));
-- Sin políticas de escritura: solo la Edge Function (service_role) crea y actualiza tickets.
revoke all on public.lmi_tickets from anon;
revoke insert, update, delete on public.lmi_tickets from authenticated;

-- ---------------------------------------------------------------------
--  4. Persistencia de los datos de la app por empresa (clave → JSON)
--     Espejo de los almacenes de IndexedDB:
--       cfg        → configuración de la empresa (plan, reglas, glosas, formato)
--       p|AAAA|M   → período procesado
--       b|AAAA|M   → base acumulada (compras / diario / ventas)
-- ---------------------------------------------------------------------
create table if not exists public.lmi_datos (
  empresa_id uuid not null references public.lmi_empresas(id) on delete cascade,
  clave      text not null check (clave ~ '^(cfg|[pb]\|[0-9]{4}\|[0-9]{1,2})$'),
  valor      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  primary key (empresa_id, clave)
);

drop trigger if exists lmi_datos_touch on public.lmi_datos;
create trigger lmi_datos_touch before update on public.lmi_datos
  for each row execute function public.lmi_touch_updated_at();

alter table public.lmi_datos enable row level security;
drop policy if exists lmi_datos_select on public.lmi_datos;
create policy lmi_datos_select on public.lmi_datos for select to authenticated
  using (public.lmi_es_miembro(empresa_id));
drop policy if exists lmi_datos_insert on public.lmi_datos;
create policy lmi_datos_insert on public.lmi_datos for insert to authenticated
  with check (public.lmi_puede_editar(empresa_id));
drop policy if exists lmi_datos_update on public.lmi_datos;
create policy lmi_datos_update on public.lmi_datos for update to authenticated
  using (public.lmi_puede_editar(empresa_id)) with check (public.lmi_puede_editar(empresa_id));
drop policy if exists lmi_datos_delete on public.lmi_datos;
create policy lmi_datos_delete on public.lmi_datos for delete to authenticated
  using (public.lmi_puede_editar(empresa_id));
revoke all on public.lmi_datos from anon;

-- ---------------------------------------------------------------------
--  5. Storage: archivos descargados del SIRE (bucket privado)
--     Ruta: <empresa_id>/<compras|ventas>/<periodo>/<ticket>/<archivo>.zip
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('sire-archivos', 'sire-archivos', false)
on conflict (id) do update set public = false;

create or replace function public.lmi_storage_empresa(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

drop policy if exists lmi_archivos_select on storage.objects;
create policy lmi_archivos_select on storage.objects for select to authenticated
  using (bucket_id = 'sire-archivos'
         and public.lmi_es_miembro(public.lmi_storage_empresa(name)));
-- Sin políticas de escritura: solo service_role sube archivos.

-- ---------------------------------------------------------------------
--  6. Permisos de ejecución de las funciones
-- ---------------------------------------------------------------------
revoke execute on function
  public.lmi_rol(uuid), public.lmi_es_miembro(uuid), public.lmi_puede_editar(uuid),
  public.lmi_es_admin(uuid), public.lmi_agregar_miembro(uuid,text,text),
  public.lmi_guardar_credenciales(uuid,text,text,text,text,text),
  public.lmi_eliminar_credenciales(uuid), public.lmi_credenciales_estado(uuid),
  public.lmi_obtener_credenciales(uuid), public.lmi_marcar_credenciales(uuid,boolean,text),
  public.lmi_storage_empresa(text)
  from public, anon, authenticated;

grant execute on function
  public.lmi_rol(uuid), public.lmi_es_miembro(uuid), public.lmi_puede_editar(uuid),
  public.lmi_es_admin(uuid), public.lmi_agregar_miembro(uuid,text,text),
  public.lmi_guardar_credenciales(uuid,text,text,text,text,text),
  public.lmi_eliminar_credenciales(uuid), public.lmi_credenciales_estado(uuid),
  public.lmi_storage_empresa(text)
  to authenticated;

-- Solo la Edge Function (service_role) puede descifrar y marcar.
grant execute on function
  public.lmi_obtener_credenciales(uuid), public.lmi_marcar_credenciales(uuid,boolean,text)
  to service_role;

-- Endurecimiento tras el linter de seguridad de Supabase.
alter function public.lmi_touch_updated_at() set search_path = '';
revoke execute on function public.lmi_empresa_alta_admin() from public, anon, authenticated;
