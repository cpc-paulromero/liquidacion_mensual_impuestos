// Pruebas de la lógica del API SIRE con un SUNAT simulado (sin red).
// Ejecutar:  node --experimental-transform-types --test tests/sunat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  construirUsername, consultarTicket, descargarArchivo, mapearEstado, obtenerToken,
  solicitarExportacion, validarPeriodo, SunatError,
} from '../supabase/functions/_shared/sunat.ts';

const cred = { ruc: '20123456789', client_id: 'abc-123', client_secret: 'S3CR3T', usuario_sol: 'MIUSUARIO', clave_sol: 'ClaveSOL1' };
const B = 'https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros';

/** SUNAT simulado: registra cada petición y responde según la ruta. */
function sunatFalso({ estado = '06', archivos = [{ codTipoAchivoReporte: '01', nomArchivoReporte: 'LE20123456789202610000804000021.zip' }], tokenOk = true } = {}) {
  const log = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    log.push({ url, u, init });
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.host === 'api-seguridad.sunat.gob.pe') {
      return tokenOk ? json({ access_token: 'TOK123', token_type: 'Bearer', expires_in: 3600 })
        : json({ error: 'invalid_grant', error_description: 'Credenciales inválidas' }, 400);
    }
    if (init.headers?.Authorization !== 'Bearer TOK123') return json({ cod: '401', msg: 'No autorizado' }, 401);
    if (u.pathname.endsWith('/exportacioncomprobantepropuesta')) return json({ numTicket: '20260000012345' });
    if (u.pathname.endsWith('/exportapropuesta')) return json({ numTicket: '20260000067890' });
    if (u.pathname.endsWith('/consultaestadotickets')) {
      return json({ paginacion: { page: 1, perPage: 20, totalRegistros: 1 }, registros: [{
        numTicket: u.searchParams.get('numTicket'), perTributario: u.searchParams.get('perIni'), codProceso: '3',
        codEstadoProceso: estado, desEstadoProceso: 'Terminado', archivoReporte: estado === '06' ? archivos : [],
        detalleTicket: { nomArchivoReporte: null },
      }] });
    }
    if (u.pathname.endsWith('/archivoreporte')) return new Response(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]), { status: 200 });
    return json({ cod: '404', msg: 'ruta desconocida ' + u.pathname }, 404);
  };
  return { fetchFn, log };
}

test('username = RUC + usuario SOL (separador configurable)', () => {
  assert.equal(construirUsername('20123456789', 'MIUSUARIO'), '20123456789MIUSUARIO');
  assert.equal(construirUsername(' 20123456789 ', ' MIUSUARIO ', ' '), '20123456789 MIUSUARIO');
});

test('periodo AAAAMM validado', () => {
  assert.equal(validarPeriodo('202610'), '202610');
  for (const p of ['2026-10', '202613', '202600', '', '19990', '189901']) assert.throws(() => validarPeriodo(p), SunatError, p);
});

test('token: URL, scope y cuerpo form-urlencoded según el manual', async () => {
  const { fetchFn, log } = sunatFalso();
  const t = await obtenerToken(cred, { fetchFn });
  assert.equal(t.accessToken, 'TOK123');
  assert.equal(t.expiresIn, 3600);
  const r = log[0];
  assert.equal(r.url, 'https://api-seguridad.sunat.gob.pe/v1/clientessol/abc-123/oauth2/token/');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const b = new URLSearchParams(r.init.body);
  assert.equal(b.get('grant_type'), 'password');
  assert.equal(b.get('scope'), 'https://api-sire.sunat.gob.pe');
  assert.equal(b.get('client_id'), 'abc-123');
  assert.equal(b.get('client_secret'), 'S3CR3T');
  assert.equal(b.get('username'), '20123456789MIUSUARIO');
  assert.equal(b.get('password'), 'ClaveSOL1');
});

test('token rechazado: error claro y sin filtrar secretos', async () => {
  const { fetchFn } = sunatFalso({ tokenOk: false });
  await assert.rejects(obtenerToken(cred, { fetchFn }), (e) => {
    assert.ok(e instanceof SunatError);
    assert.equal(e.status, 401);
    assert.match(e.message, /Credenciales inválidas/);
    for (const s of ['S3CR3T', 'ClaveSOL1']) assert.ok(!e.message.includes(s), 'el mensaje no debe contener secretos');
    return true;
  });
});

