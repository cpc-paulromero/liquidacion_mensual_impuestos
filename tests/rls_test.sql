-- Pruebas de seguridad de la migración (RLS, aislamiento por empresa, Vault).
-- Las ejecuta tests/run_rls_test.sh sobre un PostgreSQL temporal con rls_stub.sql.
\set ON_ERROR_STOP on
\set A '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set B '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set C '''cccccccc-cccc-cccc-cccc-cccccccccccc'''

insert into auth.users(id,email) values (:A,'a@x.pe'),(:B,'b@x.pe'),(:C,'c@x.pe');

create schema t;
grant usage on schema t to anon, authenticated, service_role;
alter default privileges in schema t grant all on tables to anon, authenticated, service_role;
alter default privileges in schema t grant all on sequences to anon, authenticated, service_role;
set search_path = t, public;
create table t.res(n serial, ok boolean, prueba text);

-- helper: ejecuta SQL como un rol/usuario y espera éxito o un error concreto
create or replace function t.espera_error(p_prueba text, p_rol text, p_uid text, p_sql text, p_patron text)
returns void language plpgsql as $$
declare v_msg text;
begin
  execute format('set local role %I', p_rol);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid,''), true);
  begin
    execute p_sql;
    reset role;
    insert into res(ok,prueba) values (false, p_prueba || '  [debía fallar y NO falló]');
  exception when others then
    v_msg := sqlerrm; reset role;
    insert into res(ok,prueba) values (v_msg ~* p_patron, p_prueba || '  [' || left(v_msg,70) || ']');
  end;
end $$;

create or replace function t.espera_ok(p_prueba text, p_rol text, p_uid text, p_sql text, p_esperado bigint default null)
returns void language plpgsql as $$
declare v bigint;
begin
  execute format('set local role %I', p_rol);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid,''), true);
  if p_esperado is null then execute p_sql; v := null;
  else execute 'select count(*) from (' || p_sql || ') q' into v; end if;
  reset role;
  insert into res(ok,prueba) values (p_esperado is null or v = p_esperado, p_prueba || coalesce('  [filas=' || v || ']',''));
end $$;

