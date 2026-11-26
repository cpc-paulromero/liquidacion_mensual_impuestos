# Liquidación mensual de impuestos

**liquidacion_mensual_impuestos** (antes «SIRE → Contasis · versión web multiempresa») es la aplicación de Paul Romero · Asesoría Empresarial para preparar el **Registro de Compras SIRE → NewContaSis**,
ahora en versión web con **Supabase** (datos por empresa) y **sincronización directa con el API SIRE de SUNAT**.

Este repositorio contiene la app completa en su raíz.

```
liquidacion_mensual_impuestos/
├─ index.html                 App completa (la versión local + pestaña «API SIRE (SUNAT)»)
├─ config.js                  URL y clave anon de Supabase (vacías = modo local)
├─ js/cloud.js                Cliente Supabase por fetch (Auth, REST, Edge Functions)
├─ js/sire-sync.js            Pestaña API SIRE: credenciales, tickets, descarga, persistencia por empresa
├─ supabase/
│  ├─ migrations/…sql         Tablas, RLS, Vault, Storage
│  ├─ functions/sire-sync/    Edge Function (solicitar · estado · descargar)
│  └─ functions/_shared/      Cliente del API SUNAT + CORS
└─ tests/                     Pruebas (SUNAT simulado, interfaz, RLS)
```

## Dos formas de trabajar (conviven)

| Modo | Cuándo | Qué hace |
|---|---|---|
| **Local / manual** | `config.js` vacío, o sin iniciar sesión | Igual que siempre: cargas los archivos SIRE/PLE/XML a mano; los datos quedan en IndexedDB del navegador. |
| **Nube + API SIRE** | `config.js` completo y sesión iniciada | Las credenciales API de cada empresa se guardan cifradas; la app pide a SUNAT la propuesta de **Compras (RCE)** y de **Ventas (RVIE)** y la carga sola. Los datos de cada empresa se espejan en Supabase. |

La carga manual **no se tocó**: las pestañas *Registro de Compras* y *Registro de Ventas* siguen aceptando archivos aunque la nube esté activa.

## 1. Poner en marcha Supabase

> Recomendado: un **proyecto Supabase propio** para esta app (aquí viven credenciales API SUNAT y claves SOL).
> Las tablas llevan el prefijo `lmi_` por si se comparte proyecto con otra app (Planillas usa `empresas`).

1. **Crear el proyecto** en supabase.com y, en *Authentication → Providers*, dejar *Email* activo
   (puedes desactivar «Confirm email» si no quieres validar correos).
2. **Aplicar el esquema** — una de dos:
   - *SQL Editor* → pega **todo** `supabase/migrations/` (todos los archivos, en orden) → Run.
   - CLI: `supabase link --project-ref <REF> && supabase db push`.
   Se puede ejecutar varias veces sin perder datos.