test('COMPRAS (RCE): solicitar → ticket, consultar → terminado, descargar → bytes', async () => {
  const { fetchFn, log } = sunatFalso();
  const o = { fetchFn };
  const { accessToken } = await obtenerToken(cred, o);
  const ticket = await solicitarExportacion(accessToken, 'compras', '202610', o);
  assert.equal(ticket, '20260000012345');
  const sol = log.at(-1);
  assert.equal(sol.init.method, 'GET');
  assert.equal(sol.url, `${B}/rce/propuesta/web/propuesta/202610/exportacioncomprobantepropuesta?codTipoArchivo=0&codOrigenEnvio=2`);
  assert.equal(sol.init.headers.Authorization, 'Bearer TOK123');

  const est = await consultarTicket(accessToken, 'compras', '202610', ticket, o);
  const c = log.at(-1).u;
  assert.equal(c.pathname, '/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets');
  assert.equal(c.searchParams.get('perIni'), '202610');
  assert.equal(c.searchParams.get('perFin'), '202610');
  assert.equal(c.searchParams.get('numTicket'), ticket);
  assert.equal(c.searchParams.get('codLibro'), '080000');
  assert.equal(est.estado, 'terminado');
  assert.equal(est.codProceso, '3');
  assert.deepEqual(est.archivos, [{ nombre: 'LE20123456789202610000804000021.zip', codTipo: '01' }]);

  const bytes = await descargarArchivo(accessToken, 'compras', '202610', ticket, est.codProceso, est.archivos[0], o);
  const d = log.at(-1).u;
  assert.equal(d.pathname, '/v1/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte');
  assert.equal(d.searchParams.get('nomArchivoReporte'), 'LE20123456789202610000804000021.zip');
  assert.equal(d.searchParams.get('codTipoArchivoReporte'), '01');
  assert.equal(d.searchParams.get('perTributario'), '202610');
  assert.equal(d.searchParams.get('codProceso'), '3');
  assert.equal(d.searchParams.get('numTicket'), ticket);
  assert.equal(d.searchParams.get('codLibro'), '080000');
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b]);
});

test('VENTAS (RVIE): usa exportapropuesta y codLibro 140000, independiente de compras', async () => {
  const { fetchFn, log } = sunatFalso();
  const o = { fetchFn };
  const { accessToken } = await obtenerToken(cred, o);
  const ticket = await solicitarExportacion(accessToken, 'ventas', '202610', o);
  assert.equal(ticket, '20260000067890');
  assert.equal(log.at(-1).url, `${B}/rvie/propuesta/web/propuesta/202610/exportapropuesta?codTipoArchivo=0`);
  await consultarTicket(accessToken, 'ventas', '202610', ticket, o);
  assert.equal(log.at(-1).u.searchParams.get('codLibro'), '140000');
  const est = await consultarTicket(accessToken, 'ventas', '202610', ticket, o);
  await descargarArchivo(accessToken, 'ventas', '202610', ticket, est.codProceso, est.archivos[0], o);
  assert.equal(log.at(-1).u.searchParams.get('codLibro'), '140000');
});

test('estados: solo 06 es terminado; 03 es error; el resto sigue en proceso', async () => {
  assert.equal(mapearEstado('06'), 'terminado');
  assert.equal(mapearEstado('03'), 'error');
  for (const c of ['01', '02', '04', '05', null]) assert.equal(mapearEstado(c), 'en_proceso', String(c));
  const { fetchFn } = sunatFalso({ estado: '05' });
  const est = await consultarTicket('TOK123', 'compras', '202610', 'T1', { fetchFn });
  assert.equal(est.estado, 'en_proceso');
  assert.deepEqual(est.archivos, []);
});

test('codTipoArchivoReporte nulo se envía como «null» (manual SUNAT)', async () => {
  const { fetchFn, log } = sunatFalso();
  await descargarArchivo('TOK123', 'compras', '202610', 'T1', '3', { nombre: 'x.zip', codTipo: null }, { fetchFn });
  assert.equal(log.at(-1).u.searchParams.get('codTipoArchivoReporte'), 'null');
});

test('errores del API SIRE se traducen a mensaje legible', async () => {
  const fetchFn = async () => new Response(JSON.stringify({ cod: '2244', msg: 'No existe el archivo', errors: [{ cod: '2244', msg: 'Archivo no encontrado' }] }), { status: 400 });
  await assert.rejects(solicitarExportacion('TOK123', 'compras', '202610', { fetchFn }), /2244.*Archivo no encontrado/);
  const json200 = async () => new Response(JSON.stringify({ cod: '2244', msg: 'No existe el archivo' }), { status: 200 });
  await assert.rejects(descargarArchivo('T', 'compras', '202610', 'T1', '3', { nombre: 'x.zip', codTipo: null }, { fetchFn: json200 }), /No existe el archivo/);
});

test('token vencido (401) se informa como 401 para que la app pida reintento', async () => {
  const { fetchFn } = sunatFalso();
  await assert.rejects(solicitarExportacion('TOKEN-MALO', 'compras', '202610', { fetchFn }), (e) => e.status === 401);
});
