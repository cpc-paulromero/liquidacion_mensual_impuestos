/* Cliente mínimo de Supabase por fetch (Auth + PostgREST + Edge Functions). Sin dependencias.
   Se expone como window.Cloud. Si config.js no tiene URL/clave, Cloud.enabled = false y la app
   sigue funcionando en modo local. */
(function () {
  'use strict';
  const CFG = window.SIRE_CONFIG || {};
  const BASE = String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = String(CFG.SUPABASE_ANON_KEY || '');
  const LS = 'sire_contasis_session';
  const enabled = !!(BASE && KEY);
  const listeners = [];
  let S = null;
  try { S = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { S = null; }

  function setSession(s) {
    S = s || null;
    try { S ? localStorage.setItem(LS, JSON.stringify(S)) : localStorage.removeItem(LS); } catch (e) { /* almacenamiento no disponible */ }
    listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  }
  function sesionDe(j) {
    if (!j || !j.access_token) return null;
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000,
      user: j.user ? { id: j.user.id, email: j.user.email } : (S && S.user) || null,
    };
  }
  function mensaje(j, status) {
    if (!j || typeof j !== 'object') return 'Error HTTP ' + status;
    return j.message || j.msg || j.error_description || j.error || ('Error HTTP ' + status);
  }
  async function crudo(path, opt) {
    const o = opt || {};
    const headers = Object.assign({ apikey: KEY }, o.headers || {});
    if (o.auth !== false) headers.Authorization = 'Bearer ' + ((S && S.access_token) || KEY);
    if (o.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(BASE + path, { method: o.method || 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    } catch (e) { throw new Error('Sin conexión con Supabase: ' + e.message); }
    const texto = await res.text();
    let j = null; try { j = texto ? JSON.parse(texto) : null; } catch (e) { j = null; }
    if (!res.ok) { const err = new Error(mensaje(j, res.status)); err.status = res.status; err.body = j; throw err; }
    return j;
  }
  let refrescando = null;
  async function refrescar() {
    if (!S || !S.refresh_token) throw new Error('Sesión vencida. Inicia sesión de nuevo.');
    if (!refrescando) {
      refrescando = crudo('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: S.refresh_token } })
        .then((j) => { setSession(sesionDe(j)); })
        .catch((e) => { setSession(null); throw new Error('Sesión vencida. Inicia sesión de nuevo.'); })
        .finally(() => { refrescando = null; });
    }
    return refrescando;
  }
  async function http(path, opt) {
    if (!enabled) throw new Error('La nube no está configurada (config.js).');
    if (S && S.expires_at - Date.now() < 60000) await refrescar();
    try { return await crudo(path, opt); }
    catch (e) {
      if (e.status === 401 && S && S.refresh_token && !(opt && opt._reintento)) {
        await refrescar();
        return crudo(path, opt);
      }
      throw e;
    }
  }
  const qs = (q) => (q ? '?' + q : '');

  window.Cloud = {
    enabled,
    get logged() { return !!(S && S.access_token); },
    get user() { return S ? S.user : null; },
    on(f) { listeners.push(f); },
    async login(email, password) {
      const j = await crudo('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
      setSession(sesionDe(j));
    },
    async signup(email, password) {
      const j = await crudo('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password } });
      const s = sesionDe(j);
      if (s) { setSession(s); return { confirmar: false }; }
      return { confirmar: true };   // el proyecto exige confirmar el correo
    },
    logout() { setSession(null); },
    /** SELECT en PostgREST. q: «select=*&empresa_id=eq.…&order=…» */
    select(tabla, q) { return http('/rest/v1/' + tabla + qs(q)); },
    /** INSERT (o upsert con onConflict). */
    insert(tabla, filas, o) {
      const op = o || {};
      const pref = [op.upsert ? 'resolution=merge-duplicates' : '', op.devolver ? 'return=representation' : 'return=minimal'].filter(Boolean).join(',');
      return http('/rest/v1/' + tabla + (op.onConflict ? '?on_conflict=' + op.onConflict : ''), { method: 'POST', body: filas, headers: { Prefer: pref } });
    },
    borrar(tabla, q) { return http('/rest/v1/' + tabla + qs(q), { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); },
    rpc(nombre, args) { return http('/rest/v1/rpc/' + nombre, { method: 'POST', body: args || {} }); },
    /** Edge Function. */
    fn(nombre, body) { return http('/functions/v1/' + nombre, { method: 'POST', body: body || {} }); },
  };
})();
