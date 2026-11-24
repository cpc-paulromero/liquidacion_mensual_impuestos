/* Pestaña «API SIRE (SUNAT)»: nube multiempresa + sincronización con el API SIRE.
   Se carga DESPUÉS del script principal de index.html y reutiliza sus funciones globales
   (DB, emp, cargarTipo, detectarArchivo, render, A, toast, ask, esc, …).
   La carga manual de archivos (pestañas Registro de Compras / Ventas) no se toca. */
(function () {
  'use strict';
  const SY = window.SireSync = {};
  const LS_AUTO = 'sire_contasis_auto';
  const st = {
    empresas: [], roles: {}, cargado: false, cargando: false, err: '',
    cred: null, tickets: [], busy: { compras: false, ventas: false }, log: { compras: [], ventas: [] },
    anio: null, mes: null, auto: false, lastCfg: {}, aplicando: false, stat: '',
  };
  try { st.auto = localStorage.getItem(LS_AUTO) === '1'; } catch (e) { /* sin almacenamiento */ }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LIBROS = { compras: 'Registro de Compras (RCE)', ventas: 'Registro de Ventas (RVIE)' };
  const ESTADOS = {
    solicitado: ['Solicitado', 'b-gray'], en_proceso: ['En proceso en SUNAT', 'b-warn'],
    terminado: ['Terminado · listo para descargar', 'b-ok'], descargado: ['Descargado', 'b-ok'], error: ['Con error', 'b-err'],
  };
  const el = (id) => document.getElementById(id);
  const hoy = new Date();
  function periodoPorDefecto() {
    if (typeof P !== 'undefined' && P && P.anio) return [P.anio, P.mes];
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);   // mes anterior
    return [d.getFullYear(), d.getMonth() + 1];
  }
  if (!st.anio) [st.anio, st.mes] = periodoPorDefecto();

  const cloudEmpDe = (ruc) => st.empresas.find((x) => x.ruc === ruc) || null;
  const cloudEmp = () => (DB && DB.activa ? cloudEmpDe(DB.activa) : null);
  const rolActual = () => { const c = cloudEmp(); return c ? (st.roles[c.id] || null) : null; };
  const puedeEditar = () => ['admin', 'editor'].includes(rolActual());
  const esAdmin = () => rolActual() === 'admin';
  const periodoStr = () => `${st.anio}${String(st.mes).padStart(2, '0')}`;

  /* ---------------- estado en la cabecera ---------------- */
  function pintarEstado(extra) {
    const b = el('cloudStat'); if (!b) return;
    if (!Cloud.enabled) b.textContent = 'Modo local · los archivos no salen del navegador';
    else if (!Cloud.logged) b.textContent = '☁ Nube: iniciar sesión';
    else b.textContent = '☁ ' + (Cloud.user ? Cloud.user.email : 'sesión') + (extra || st.stat ? ' · ' + (extra || st.stat) : '');
  }

  /* ---------------- carga de datos de la nube ---------------- */
  async function refrescar(redibujar) {
    if (!Cloud.enabled || !Cloud.logged) return;
    st.cargando = true; st.err = '';
    try {
      st.empresas = await Cloud.select('sire_empresas', 'select=id,ruc,razon_social,created_by&order=created_at.asc') || [];
      const m = await Cloud.select('sire_miembros', `select=empresa_id,rol&user_id=eq.${Cloud.user.id}`) || [];
      st.roles = {}; m.forEach((x) => { st.roles[x.empresa_id] = x.rol; });
      st.cred = null; st.tickets = [];
      const c = cloudEmp();
      if (c) {
        if (puedeEditar()) { const r = await Cloud.rpc('sire_credenciales_estado', { p_empresa: c.id }); st.cred = Array.isArray(r) ? r[0] : r; }
        st.tickets = await Cloud.select('sire_tickets', `select=*&empresa_id=eq.${c.id}&order=created_at.desc&limit=30`) || [];
      }
      st.cargado = true;
    } catch (e) { st.err = e.message; console.error(e); }
    st.cargando = false;
    pintarEstado();
    if (redibujar !== false && TAB === 'sire') render();
  }
  async function cargarTickets() {
    const c = cloudEmp(); if (!c) return;
    st.tickets = await Cloud.select('sire_tickets', `select=*&empresa_id=eq.${c.id}&order=created_at.desc&limit=30`) || [];
    pintarTickets();
  }

  /* ---------------- vistas ---------------- */
  function selPeriodo() {
    const anios = []; for (let a = hoy.getFullYear(); a >= hoy.getFullYear() - 6; a--) anios.push(a);
    return `<div class="row"><div><label>Ejercicio</label><select id="sy_anio" onchange="SireSync.setPeriodo()">${anios.map((a) => `<option ${a === st.anio ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
      <div><label>Mes</label><select id="sy_mes" onchange="SireSync.setPeriodo()">${MESES.map((n, i) => `<option value="${i + 1}" ${i + 1 === st.mes ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <span class="muted small" style="align-self:center">Periodo tributario: <b>${periodoStr()}</b></span></div>`;
  }
  function cardLibro(libro) {
    const dis = st.busy[libro] || !st.cred || !st.cred.configurado || !puedeEditar();
    return `<div class="card"><h2>${LIBROS[libro]}</h2>
      <p class="muted small">${libro === 'compras'
        ? 'Descarga la propuesta del RCE del período y la carga en «Registro de Compras».'
        : 'Descarga la propuesta del RVIE del período y la carga en «Registro de Ventas».'} Es independiente del otro libro.</p>
      <div class="row"><button class="b p" ${dis ? 'disabled' : ''} onclick="SireSync.sync('${libro}')">${st.busy[libro] ? 'Sincronizando…' : 'Sincronizar ahora (' + periodoStr() + ')'}</button>
      <button class="b" ${dis ? 'disabled' : ''} onclick="SireSync.soloSolicitar('${libro}')">Solo solicitar ticket</button></div>
      <div id="sy_log_${libro}" class="small" style="margin-top:8px">${htmlLog(libro)}</div></div>`;
  }
  function htmlLog(libro) {
    return st.log[libro].map((l) => `<div class="${l.k === 'err' ? 'msg m-err' : l.k === 'ok' ? 'msg m-ok' : 'muted'}" style="${l.k ? '' : 'padding:1px 0'}">${esc(l.t)}</div>`).join('');
  }
  function log(libro, t, k) {
    st.log[libro].push({ t: new Date().toLocaleTimeString('es-PE') + ' · ' + t, k });
    if (st.log[libro].length > 40) st.log[libro].shift();
    const d = el('sy_log_' + libro); if (d) d.innerHTML = htmlLog(libro);
  }
  function pintarTickets() {
    const d = el('sy_tickets'); if (!d) return;
    if (!st.tickets.length) { d.innerHTML = '<p class="muted small">Todavía no hay tickets para esta empresa.</p>'; return; }
    d.innerHTML = `<div class="scroll" style="max-height:340px"><table><tr><th>Solicitado</th><th>Libro</th><th>Periodo</th><th>N° ticket</th><th>Estado</th><th>Archivos</th><th></th></tr>` +
      st.tickets.map((t) => {
        const [lab, cls] = ESTADOS[t.estado] || [t.estado, 'b-gray'];
        const lista = (t.archivos || []).map((a) => esc(a.nombre)).join('<br>');
        const acc = [];
        if (!['descargado', 'error'].includes(t.estado)) acc.push(`<button class="b" onclick="SireSync.consultar('${t.id}')">Consultar estado</button>`);
        if (['terminado', 'descargado'].includes(t.estado)) acc.push(`<button class="b p" onclick="SireSync.descargarTicket('${t.id}')">Descargar y cargar</button>`);
        return `<tr><td>${new Date(t.created_at).toLocaleString('es-PE')}</td><td>${t.libro === 'compras' ? 'Compras' : 'Ventas'}</td><td>${esc(t.periodo)}</td><td>${esc(t.num_ticket)}</td>
          <td><span class="badge ${cls}">${esc(lab)}</span>${t.detalle_error ? `<div class="small" style="color:var(--err)">${esc(t.detalle_error)}</div>` : ''}</td>
          <td class="small">${lista || '—'}</td><td>${acc.join(' ')}</td></tr>`;
      }).join('') + '</table></div>';
  }

  SY.view = function () {
    if (!Cloud.enabled) {
      return `<div class="card"><h2>API SIRE (SUNAT) y nube multiempresa</h2>
        <div class="msg m-info">La nube no está configurada: la app funciona en <b>modo local</b> (carga manual de archivos, datos en este navegador).</div>
        <p class="small">Para activar la sincronización automática con SUNAT y el guardado por empresa en Supabase, completa <code>config.js</code>
        (<code>SUPABASE_URL</code> y <code>SUPABASE_ANON_KEY</code>), ejecuta la migración de <code>supabase/migrations</code> y despliega la función <code>sire-sync</code>. Los pasos están en el <code>README.md</code> de esta carpeta.</p></div>`;
    }
    if (!Cloud.logged) {
      return `<div class="card"><h2>Cuenta en la nube</h2>
        <p class="muted small">Inicia sesión para guardar tus empresas en Supabase y sincronizar con el API SIRE de SUNAT. Sin sesión, la carga manual sigue funcionando igual.</p>
        <div class="row"><div><label>Correo</label><input id="sy_mail" type="text" autocomplete="username" style="width:260px"></div>
        <div><label>Contraseña</label><input id="sy_pw" type="password" autocomplete="current-password" style="width:200px"></div>
        <button class="b p" onclick="SireSync.entrar()">Entrar</button><button class="b" onclick="SireSync.registrar()">Crear cuenta</button></div>
        ${st.err ? `<div class="msg m-err">${esc(st.err)}</div>` : ''}</div>`;
    }
    if (!st.cargado && !st.cargando) setTimeout(() => refrescar(), 0);
    const e = emp(), c = cloudEmp();
    let h = `<div class="card"><h2>Cuenta en la nube</h2><div class="row" style="align-items:center"><span>Sesión: <b>${esc(Cloud.user ? Cloud.user.email : '')}</b></span>
      <button class="b" onclick="SireSync.salir()">Cerrar sesión</button><button class="b" onclick="SireSync.recargar()">Actualizar</button></div>
      ${st.cargando ? '<p class="muted small">Cargando datos de la nube…</p>' : ''}${st.err ? `<div class="msg m-err">${esc(st.err)}</div>` : ''}</div>`;
    if (!e) return h + sinEmpresa();

    /* ---- empresa en la nube + persistencia ---- */
    const otras = st.empresas.filter((x) => !DB.empresas[x.ruc]);
    h += `<div class="card"><h2>Empresa en la nube: ${esc(e.nombre)} <span class="muted small">(${esc(e.ruc)})</span></h2>`;
    if (!c) {
      h += `<p class="small">Esta empresa todavía no está en la nube.</p><button class="b p" onclick="SireSync.registrarEmpresa()">Registrar esta empresa en la nube</button>`;
    } else {
      h += `<p class="small">Registrada · tu rol: <span class="badge b-ok">${esc(rolActual() || '—')}</span></p>
        <label style="display:flex;gap:6px;align-items:center;color:var(--ink);font-size:13px"><input type="checkbox" ${st.auto ? 'checked' : ''} ${puedeEditar() ? '' : 'disabled'} onchange="SireSync.setAuto(this.checked)">
        Guardar automáticamente en la nube lo que proceso en esta empresa (plan de cuentas, reglas, períodos)</label>
        <div class="row" style="margin-top:8px"><button class="b" ${puedeEditar() ? '' : 'disabled'} onclick="SireSync.subirTodo()">Subir todo ahora</button>
        <button class="b" onclick="SireSync.traer('${e.ruc}')">Traer de la nube (reemplaza lo local)</button></div>`;
    }
    if (otras.length) {
      h += `<h3>Otras empresas tuyas en la nube</h3>` + otras.map((x) => `<div class="mes" style="padding:4px 0"><b>${esc(x.ruc)}</b> ${esc(x.razon_social)} <button class="b" onclick="SireSync.traer('${x.ruc}')">Traer a este navegador</button></div>`).join('');
    }
    h += `</div>`;
    if (!c) return h;

    /* ---- credenciales ---- */
    const cr = st.cred || {};
    h += `<div class="card"><h2>Credenciales API SUNAT de ${esc(e.nombre)}</h2>
      <p class="muted small">Se obtienen en SUNAT Operaciones en Línea → Empresas → Credenciales de API SUNAT. Se guardan <b>cifradas en Supabase Vault</b>, por empresa; el navegador nunca puede volver a leerlas.</p>
      ${cr.configurado ? `<div class="msg m-ok">Configuradas · usuario SOL <b>${esc(cr.usuario_sol)}</b> · client_id <code>${esc(cr.client_id)}</code>${cr.ultimo_ok ? ' · último acceso correcto: ' + esc(new Date(cr.ultimo_ok).toLocaleString('es-PE')) : ''}</div>` : '<div class="msg m-warn">Aún no hay credenciales para esta empresa.</div>'}
      ${cr.ultimo_error ? `<div class="msg m-err">Último error de SUNAT: ${esc(cr.ultimo_error)}</div>` : ''}
      ${esAdmin() ? `<div class="row"><div><label>RUC</label><input id="sy_ruc" value="${esc(cr.ruc || e.ruc)}" maxlength="11" style="width:130px"></div>
        <div><label>client_id</label><input id="sy_cid" value="${esc(cr.client_id || '')}" autocomplete="off" style="width:300px"></div>
        <div><label>client_secret ${cr.configurado ? '(vacío = conservar)' : ''}</label><input id="sy_cs" type="password" autocomplete="new-password" style="width:220px"></div></div>
        <div class="row" style="margin-top:6px"><div><label>Usuario SOL</label><input id="sy_user" value="${esc(cr.usuario_sol || '')}" autocomplete="off" style="width:170px"></div>
        <div><label>Clave SOL ${cr.configurado ? '(vacío = conservar)' : ''}</label><input id="sy_pass" type="password" autocomplete="new-password" style="width:200px"></div>
        <button class="b p" onclick="SireSync.guardarCreds()">Guardar credenciales</button>${cr.configurado ? '<button class="b d" onclick="SireSync.borrarCreds()">Eliminar</button>' : ''}</div>`
        : '<p class="muted small">Solo un administrador de la empresa puede editar las credenciales.</p>'}</div>`;

    /* ---- sincronización ---- */
    h += `<div class="card"><h2>Sincronizar con SUNAT</h2>${selPeriodo()}
      <p class="muted small">SUNAT no entrega el archivo al instante: primero se solicita un <b>ticket</b> y, cuando está <b>Terminado</b>, se descarga el ZIP. La app hace ambos pasos sola; si cierras la página, retómalo desde la lista de tickets.</p></div>`;
    h += cardLibro('compras') + cardLibro('ventas');
    h += `<div class="card"><h2>Tickets de ${esc(e.nombre)}</h2><div id="sy_tickets"></div></div>`;
    h += `<div class="msg m-info small">La carga manual de archivos sigue disponible en <b>Registro de Compras</b> y <b>Registro de Ventas</b>.</div>`;
    setTimeout(pintarTickets, 0);
    return h;
  };

  /* ---------------- sesión ---------------- */
  SY.entrar = async () => {
    try { await Cloud.login(el('sy_mail').value.trim(), el('sy_pw').value); st.cargado = false; st.err = ''; toast('Sesión iniciada.'); }
    catch (e) { st.err = e.message; }
    render();
  };
  SY.registrar = async () => {
    try {
      const r = await Cloud.signup(el('sy_mail').value.trim(), el('sy_pw').value); st.cargado = false; st.err = '';
      toast(r.confirmar ? 'Cuenta creada: confirma tu correo y luego inicia sesión.' : 'Cuenta creada e iniciada.');
    } catch (e) { st.err = e.message; }
    render();
  };
  SY.salir = () => { Cloud.logout(); st.cargado = false; st.empresas = []; st.cred = null; st.tickets = []; pintarEstado(); render(); };
  SY.recargar = () => { st.cargado = false; refrescar(); };
  SY.setPeriodo = () => { st.anio = +el('sy_anio').value; st.mes = +el('sy_mes').value; render(); };
  SY.setAuto = (v) => { st.auto = !!v; try { localStorage.setItem(LS_AUTO, v ? '1' : '0'); } catch (e) { /* ok */ } if (v) SY.subirTodo(); };

  /* ---------------- empresa y credenciales ---------------- */
  SY.registrarEmpresa = async () => {
    const e = emp(); if (!e) return;
    try { await Cloud.insert('sire_empresas', { ruc: e.ruc, razon_social: e.nombre }); toast('Empresa registrada en la nube.'); await refrescar(false); }
    catch (err) { toast(/duplicate|unique/i.test(err.message) ? 'Esa empresa ya está registrada en tu cuenta.' : err.message, 'err'); }
    render();
  };
  SY.guardarCreds = async () => {
    const c = cloudEmp(); if (!c) return;
    const v = (id) => (el(id) ? el(id).value.trim() : '');
    const ruc = v('sy_ruc'), cid = v('sy_cid'), usr = v('sy_user');
    if (!/^\d{11}$/.test(ruc)) return toast('El RUC debe tener 11 dígitos.', 'err');
    if (!cid || !usr) return toast('client_id y usuario SOL son obligatorios.', 'err');
    try {
      await Cloud.rpc('sire_guardar_credenciales', { p_empresa: c.id, p_ruc: ruc, p_client_id: cid, p_client_secret: el('sy_cs').value, p_usuario_sol: usr, p_clave_sol: el('sy_pass').value });
      toast('Credenciales guardadas (cifradas).'); await refrescar(false);
    } catch (e) { toast(e.message, 'err'); }
    render();
  };
  SY.borrarCreds = async () => {
    const c = cloudEmp(); if (!c) return;
    if (!(await ask('¿Eliminar las credenciales API SUNAT de esta empresa? Se borran también los secretos cifrados.', 'Eliminar'))) return;
    try { await Cloud.rpc('sire_eliminar_credenciales', { p_empresa: c.id }); toast('Credenciales eliminadas.'); await refrescar(false); } catch (e) { toast(e.message, 'err'); }
    render();
  };

  /* ---------------- sincronización con SUNAT (2 pasos) ---------------- */
  const fnSync = async (cuerpo) => {
    const r = await Cloud.fn('sire-sync', cuerpo);
    if (!r || r.ok === false) throw new Error((r && r.error) || 'Respuesta inválida de la función.');
    return r;
  };
  function validar(libro) {
    const e = emp(), c = cloudEmp();
    if (!e) throw new Error('Primero selecciona una empresa.');
    if (!c) throw new Error('Registra la empresa en la nube primero.');
    if (!st.cred || !st.cred.configurado) throw new Error('Configura las credenciales API SUNAT de esta empresa.');
    if (!puedeEditar()) throw new Error('Tu rol no permite sincronizar esta empresa.');
    return c;
  }
  async function paso1(libro) {
    const c = validar(libro);
    log(libro, `Solicitando a SUNAT la propuesta de ${LIBROS[libro]} ${periodoStr()}…`);
    const r = await fnSync({ accion: 'solicitar', empresa_id: c.id, libro, periodo: periodoStr() });
    log(libro, r.reutilizado ? `Ya había un ticket en curso (${r.ticket.num_ticket}); se continúa con ese.` : `Ticket ${r.ticket.num_ticket} generado por SUNAT.`, 'ok');
    await cargarTickets();
    return r.ticket;
  }
  SY.soloSolicitar = async (libro) => {
    if (st.busy[libro]) return; st.busy[libro] = true; st.log[libro] = [];
    try { await paso1(libro); log(libro, 'Cuando termine, usa «Consultar estado» y «Descargar y cargar» en la lista de tickets.'); }
    catch (e) { log(libro, '✘ ' + e.message, 'err'); toast(e.message, 'err'); }
    st.busy[libro] = false; if (TAB === 'sire') render();
  };
  async function esperar(libro, t) {
    const MAX = 50;   // ~5 min
    await sleep(SY.pausa(3000));
    for (let i = 1; i <= MAX; i++) {
      const r = await fnSync({ accion: 'estado', ticket_id: t.id }); t = r.ticket;
      const des = t.des_estado_proceso || (ESTADOS[t.estado] || [t.estado])[0];
      log(libro, `Consulta ${i}: ${des}${t.cod_estado_proceso ? ' (' + t.cod_estado_proceso + ')' : ''}`);
      if (t.estado === 'terminado' || t.estado === 'descargado') { await cargarTickets(); return t; }
      if (t.estado === 'error') { await cargarTickets(); throw new Error(t.detalle_error || 'SUNAT procesó el ticket con errores.'); }
      await sleep(SY.pausa(6000));
    }
    await cargarTickets();
    throw new Error('SUNAT sigue procesando el ticket. Retómalo más tarde con «Consultar estado» en la lista de tickets.');
  }
  SY.pausa = (ms) => ms;   // ajustable en pruebas

  /** Convierte lo descargado (ZIP de SUNAT) en File(s) .txt con el nombre oficial que la app reconoce. */
  async function prepararArchivos(buf, nombre, libro, anio, mes, ruc) {
    const u8 = new Uint8Array(buf); const out = [];
    const std = `LE${ruc}${anio}${String(mes).padStart(2, '0')}00${libro === 'compras' ? '080400' : '140400'}001111.txt`;
    if (u8[0] === 0x50 && u8[1] === 0x4b) {
      const z = await JSZip.loadAsync(buf);
      const ents = Object.values(z.files).filter((f) => !f.dir && /\.txt$/i.test(f.name));
      if (!ents.length) throw new Error(`El ZIP de SUNAT (${nombre}) no contiene archivos .txt.`);
      for (const f of ents) {
        const base = f.name.split(/[\\/]/).pop();
        out.push(new File([await f.async('arraybuffer')], detectarArchivo(base) ? base : std, { type: 'text/plain' }));
      }
    } else {
      out.push(new File([buf], detectarArchivo(nombre) ? nombre : std, { type: 'text/plain' }));
    }
    return out;
  }
  async function paso2(libro, t) {
    const r = await fnSync({ accion: 'descargar', ticket_id: t.id });
    const e = emp(); const anio = +t.periodo.slice(0, 4), mes = +t.periodo.slice(4);
    log(libro, `Descargando ${r.archivos.length} archivo(s) de SUNAT…`);
    const files = [];
    for (const a of r.archivos) {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`No se pudo bajar ${a.nombre} (HTTP ${res.status}).`);
      files.push(...await prepararArchivos(await res.arrayBuffer(), a.nombre, libro, anio, mes, e.ruc));
    }
    if (!files.length) throw new Error('SUNAT no entregó archivos para este ticket.');
    log(libro, 'Procesando en la app…');
    await cargarTipo(libro, files, 'sumar', anio, mes);
    log(libro, `✔ ${LIBROS[libro]} ${t.periodo} cargado en ${e.nombre}.`, 'ok');
    await cargarTickets();
  }
  SY.sync = async (libro) => {
    if (st.busy[libro]) return; st.busy[libro] = true; st.log[libro] = [];
    try { let t = await paso1(libro); t = await esperar(libro, t); await paso2(libro, t); }
    catch (e) { log(libro, '✘ ' + e.message, 'err'); toast(e.message, 'err'); }
    st.busy[libro] = false; pintarEstado(); if (TAB === 'sire') render();
  };
  SY.consultar = async (id) => {
    try { const r = await fnSync({ accion: 'estado', ticket_id: id }); await cargarTickets(); toast('Estado: ' + (r.ticket.des_estado_proceso || (ESTADOS[r.ticket.estado] || [r.ticket.estado])[0])); }
    catch (e) { toast(e.message, 'err'); }
  };
  SY.descargarTicket = async (id) => {
    const t = st.tickets.find((x) => x.id === id); if (!t) return;
    if (t.estado === 'descargado' && !(await ask('Este ticket ya se descargó. ¿Volver a cargarlo? (los duplicados se descartan solos)', 'Cargar de nuevo'))) return;
    try { await paso2(t.libro, t); } catch (e) { log(t.libro, '✘ ' + e.message, 'err'); toast(e.message, 'err'); }
    if (TAB === 'sire') render();
  };

  /* ---------------- persistencia por empresa (sire_datos) ---------------- */
  const pend = new Map(); let timer = null, volando = false;
  // claves: 'cfg' | 'p|AAAA|M' | 'b|AAAA|M'
  function encolar(ruc, clave) { pend.set(ruc + '|' + clave, { ruc, clave }); }
  SY.onSave = function () {   // lo llama save() de index.html antes de encolar el guardado local
    if (!Cloud.enabled || !Cloud.logged || !st.auto || st.aplicando || !st.cargado) return;
    try {
      for (const k of dirtyP) { const [r, a, m] = k.split('|'); if (cloudEmpDe(r)) encolar(r, `p|${a}|${m}`); }
      for (const k of dirtyB) { const [r, a, m] = k.split('|'); if (cloudEmpDe(r)) encolar(r, `b|${a}|${m}`); }
      for (const k of delP) { const [r, a, m] = k.split('|'); if (cloudEmpDe(r)) encolar(r, `p|${a}|${m}`); }
      for (const r of Object.keys(DB.empresas)) if (cloudEmpDe(r)) encolar(r, 'cfg');
      clearTimeout(timer); timer = setTimeout(flush, 2000); pintarEstado('guardando…');
    } catch (e) { console.error(e); }
  };
  async function flush() {
    if (volando) { timer = setTimeout(flush, 1500); return; }
    const items = [...pend.values()]; pend.clear(); if (!items.length) return;
    volando = true;
    try {
      const puts = [], dels = [];
      for (const it of items) {
        const c = cloudEmpDe(it.ruc), e = DB.empresas[it.ruc]; if (!c || !e) continue;
        if (it.clave === 'cfg') {
          const { periodos, bases, ...rest } = e; const s = JSON.stringify(rest);
          if (st.lastCfg[it.ruc] === s) continue; st.lastCfg[it.ruc] = s;
          puts.push({ empresa_id: c.id, clave: 'cfg', valor: rest }); continue;
        }
        const [t, a, m] = it.clave.split('|');
        const v = ((t === 'p' ? e.periodos : e.bases) || {})[a]; const val = v ? v[m] : undefined;
        if (val === undefined) dels.push({ c, clave: it.clave }); else puts.push({ empresa_id: c.id, clave: it.clave, valor: val });
      }
      let lote = [], peso = 0;
      const subir = async () => { if (lote.length) { await Cloud.insert('sire_datos', lote, { upsert: true, onConflict: 'empresa_id,clave' }); lote = []; peso = 0; } };
      for (const r of puts) { const w = JSON.stringify(r.valor).length; if (peso + w > 1.5e6) await subir(); lote.push(r); peso += w; }
      await subir();
      for (const d of dels) await Cloud.borrar('sire_datos', `empresa_id=eq.${d.c.id}&clave=eq.${encodeURIComponent(d.clave)}`);
      st.stat = ''; pintarEstado('guardado en la nube');
    } catch (e) {
      console.error(e); items.forEach((it) => pend.set(it.ruc + '|' + it.clave, it));
      for (const it of items) if (it.clave === 'cfg') delete st.lastCfg[it.ruc];
      pintarEstado('error al guardar en la nube'); toast('No se pudo guardar en la nube: ' + e.message, 'err');
    }
    volando = false;
  }
  SY.subirTodo = async () => {
    const e = emp(), c = cloudEmp(); if (!e || !c) return;
    encolar(e.ruc, 'cfg');
    for (const a of Object.keys(e.periodos || {})) for (const m of Object.keys(e.periodos[a])) encolar(e.ruc, `p|${a}|${m}`);
    for (const a of Object.keys(e.bases || {})) for (const m of Object.keys(e.bases[a])) encolar(e.ruc, `b|${a}|${m}`);
    delete st.lastCfg[e.ruc]; await flush(); toast('Datos de la empresa subidos a la nube.');
  };
  SY.traer = async (ruc) => {
    const c = cloudEmpDe(ruc); if (!c) return;
    try {
      const filas = await Cloud.select('sire_datos', `select=clave,valor&empresa_id=eq.${c.id}`) || [];
      if (DB.empresas[ruc] && !(await ask(`Se reemplazarán la configuración y los períodos de ${ruc} guardados en este navegador por lo que hay en la nube (${filas.length} elementos).`, 'Traer de la nube'))) return;
      st.aplicando = true;
      const cfg = filas.find((f) => f.clave === 'cfg');
      let e = DB.empresas[ruc];
      if (!e) e = DB.empresas[ruc] = ensureEmp(Object.assign({ ruc, nombre: c.razon_social, plan: [], reglas: {}, glosas: {}, periodos: {}, bases: {} }, cfg ? cfg.valor : {}));
      else if (cfg) { const { periodos, bases } = e; Object.assign(e, cfg.valor, { periodos, bases }); ensureEmp(e); }
      e.ruc = ruc; if (!e.nombre) e.nombre = c.razon_social;
      let n = 0;
      for (const f of filas) {
        const m = /^([pb])\|(\d{4})\|(\d{1,2})$/.exec(f.clave); if (!m) continue;
        const dst = m[1] === 'p' ? e.periodos : e.bases;
        (dst[m[2]] = dst[m[2]] || {})[m[3]] = f.valor;
        (m[1] === 'p' ? dirtyP : dirtyB).add(pk(ruc, m[2], m[3])); n++;
      }
      if (!DB.activa) DB.activa = ruc;
      st.lastCfg[ruc] = JSON.stringify((({ periodos, bases, ...r }) => r)(e));
      save(); st.aplicando = false; toast(`Traído de la nube: ${n} período(s)/base(s).`); render();
    } catch (err) { st.aplicando = false; toast(err.message, 'err'); }
  };

  /* ---------------- arranque ---------------- */
  SY.init = function () {
    Cloud.on(() => { pintarEstado(); });
    pintarEstado();
    if (Cloud.enabled && Cloud.logged) refrescar(false).then(() => { if (TAB === 'sire') render(); });
  };
  SY.estado = st;   // para depuración/pruebas
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', SY.init); else SY.init();
})();
