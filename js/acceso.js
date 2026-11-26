/* Puerta de acceso a TODA la app.
   Si la nube está configurada (config.js) y no hay sesión de Supabase, se muestra solo esta pantalla
   de acceso y el resto de la interfaz queda oculto. Sin config.js (modo local) no hace nada.
   Aviso honesto: esto controla quién usa la interfaz; la seguridad real de los datos está en Supabase
   (RLS por empresa y lista de correos autorizados), no en este archivo. */
(function () {
  'use strict';
  if (!window.Cloud || !Cloud.enabled) return;

  const css = document.createElement('style');
  css.textContent = `
  body.sin-acceso > *:not(#gate){display:none!important}
  #gate{position:fixed;inset:0;z-index:99999;background:#2C3C63;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit}
  #gate .caja{background:#fff;border-radius:12px;border-top:5px solid #C9AA6F;width:100%;max-width:380px;padding:28px 26px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
  #gate .enc{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  #gate .enc img{width:56px;height:56px;border-radius:10px;flex:none;display:block}
  #gate .enc div{display:flex;flex-direction:column;line-height:1.2;min-width:0}
  #gate small{color:#8a6d2f;letter-spacing:.14em;text-transform:uppercase;font-size:11px;font-weight:600}
  #gate h1{font-size:20px;margin:3px 0 0;color:#2C3C63}
  #gate p{color:#667085;font-size:13px;margin:0 0 16px}
  #gate label{display:block;font-size:12px;color:#667085;margin:10px 0 4px}
  #gate input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cfd6e2;border-radius:8px;font-size:15px}
  #gate button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:8px;background:#2C3C63;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  #gate button:disabled{opacity:.6;cursor:wait}
  #gate .alt{background:transparent;color:#2C3C63;font-weight:500;font-size:13px;margin-top:6px;text-decoration:underline}
  #gate .msg{margin-top:12px;font-size:13px;min-height:18px}
  #gate .err{color:#b42318}#gate .ok{color:#1b7f4b}`;
  document.head.appendChild(css);

  const gate = document.createElement('div');
  gate.id = 'gate';
  gate.setAttribute('role', 'dialog');
  gate.innerHTML = `<form class="caja" autocomplete="on">
    <div class="enc"><img src="img/logo.png" alt="Paul Romero" width="56" height="56">
      <div><small>Paul Romero · Asesoría Empresarial</small><h1>Liquidación mensual de impuestos</h1></div></div>
    <p>Acceso restringido. Inicia sesión para continuar.</p>
    <label for="g_mail">Correo</label><input id="g_mail" type="email" autocomplete="username" required>
    <label for="g_pw">Contraseña</label><input id="g_pw" type="password" autocomplete="current-password" required minlength="6">
    <button type="submit" id="g_ok">Entrar</button>
    <button type="button" class="alt" id="g_reg">Crear cuenta (solo correos autorizados)</button>
    <div class="msg" id="g_msg" aria-live="polite"></div></form>`;

  const $ = (id) => gate.querySelector('#' + id);
  const msg = (t, ok) => { const m = $('g_msg'); m.textContent = t || ''; m.className = 'msg ' + (t ? (ok ? 'ok' : 'err') : ''); };
  const ocupado = (b) => { $('g_ok').disabled = b; $('g_reg').disabled = b; };

  function aplicar() {
    const bloquear = !Cloud.logged;
    document.body.classList.toggle('sin-acceso', bloquear);
    if (bloquear) {
      if (!gate.isConnected) document.body.appendChild(gate);
      $('g_pw').value = '';
    } else if (gate.isConnected) {
      gate.remove();
    }
  }

  gate.querySelector('form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); msg(''); ocupado(true);
    try { await Cloud.login($('g_mail').value.trim(), $('g_pw').value); }
    catch (e) { msg(/invalid login/i.test(e.message) ? 'Correo o contraseña incorrectos.' : e.message); }
    ocupado(false);
  });
  $('g_reg').addEventListener('click', async () => {
    const mail = $('g_mail').value.trim(), pw = $('g_pw').value;
    if (!mail || pw.length < 6) return msg('Escribe tu correo y una contraseña de al menos 6 caracteres.');
    msg(''); ocupado(true);
    try {
      const r = await Cloud.signup(mail, pw);
      if (r.confirmar) msg('Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.', true);
    } catch (e) { msg(/no autorizado|not authorized|database error/i.test(e.message) ? 'Este correo no tiene acceso a la aplicación.' : e.message); }
    ocupado(false);
  });

  Cloud.on(aplicar);
  if (document.body) aplicar(); else document.addEventListener('DOMContentLoaded', aplicar);
})();