3. **Desplegar la Edge Function** (desde ``):
   ```bash
   supabase functions deploy sire-sync --project-ref <REF>
   ```
   No necesita secretos propios (`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase).
   Opcional: `supabase secrets set SIRE_USERNAME_SEPARATOR=" "` (ver *Puntos por validar*).
4. **Conectar la web**: en `config.js` pon `SUPABASE_URL` y `SUPABASE_ANON_KEY` (*Project Settings → API*).
   La clave **anon** es pública por diseño; **nunca** pongas la `service_role` en el navegador.

## 2. Publicar la web

La carpeta es estática. Con GitHub Pages (*Settings → Pages → Deploy from a branch*) queda en
`https://<usuario>.github.io/liquidacion_mensual_impuestos/`. También sirve Netlify, Vercel o Cloudflare Pages
apuntando a la raíz del repositorio.

## 3. Uso por empresa

1. Entra a **API SIRE (SUNAT)** → crea cuenta / inicia sesión.
2. Con la empresa activa → **Registrar esta empresa en la nube** (quedas como *admin*).
3. En SUNAT Operaciones en Línea → *Empresas → Credenciales de API SUNAT* genera `client_id` y `client_secret`.
4. Guarda **RUC, client_id, client_secret, usuario SOL y clave SOL** de esa empresa. Cada empresa tiene las suyas.
5. Elige ejercicio y mes → **Sincronizar ahora** en *Compras (RCE)* y/o *Ventas (RVIE)*. Son independientes.
6. Marca *Guardar automáticamente en la nube* para que plan de cuentas, reglas y períodos queden en Supabase.
   En otro equipo: inicia sesión → **Traer a este navegador**.

## Cómo funciona la sincronización (asíncrona)

El API de SUNAT no entrega el archivo al instante ni admite llamadas desde un navegador (CORS), por eso va por una Edge Function en **dos pasos**:

```
Navegador                     Edge Function «sire-sync»                    SUNAT
   │  accion: solicitar ───────▶ valida JWT + rol editor/admin
   │                             lee credenciales (Vault, service_role)
   │                             POST token ─────────────────────────────▶ api-seguridad
   │                             GET exportar propuesta (RCE o RVIE) ────▶ api-sire   → numTicket
   │◀── ticket (lmi_tickets) ── guarda ticket
   │  accion: estado (cada ~6 s) ▶ GET consultaestadotickets ────────────▶ 05 en proceso … 06 Terminado
   │  accion: descargar ───────▶ GET archivoreporte ─────────────────────▶ ZIP
   │◀── URL firmada (10 min) ──── guarda el ZIP en Storage (privado)
   │  descarga el ZIP, extrae el .txt y lo procesa con el mismo lector de archivos de la carga manual
```

| Libro | Solicitud | codLibro |
|---|---|---|
| Compras (RCE) | `…/rce/propuesta/web/propuesta/{AAAAMM}/exportacioncomprobantepropuesta?codTipoArchivo=0&codOrigenEnvio=2` | `080000` |
| Ventas (RVIE) | `…/rvie/propuesta/web/propuesta/{AAAAMM}/exportapropuesta?codTipoArchivo=0` | `140000` |

Estado y descarga usan `…/rvierce/gestionprocesosmasivos/web/masivo/{consultaestadotickets|archivoreporte}`.
Fuente: *Manual de servicios Web API – SIRE Compras v29* y *SIRE Ventas v32* (cpe.sunat.gob.pe).
Si cierras la página con un ticket pendiente, la lista de tickets permite **Consultar estado** y **Descargar y cargar** después.

## Acceso restringido (página pública)

La web es pública, pero **solo pueden crear cuenta los correos de la tabla `lmi_acceso_permitido`**.
Un trigger sobre `auth.users` rechaza cualquier otro registro, incluso si alguien llama a la API de Supabase directamente.
Con la nube configurada, **toda la app queda detrás de una pantalla de acceso** (`js/acceso.js`): sin sesión no se ve nada más. Esa puerta controla el uso de la interfaz; la seguridad real de los datos está en Supabase (RLS y lista de correos).
El primer usuario se registra desde la pantalla de login de la app con su correo autorizado y elige su propia contraseña.

Para autorizar otro correo (SQL Editor de Supabase):

```sql
insert into public.lmi_acceso_permitido (email) values ('otro@correo.com');
```

## Seguridad de las credenciales

- `client_secret` y clave SOL se guardan **cifrados en Supabase Vault**; `lmi_credenciales` solo contiene los UUID de esos secretos.
- La tabla tiene RLS activado, sin políticas y sin privilegios para `anon`/`authenticated`: **ni el dueño puede leerla** desde el navegador.
- Se escriben con la función `lmi_guardar_credenciales` (solo *admin* de la empresa). Un secreto en blanco conserva el anterior.
- Solo la Edge Function, con `service_role`, ejecuta `lmi_obtener_credenciales` (descifra). Nunca se registran ni se devuelven secretos.
- Todas las demás tablas (`lmi_empresas`, `lmi_miembros`, `lmi_datos`, `lmi_tickets`) y el bucket `sire-archivos` tienen RLS por membresía de empresa (admin / editor / lector).
- Compartir una empresa: `select lmi_agregar_miembro('<empresa_id>', 'correo@…', 'editor')` (el usuario debe tener cuenta).

## Pruebas

```bash
node --experimental-transform-types --test tests/sunat.test.mjs   # API SUNAT simulado
python3 tests/ui_smoke.py                                         # interfaz con Supabase/SUNAT simulados
sudo bash tests/run_rls_test.sh                                   # migración + RLS en un PostgreSQL temporal
```

## Puntos por validar con credenciales reales

Estas pruebas usan simulaciones (no hay acceso a SUNAT ni a tu proyecto Supabase desde el entorno de desarrollo). Conviene confirmar con **una empresa real** y, si algo difiere, el ajuste está acotado en `supabase/functions/_shared/sunat.ts`:

- **`username` del token**: el manual SIRE escribe `{RUC} {USUARIO}`; otros manuales de SUNAT (p. ej. GRE) indican «RUC + usuario» pegados. Por defecto se **pegan** (`20123456789USUARIO`). Si SUNAT responde `invalid_grant` con credenciales correctas, prueba `SIRE_USERNAME_SEPARATOR=" "`.
- **Consulta de estado**: se envían además `codLibro` y `codOrigenEnvio` (el manual los lista en la tabla de parámetros pero no en la URL de ejemplo).
- **`codTipoArchivoReporte` nulo**: se envía el texto `null`, como indica el manual.
- **Formato del TXT**: se reutiliza el lector de la carga manual (RCE con/sin cabecera; RVIE ≥ 26 columnas). Si SUNAT cambia columnas, ajustar ahí.
- **Vault**: la migración usa `vault.create_secret` / `vault.update_secret` / `vault.decrypted_secrets` (API estándar de Supabase); se probó contra un stub, no contra Vault real.
- **Datos por empresa**: se sincronizan configuración y períodos/bases; el padrón SSCO y la plantilla global (`meta`) siguen locales. Borrar una empresa en el navegador **no** la borra en la nube.
