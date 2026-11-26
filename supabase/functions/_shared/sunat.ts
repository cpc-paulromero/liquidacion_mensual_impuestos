// Cliente del API SIRE de SUNAT (Compras RCE y Ventas RVIE).
// Lógica pura: no depende de Deno ni de Supabase, recibe `fetch` por parámetro
// para poder probarla con un servidor simulado (ver tests/sunat.test.mjs).
//
// Fuentes oficiales (SUNAT, Manuales de servicios Web API – SIRE):
//   · Manual SIRE Compras v29 y Manual SIRE Ventas v32 (cpe.sunat.gob.pe)
//   · 5.1  Servicio Api Seguridad (token)
//   · 5.34 Descargar propuesta (RCE) · RVIE «Descargar propuesta» (exportapropuesta)
//   · 5.31 Consultar estado de ticket · 5.32 Descargar archivo

export type Libro = 'compras' | 'ventas';
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const API_SEGURIDAD = 'https://api-seguridad.sunat.gob.pe';
export const API_SIRE = 'https://api-sire.sunat.gob.pe';
export const SCOPE = 'https://api-sire.sunat.gob.pe';
const BASE = '/v1/contribuyente/migeigv/libros';

/** codLibro de los servicios masivos: RCE = 080000, RVIE = 140000. */
export const COD_LIBRO: Record<Libro, string> = { compras: '080000', ventas: '140000' };
/** codOrigenEnvio: 2 = servicio web API. */
export const COD_ORIGEN_ENVIO = '2';
/** codTipoArchivo: 0 = txt. */
export const COD_TIPO_TXT = '0';

export class SunatError extends Error {
  constructor(message: string, public status?: number, public etapa?: string, public detalle?: unknown) {
    super(message);
    this.name = 'SunatError';
  }
}

export interface Credenciales {
  ruc: string;
  client_id: string;
  client_secret: string;
  usuario_sol: string;
  clave_sol: string;
}

export interface Opciones {
  fetchFn?: FetchFn;
  /** Entre el RUC y el usuario SOL en `username`. Por defecto ninguno («RUC»+«USUARIO»). */
  separadorUsername?: string;
  timeoutMs?: number;
  /** Metadatos no sensibles del token, solo para diagnóstico. */
  diag?: { tokenType?: string; expiresIn?: number; scope?: string };
}

const f = (o?: Opciones): FetchFn => o?.fetchFn ?? ((u, i) => fetch(u, i));
const signal = (o?: Opciones) => AbortSignal.timeout(o?.timeoutMs ?? 40_000);

export function validarPeriodo(p: string): string {
  if (!/^\d{6}$/.test(p ?? '')) throw new SunatError('Periodo inválido: usa AAAAMM (por ejemplo 202610).', 400, 'validacion');
  const anio = +p.slice(0, 4), mes = +p.slice(4);
  if (anio < 2000 || anio > 2100 || mes < 1 || mes > 12) throw new SunatError('Periodo fuera de rango.', 400, 'validacion');
  return p;
}

export function validarLibro(l: string): Libro {
  if (l !== 'compras' && l !== 'ventas') throw new SunatError('Libro inválido: compras o ventas.', 400, 'validacion');
  return l;
}

export function construirUsername(ruc: string, usuario: string, separador = ''): string {
  return `${ruc.trim()}${separador}${usuario.trim()}`;
}

