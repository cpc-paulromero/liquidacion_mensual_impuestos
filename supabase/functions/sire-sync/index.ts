// Edge Function «sire-sync»: sincronización con el API SIRE de SUNAT por empresa.
//
// El navegador no puede llamar al API de SUNAT (CORS) ni debe ver las credenciales,
// por eso todo pasa por aquí. El flujo de SUNAT es asíncrono, así que se divide en 3 acciones:
//
//   1. solicitar  → pide la exportación de la propuesta y guarda el ticket (lmi_tickets)
//   2. estado     → consulta a SUNAT el estado del ticket (06 = Terminado)
//   3. descargar  → baja el ZIP, lo guarda en Storage y devuelve URLs firmadas de corta vida
//
// Cada acción se ejecuta con la identidad del usuario (JWT) para validar que sea
// editor/admin de la empresa; las credenciales se descifran con service_role y nunca salen de aquí.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import {
  type Credenciales, type Libro, SunatError, consultarTicket, descargarArchivo,
  obtenerToken, solicitarExportacion, validarLibro, validarPeriodo,
} from '../_shared/sunat.ts';

const URL_SB = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'sire-archivos';
const SEPARADOR = Deno.env.get('SIRE_USERNAME_SEPARATOR') ?? '';
const VENTANA_REUSO_MS = 10 * 60 * 1000;
const URL_VIGENCIA_S = 600;

type Ticket = {
  id: string; empresa_id: string; libro: Libro; periodo: string; num_ticket: string;
  estado: string; cod_proceso: string | null; archivos: Array<{ nombre: string; codTipo: string | null; path?: string }>;
  created_at: string;
};