-- ===== 1. Alta de empresa y membresía =====
select t.espera_ok('A crea su empresa', 'authenticated', :A, $q$insert into public.sire_empresas(ruc,razon_social) values ('20123456789','EMPRESA A SAC')$q$);
select t.espera_ok('A queda como admin automáticamente', 'authenticated', :A, $q$select 1 from public.sire_miembros where rol='admin'$q$, 1);
select t.espera_error('RUC inválido rechazado', 'authenticated', :A, $q$insert into public.sire_empresas(ruc,razon_social) values ('123','X')$q$, 'check');
select t.espera_error('A no puede crearse empresa a nombre de B', 'authenticated', :A, format($q$insert into public.sire_empresas(ruc,razon_social,created_by) values ('20555555555','Y',%L)$q$, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'row-level security');

-- ===== 2. Aislamiento: B no ve nada de A =====
select t.espera_ok('B no ve empresas de A', 'authenticated', :B, $q$select 1 from public.sire_empresas$q$, 0);
select t.espera_ok('B no ve miembros de A', 'authenticated', :B, $q$select 1 from public.sire_miembros$q$, 0);

create table t.emp as select id from public.sire_empresas limit 1;

select t.espera_error('B no puede escribir datos en empresa de A', 'authenticated', :B,
  $q$insert into public.sire_datos(empresa_id,clave,valor) select id,'cfg','{}' from emp$q$, 'row-level security');
select t.espera_error('B no puede guardar credenciales en empresa de A', 'authenticated', :B,
  $q$select public.sire_guardar_credenciales((select id from emp),'20123456789','cid','sec','USR','pw')$q$, 'administrador');
select t.espera_error('anon no puede leer empresas', 'anon', null, $q$select 1 from public.sire_empresas$q$, 'permission denied');

-- ===== 3. Credenciales: Vault + sin lectura desde el navegador =====
select t.espera_ok('A guarda credenciales (admin)', 'authenticated', :A,
  $q$select public.sire_guardar_credenciales((select id from emp),'20123456789','client-abc','SECRETO-API','MODDATOS','CLAVE-SOL')$q$);
select t.espera_error('A NO puede leer la tabla sire_credenciales', 'authenticated', :A, $q$select * from public.sire_credenciales$q$, 'permission denied');
select t.espera_error('A NO puede escribir directo en sire_credenciales', 'authenticated', :A,
  $q$update public.sire_credenciales set client_id='x'$q$, 'permission denied');
select t.espera_error('A NO puede descifrar con sire_obtener_credenciales', 'authenticated', :A,
  $q$select * from public.sire_obtener_credenciales((select id from emp))$q$, 'permission denied');
select t.espera_error('A NO puede leer vault.decrypted_secrets', 'authenticated', :A, $q$select * from vault.decrypted_secrets$q$, 'permission denied');
select t.espera_ok('estado de credenciales no incluye secretos', 'authenticated', :A,
  $q$select 1 from public.sire_credenciales_estado((select id from emp)) where configurado and client_id='client-abc' and usuario_sol='MODDATOS'$q$, 1);

do $$
declare v_tabla text; v_n int;
begin
  -- la tabla solo guarda UUID, jamás los textos secretos
  select string_agg(t::text, ' ') into v_tabla from public.sire_credenciales t;
  insert into res(ok,prueba) values (v_tabla not like '%SECRETO-API%' and v_tabla not like '%CLAVE-SOL%', 'sire_credenciales no contiene los secretos en claro');
  select count(*) into v_n from vault.secrets where secret in ('SECRETO-API','CLAVE-SOL');
  insert into res(ok,prueba) values (v_n = 2, 'los 2 secretos están en Vault [filas=' || v_n || ']');
end $$;

do $$
declare r record; v boolean;
begin
  set local role service_role;
  select * into r from public.sire_obtener_credenciales((select id from t.emp));
  perform public.sire_marcar_credenciales((select id from t.emp), false, 'invalid_grant');
  v := r.client_secret='SECRETO-API' and r.clave_sol='CLAVE-SOL' and r.client_id='client-abc' and r.ruc='20123456789';
  reset role;
  insert into t.res(ok,prueba) values (v, 'service_role (Edge Function) sí obtiene las credenciales descifradas');
end $$;
select t.espera_ok('último error queda registrado', 'authenticated', :A,
  $q$select 1 from public.sire_credenciales_estado((select id from emp)) where ultimo_error='invalid_grant'$q$, 1);

-- actualizar con secretos en blanco conserva los anteriores
select t.espera_ok('actualizar sin secretos conserva los cifrados', 'authenticated', :A,
  $q$select public.sire_guardar_credenciales((select id from emp),'20123456789','client-nuevo','','NUEVOUSR','')$q$);
select t.espera_ok('...y se actualizó client_id/usuario', 'authenticated', :A,
  $q$select 1 from public.sire_credenciales_estado((select id from emp)) where client_id='client-nuevo' and usuario_sol='NUEVOUSR'$q$, 1);
do $$ begin insert into res(ok,prueba) values ((select count(*) from vault.secrets where secret in ('SECRETO-API','CLAVE-SOL'))=2, 'los secretos anteriores siguen en Vault'); end $$;

-- ===== 4. Roles: A agrega a B como lector =====
select t.espera_ok('A agrega a B como lector', 'authenticated', :A, $q$select public.sire_agregar_miembro((select id from emp),'b@x.pe','lector')$q$);
select t.espera_error('B (lector) no puede agregar miembros', 'authenticated', :B, $q$select public.sire_agregar_miembro((select id from emp),'c@x.pe','editor')$q$, 'administrador');
select t.espera_error('correo inexistente se informa', 'authenticated', :A, $q$select public.sire_agregar_miembro((select id from emp),'nadie@x.pe','editor')$q$, 'No existe');
select t.espera_ok('B ahora ve la empresa', 'authenticated', :B, $q$select 1 from public.sire_empresas$q$, 1);
select t.espera_error('B (lector) no puede ver el estado de credenciales', 'authenticated', :B, $q$select * from public.sire_credenciales_estado((select id from emp))$q$, 'permiso');
select t.espera_error('B (lector) no puede guardar credenciales', 'authenticated', :B,
  $q$select public.sire_guardar_credenciales((select id from emp),'20123456789','c','s','u','p')$q$, 'administrador');
select t.espera_error('B (lector) no puede escribir datos', 'authenticated', :B,
  $q$insert into public.sire_datos(empresa_id,clave,valor) select id,'cfg','{}' from emp$q$, 'row-level security');
select t.espera_ok('C (ajeno) no ve nada', 'authenticated', :C, $q$select 1 from public.sire_empresas$q$, 0);

-- ===== 5. Datos por empresa (persistencia) =====
select t.espera_ok('A (admin) guarda cfg', 'authenticated', :A, $q$insert into public.sire_datos(empresa_id,clave,valor) select id,'cfg','{"nombre":"A"}' from emp$q$);
select t.espera_ok('A guarda período y base', 'authenticated', :A, $q$insert into public.sire_datos(empresa_id,clave,valor) select id,k,'{"n":1}' from emp, (values ('p|2026|10'),('b|2026|10')) v(k)$q$);
select t.espera_error('clave inválida rechazada', 'authenticated', :A, $q$insert into public.sire_datos(empresa_id,clave,valor) select id,'hack','{}' from emp$q$, 'check');
select t.espera_ok('B (lector) lee los datos', 'authenticated', :B, $q$select 1 from public.sire_datos$q$, 3);
select t.espera_ok('upsert de A actualiza sin duplicar', 'authenticated', :A,
  $q$insert into public.sire_datos(empresa_id,clave,valor) select id,'cfg','{"nombre":"A2"}' from emp on conflict (empresa_id,clave) do update set valor=excluded.valor$q$);
select t.espera_ok('sigue habiendo 3 filas', 'authenticated', :A, $q$select 1 from public.sire_datos$q$, 3);

-- ===== 6. Tickets: solo lectura desde el navegador =====
insert into public.sire_tickets(empresa_id,libro,periodo,num_ticket) select id,'compras','202610','T1' from emp;
select t.espera_ok('A ve sus tickets', 'authenticated', :A, $q$select 1 from public.sire_tickets$q$, 1);
select t.espera_ok('C no ve tickets ajenos', 'authenticated', :C, $q$select 1 from public.sire_tickets$q$, 0);
select t.espera_error('A NO puede crear tickets desde el navegador', 'authenticated', :A,
  $q$insert into public.sire_tickets(empresa_id,libro,periodo,num_ticket) select id,'ventas','202610','T9' from emp$q$, 'permission denied');
select t.espera_error('periodo inválido rechazado', 'service_role', null,
  $q$insert into public.sire_tickets(empresa_id,libro,periodo,num_ticket) select id,'ventas','202613','T8' from emp$q$, 'check');

-- ===== 7. Storage =====
insert into storage.objects(bucket_id,name) select 'sire-archivos', id::text || '/compras/202610/T1/x.zip' from emp;
insert into storage.objects(bucket_id,name) values ('sire-archivos','no-es-uuid/x.zip');
select t.espera_ok('A ve el archivo de su empresa', 'authenticated', :A, $q$select 1 from storage.objects$q$, 1);
select t.espera_ok('B (miembro) ve el archivo', 'authenticated', :B, $q$select 1 from storage.objects$q$, 1);
select t.espera_ok('C (ajeno) no ve archivos', 'authenticated', :C, $q$select 1 from storage.objects$q$, 0);
select t.espera_ok('bucket es privado', 'service_role', null, $q$select 1 from storage.buckets where id='sire-archivos' and not public$q$, 1);

-- ===== 8. Eliminar credenciales borra también Vault =====
select t.espera_error('B (lector) no puede eliminar credenciales', 'authenticated', :B, $q$select public.sire_eliminar_credenciales((select id from emp))$q$, 'administrador');
select t.espera_ok('A elimina credenciales', 'authenticated', :A, $q$select public.sire_eliminar_credenciales((select id from emp))$q$);
do $$ begin insert into res(ok,prueba) values ((select count(*) from vault.secrets)=0, 'Vault queda sin secretos tras eliminar'); end $$;
select t.espera_ok('estado vuelve a «no configurado»', 'authenticated', :A,
  $q$select 1 from public.sire_credenciales_estado((select id from emp)) where not configurado$q$, 1);

-- ===== 9. Borrar la empresa limpia todo en cascada =====
do $$
declare n int;
begin
  set local role authenticated; perform set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',true);
  delete from public.sire_empresas; get diagnostics n = row_count;
  reset role;
  insert into t.res(ok,prueba) values (n=0 and (select count(*) from public.sire_empresas)=1, 'B (lector) no borra la empresa (RLS: 0 filas) [filas=' || n || ']');
end $$;
select t.espera_ok('A borra su empresa', 'authenticated', :A, $q$delete from public.sire_empresas$q$);
do $$ begin
  insert into res(ok,prueba) values ((select count(*) from public.sire_datos)=0 and (select count(*) from public.sire_tickets)=0 and (select count(*) from public.sire_miembros)=0,
    'borrado en cascada: datos, tickets y miembros');
end $$;

\echo
select case when ok then '✔' else '✘' end || ' ' || prueba as resultado from res order by n;
\echo
select count(*) filter (where ok) as ok, count(*) filter (where not ok) as fallan from res \gset
\if :fallan
  \echo 'HAY PRUEBAS FALLIDAS'
  \quit 3
\endif