/** Extrae un mensaje legible de las distintas formas de error que devuelve SUNAT. */
export function mensajeDeError(body: unknown, texto: string, status: number): string {
  const b = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  const partes: string[] = [];
  for (const k of ['error_description', 'msg', 'message', 'error']) {
    if (typeof b[k] === 'string' && b[k]) { partes.push(b[k] as string); break; }
  }
  if (Array.isArray(b.errors)) {
    for (const e of b.errors as Array<Record<string, unknown>>) {
      const m = (e?.msg ?? e?.message ?? e?.desError) as string | undefined;
      const c = (e?.cod ?? e?.codError) as string | undefined;
      if (m) partes.push(c ? `${c}: ${m}` : m);
    }
  }
  if (typeof b.cod === 'string' && b.cod && !partes.some((p) => p.startsWith(b.cod as string))) partes.unshift(`cod ${b.cod}`);
  if (!partes.length) {
    const t = (texto || '').trim();
    if (/^<(!doctype|html)/i.test(t)) {
      const titulo = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(t);
      partes.push(`respuesta HTML del servidor de SUNAT${titulo ? ' «' + titulo[1].trim() + '»' : ''} (HTTP ${status})`);
    } else {
      partes.push(t ? t.slice(0, 200) : `HTTP ${status}`);
    }
  }
  return partes.join(' · ');
}

/** Datos NO sensibles para diagnosticar un rechazo (nunca incluye token ni credenciales). */
export function diagnostico(res: Response, extra?: Record<string, unknown>): string {
  const h = (n: string) => res.headers.get(n);
  const partes: string[] = [`http=${res.status}`];
  for (const n of ['www-authenticate', 'server', 'x-request-id', 'content-type']) { const v = h(n); if (v) partes.push(`${n}=${v.slice(0, 80)}`); }
  for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined && v !== null && v !== '') partes.push(`${k}=${String(v).slice(0, 80)}`);
  return partes.join('; ');
}

async function leerJson(res: Response): Promise<{ body: unknown; texto: string }> {
  const texto = await res.text();
  try { return { body: JSON.parse(texto), texto }; } catch { return { body: null, texto }; }
}

/** 5.1 Servicio Api Seguridad: obtiene el access_token (OAuth2, grant password). */
export async function obtenerToken(c: Credenciales, o?: Opciones): Promise<{ accessToken: string; expiresIn: number; tokenType: string; scope: string }> {
  const url = `${API_SEGURIDAD}/v1/clientessol/${encodeURIComponent(c.client_id.trim())}/oauth2/token/`;
  const body = new URLSearchParams({
    grant_type: 'password',
    scope: SCOPE,
    client_id: c.client_id.trim(),
    client_secret: c.client_secret,
    username: construirUsername(c.ruc, c.usuario_sol, o?.separadorUsername ?? ''),
    password: c.clave_sol,
  });
  let res: Response;
  try {
    res = await f(o)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: signal(o),
    });
  } catch (e) {
    throw new SunatError(`No se pudo contactar al servicio de seguridad de SUNAT: ${(e as Error).message}`, 502, 'token');
  }
  const { body: json, texto } = await leerJson(res);
  if (!res.ok) {
    throw new SunatError(`SUNAT rechazó la autenticación (${mensajeDeError(json, texto, res.status)}). Revisa client_id, client_secret, usuario y clave SOL.`, res.status === 401 || res.status === 400 ? 401 : 502, 'token');
  }
  const j = json as Record<string, unknown> | null;
  const accessToken = j?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new SunatError('SUNAT no devolvió access_token.', 502, 'token');
  return { accessToken, expiresIn: Number(j?.expires_in) || 0, tokenType: String(j?.token_type ?? ''), scope: String(j?.scope ?? '') };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'liquidacion-mensual-impuestos/1.0' });

/** Paso 1: solicita la exportación de la propuesta y devuelve el número de ticket. */
export async function solicitarExportacion(token: string, libro: Libro, periodo: string, o?: Opciones): Promise<string> {
  validarPeriodo(periodo);
  const url = libro === 'compras'
    ? `${API_SIRE}${BASE}/rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta?codTipoArchivo=${COD_TIPO_TXT}&codOrigenEnvio=${COD_ORIGEN_ENVIO}`
    : `${API_SIRE}${BASE}/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta?codTipoArchivo=${COD_TIPO_TXT}`;
  let res: Response;
  try {
    res = await f(o)(url, { method: 'GET', headers: auth(token), signal: signal(o) });
  } catch (e) {
    throw new SunatError(`No se pudo contactar al API SIRE: ${(e as Error).message}`, 502, 'solicitar');
  }
  const { body, texto } = await leerJson(res);
  if (!res.ok) throw new SunatError(`SUNAT no aceptó la solicitud (${mensajeDeError(body, texto, res.status)}). [diag: ${diagnostico(res, { token_type: o?.diag?.tokenType, expira_s: o?.diag?.expiresIn, scope: o?.diag?.scope })}]`, res.status === 401 ? 401 : 502, 'solicitar', body);
  const t = (body as Record<string, unknown> | null)?.numTicket;
  if (typeof t !== 'string' && typeof t !== 'number') throw new SunatError('SUNAT no devolvió el número de ticket.', 502, 'solicitar', body);
  return String(t);
}