const aviso = (e: unknown) => (e instanceof SunatError ? e.message : (e as Error)?.message ?? String(e));
// Un 401 de SUNAT (credenciales/token rechazados) NO es una sesión vencida del usuario: el navegador
// reintentaría refrescando su sesión. Se informa como 422; el 401 queda reservado para la sesión de Supabase.
const statusDe = (e: unknown) => {
  if (!(e instanceof SunatError) || !e.status) return 500;
  return e.status === 401 ? 422 : e.status;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  try {
    const authz = req.headers.get('Authorization');
    if (!authz) return json({ ok: false, error: 'Falta la sesión (Authorization).' }, 401);

    const userDb = createClient(URL_SB, ANON, { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
    const jwt = authz.replace(/^Bearer\s+/i, '');
    const { data: u, error: eu } = await userDb.auth.getUser(jwt);   // con persistSession:false hay que pasar el JWT
    if (eu || !u?.user) return json({ ok: false, error: 'Sesión inválida o vencida. Inicia sesión de nuevo.' }, 401);
    const userId = u.user.id;
    const admin = createClient(URL_SB, SERVICE, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const accion = String(body.accion ?? '');

    // ---------- helpers con acceso a la sesión ----------
    const exigirEditor = async (empresaId: string) => {
      if (!/^[0-9a-f-]{36}$/i.test(empresaId ?? '')) throw new SunatError('empresa_id inválido.', 400, 'validacion');
      const { data, error } = await userDb.rpc('lmi_puede_editar', { p_empresa: empresaId });
      if (error) throw new SunatError(`No se pudo validar el permiso: ${error.message}`, 500, 'permiso');
      if (!data) throw new SunatError('No tienes permiso de editor sobre esta empresa.', 403, 'permiso');
    };

    const cargarTicket = async (ticketId: string): Promise<Ticket> => {
      const { data, error } = await userDb.from('lmi_tickets').select('*').eq('id', ticketId).maybeSingle();
      if (error) throw new SunatError(error.message, 500, 'ticket');
      if (!data) throw new SunatError('Ticket no encontrado.', 404, 'ticket');
      await exigirEditor(data.empresa_id);
      return data as Ticket;
    };

    const tokenDe = async (empresaId: string): Promise<{ token: string; cred: Credenciales }> => {
      const { data, error } = await admin.rpc('lmi_obtener_credenciales', { p_empresa: empresaId });
      if (error) throw new SunatError(`No se pudieron leer las credenciales: ${error.message}`, 500, 'credenciales');
      const c = Array.isArray(data) ? data[0] : data;
      if (!c) throw new SunatError('Esta empresa aún no tiene credenciales API SUNAT. Configúralas primero.', 409, 'credenciales');
      const cred: Credenciales = { ruc: c.ruc, client_id: c.client_id, client_secret: c.client_secret, usuario_sol: c.usuario_sol, clave_sol: c.clave_sol };
      try {
        const t = await obtenerToken(cred, { separadorUsername: SEPARADOR });
        await admin.rpc('lmi_marcar_credenciales', { p_empresa: empresaId, p_ok: true });
        return { token: t.accessToken, cred };
      } catch (e) {
        await admin.rpc('lmi_marcar_credenciales', { p_empresa: empresaId, p_ok: false, p_error: aviso(e) });
        throw e;
      }
    };

    const urlsFirmadas = async (archivos: Ticket['archivos']) => {
      const out: Array<{ nombre: string; url: string }> = [];
      for (const a of archivos) {
        if (!a.path) continue;
        const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(a.path, URL_VIGENCIA_S);
        if (error || !data) throw new SunatError(`No se pudo firmar la descarga de ${a.nombre}.`, 500, 'storage');
        out.push({ nombre: a.nombre, url: data.signedUrl });
      }
      return out;
    };

    // ======================= 1. SOLICITAR =======================
    if (accion === 'solicitar') {
      const empresaId = String(body.empresa_id ?? '');
      const libro = validarLibro(String(body.libro ?? ''));
      const periodo = validarPeriodo(String(body.periodo ?? ''));
      await exigirEditor(empresaId);

      // Idempotencia: si ya hay un ticket reciente sin terminar para lo mismo, se reutiliza.
      const desde = new Date(Date.now() - VENTANA_REUSO_MS).toISOString();
      const { data: previos } = await admin.from('lmi_tickets').select('*')
        .eq('empresa_id', empresaId).eq('libro', libro).eq('periodo', periodo)
        .in('estado', ['solicitado', 'en_proceso']).gte('created_at', desde)
        .order('created_at', { ascending: false }).limit(1);
      if (previos && previos.length) return json({ ok: true, reutilizado: true, ticket: previos[0] });

      const { token } = await tokenDe(empresaId);
      const numTicket = await solicitarExportacion(token, libro, periodo, {});
      const { data: t, error } = await admin.from('lmi_tickets').upsert({
        empresa_id: empresaId, libro, periodo, num_ticket: numTicket, estado: 'solicitado',
        solicitado_por: userId, detalle_error: null,
      }, { onConflict: 'empresa_id,libro,num_ticket' }).select('*').single();
      if (error) throw new SunatError(`Ticket generado (${numTicket}) pero no se pudo guardar: ${error.message}`, 500, 'ticket');
      return json({ ok: true, ticket: t });
    }

    // ======================= 2. ESTADO =======================
    if (accion === 'estado') {
      const t = await cargarTicket(String(body.ticket_id ?? ''));
      if (t.estado === 'descargado') return json({ ok: true, ticket: t });
      const { token } = await tokenDe(t.empresa_id);
      const est = await consultarTicket(token, t.libro, t.periodo, t.num_ticket, {});
      const cambios = {
        estado: est.encontrado ? est.estado : t.estado,
        cod_estado_proceso: est.codEstadoProceso,
        des_estado_proceso: est.desEstadoProceso,
        cod_proceso: est.codProceso,
        archivos: est.archivos.length ? est.archivos : t.archivos,
        detalle_error: est.estado === 'error' ? (est.desEstadoProceso ?? 'SUNAT procesó el ticket con errores.') : null,
      };
      const { data, error } = await admin.from('lmi_tickets').update(cambios).eq('id', t.id).select('*').single();
      if (error) throw new SunatError(error.message, 500, 'ticket');
      return json({ ok: true, ticket: data });
    }

    // ======================= 3. DESCARGAR =======================
    if (accion === 'descargar') {
      let t = await cargarTicket(String(body.ticket_id ?? ''));

      // Ya descargado antes: solo se vuelven a firmar las URLs.
      if (t.estado === 'descargado' && t.archivos.every((a) => a.path)) {
        return json({ ok: true, ticket: t, archivos: await urlsFirmadas(t.archivos) });
      }
      if (t.estado !== 'terminado' && t.estado !== 'descargado') {
        throw new SunatError('El ticket todavía no está terminado en SUNAT. Consulta el estado de nuevo en unos segundos.', 409, 'descargar');
      }

      const { token } = await tokenDe(t.empresa_id);
      if (!t.archivos.length || !t.cod_proceso) {
        const est = await consultarTicket(token, t.libro, t.periodo, t.num_ticket, {});
        if (est.estado !== 'terminado' || !est.archivos.length || !est.codProceso) {
          throw new SunatError('SUNAT aún no informa el archivo de este ticket.', 409, 'descargar');
        }
        t = { ...t, cod_proceso: est.codProceso, archivos: est.archivos };
      }

      const guardados: Ticket['archivos'] = [];
      for (const a of t.archivos) {
        const bytes = await descargarArchivo(token, t.libro, t.periodo, t.num_ticket, t.cod_proceso!, a, {});
        const path = `${t.empresa_id}/${t.libro}/${t.periodo}/${t.num_ticket}/${a.nombre.replace(/[^\w.\-]/g, '_')}`;
        const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/zip', upsert: true });
        if (error) throw new SunatError(`No se pudo guardar ${a.nombre}: ${error.message}`, 500, 'storage');
        guardados.push({ nombre: a.nombre, codTipo: a.codTipo, path });
      }
      const { data, error } = await admin.from('lmi_tickets')
        .update({ estado: 'descargado', archivos: guardados, cod_proceso: t.cod_proceso, detalle_error: null })
        .eq('id', t.id).select('*').single();
      if (error) throw new SunatError(error.message, 500, 'ticket');
      return json({ ok: true, ticket: data, archivos: await urlsFirmadas(guardados) });
    }

    return json({ ok: false, error: `Acción desconocida: ${accion || '(vacía)'}` }, 400);
  } catch (e) {
    // Nunca se registran ni devuelven credenciales; solo el mensaje ya saneado.
    console.error('sire-sync:', aviso(e));
    return json({ ok: false, etapa: e instanceof SunatError ? e.etapa : undefined, error: aviso(e) }, statusDe(e));
  }
});