export interface ArchivoReporte { nombre: string; codTipo: string | null }
export interface EstadoTicket {
  encontrado: boolean;
  estado: 'en_proceso' | 'terminado' | 'error';
  codEstadoProceso: string | null;
  desEstadoProceso: string | null;
  codProceso: string | null;
  perTributario: string | null;
  archivos: ArchivoReporte[];
}

/**
 * Anexo III (código de estado): 01 Cargado, 02 Validando archivo, 03 Procesado con errores,
 * 04 Procesado sin errores, 05 En proceso, 06 Terminado. Para una exportación solo 06 trae archivo.
 */
export function mapearEstado(cod: string | null): EstadoTicket['estado'] {
  if (cod === '06') return 'terminado';
  if (cod === '03') return 'error';
  return 'en_proceso';
}

/** 5.31 Consultar estado de ticket. */
export async function consultarTicket(token: string, libro: Libro, periodo: string, numTicket: string, o?: Opciones): Promise<EstadoTicket> {
  validarPeriodo(periodo);
  const q = new URLSearchParams({
    perIni: periodo, perFin: periodo, page: '1', perPage: '20', numTicket,
    codLibro: COD_LIBRO[libro], codOrigenEnvio: COD_ORIGEN_ENVIO,
  });
  const url = `${API_SIRE}${BASE}/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets?${q}`;
  let res: Response;
  try {
    res = await f(o)(url, { method: 'GET', headers: auth(token), signal: signal(o) });
  } catch (e) {
    throw new SunatError(`No se pudo contactar al API SIRE: ${(e as Error).message}`, 502, 'estado');
  }
  const { body, texto } = await leerJson(res);
  if (!res.ok) throw new SunatError(`SUNAT no pudo consultar el ticket (${mensajeDeError(body, texto, res.status)}). [diag: ${diagnostico(res)}]`, res.status === 401 ? 401 : 502, 'estado', body);
  const regs = ((body as Record<string, unknown> | null)?.registros ?? []) as Array<Record<string, unknown>>;
  const r = regs.find((x) => String(x.numTicket) === numTicket) ?? regs[0];
  if (!r) return { encontrado: false, estado: 'en_proceso', codEstadoProceso: null, desEstadoProceso: null, codProceso: null, perTributario: null, archivos: [] };

  const cod = r.codEstadoProceso == null ? null : String(r.codEstadoProceso);
  const lista = Array.isArray(r.archivoReporte) ? r.archivoReporte as Array<Record<string, unknown>> : [];
  let archivos: ArchivoReporte[] = lista
    .map((a) => ({
      nombre: String(a.nomArchivoReporte ?? ''),
      // «codTipoAchivoReporte» está escrito así en el manual de SUNAT; se acepta también la forma correcta.
      codTipo: (a.codTipoAchivoReporte ?? a.codTipoArchivoReporte) == null ? null : String(a.codTipoAchivoReporte ?? a.codTipoArchivoReporte),
    }))
    .filter((a) => a.nombre);
  if (!archivos.length) {
    const nom = (r.detalleTicket as Record<string, unknown> | undefined)?.nomArchivoReporte;
    if (typeof nom === 'string' && nom) archivos = [{ nombre: nom, codTipo: null }];
  }
  return {
    encontrado: true,
    estado: mapearEstado(cod),
    codEstadoProceso: cod,
    desEstadoProceso: r.desEstadoProceso == null ? null : String(r.desEstadoProceso),
    codProceso: r.codProceso == null ? null : String(r.codProceso),
    perTributario: r.perTributario == null ? null : String(r.perTributario),
    archivos,
  };
}

/** Paso 2 (5.32): descarga un archivo generado (ZIP). Solo válido con el ticket «Terminado». */
export async function descargarArchivo(
  token: string, libro: Libro, periodo: string, numTicket: string, codProceso: string,
  archivo: ArchivoReporte, o?: Opciones,
): Promise<Uint8Array> {
  const q = new URLSearchParams({
    nomArchivoReporte: archivo.nombre,
    // El manual indica: si el valor recibido es null, se envía null.
    codTipoArchivoReporte: archivo.codTipo ?? 'null',
    perTributario: periodo,
    codProceso,
    numTicket,
    codLibro: COD_LIBRO[libro],
  });
  const url = `${API_SIRE}${BASE}/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte?${q}`;
  let res: Response;
  try {
    res = await f(o)(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'liquidacion-mensual-impuestos/1.0' }, signal: signal({ ...o, timeoutMs: o?.timeoutMs ?? 90_000 }) });
  } catch (e) {
    throw new SunatError(`No se pudo descargar el archivo: ${(e as Error).message}`, 502, 'descargar');
  }
  if (!res.ok) {
    const { body, texto } = await leerJson(res);
    throw new SunatError(`SUNAT no entregó el archivo (${mensajeDeError(body, texto, res.status)}).`, res.status === 401 ? 401 : 502, 'descargar', body);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new SunatError('SUNAT devolvió un archivo vacío.', 502, 'descargar');
  // Un error de negocio puede llegar como JSON con HTTP 200.
  if (bytes[0] === 0x7b /* { */) {
    let msg = 'SUNAT devolvió un error en lugar del archivo.';
    try { const j = JSON.parse(new TextDecoder().decode(bytes)); msg = `SUNAT no entregó el archivo (${mensajeDeError(j, '', 200)}).`; } catch { /* conserva el mensaje genérico */ }
    throw new SunatError(msg, 502, 'descargar');
  }
  return bytes;
}

/** Sondeo de diagnóstico tras un 401: variantes de envío del token (solo estados HTTP y nombres de cabeceras, sin datos sensibles). */
export async function sondear(token: string, libro: Libro, periodo: string, o?: Opciones): Promise<string> {
  const urlExp = libro === 'compras'
    ? `${API_SIRE}${BASE}/rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta?codTipoArchivo=0&codOrigenEnvio=2`
    : `${API_SIRE}${BASE}/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta?codTipoArchivo=0`;
  const pruebas: Array<[string, string, Record<string, string>]> = [
    ['bearer_minimo', urlExp, { Authorization: `Bearer ${token}` }],
    ['token_sin_bearer', urlExp, { Authorization: token, Accept: 'application/json' }],
    ['sin_token', urlExp, { Accept: 'application/json' }],
    ['ruta_inexistente', `${API_SIRE}${BASE}/zzz`, { Authorization: `Bearer ${token}` }],
  ];
  const out: string[] = [];
  for (const [n, url, headers] of pruebas) {
    try {
      const res = await f(o)(url, { method: 'GET', headers, signal: signal({ ...o, timeoutMs: 15_000 }) });
      const t = (await res.text()).slice(0, 400);
      const ti = /<title[^>]*>([^<]{1,60})<\/title>/i.exec(t);
      out.push(`${n}=${res.status}${ti ? ' «' + ti[1].trim() + '»' : ''}`);
      if (n === 'bearer_minimo') out.push(`cabeceras=${[...res.headers.keys()].join(',').slice(0, 200)}`);
    } catch { out.push(`${n}=error`); }
  }
  return out.join('; ');
}
