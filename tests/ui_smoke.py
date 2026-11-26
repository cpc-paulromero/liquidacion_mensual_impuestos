"""Prueba de humo de la interfaz con Supabase y SUNAT simulados (sin red real).

Ejecutar:  python3 tests/ui_smoke.py
Recorre: login → registrar empresa → guardar credenciales → sincronizar COMPRAS y VENTAS
(solicitar ticket → estado → descargar → cargar en la app) → persistencia en lmi_datos.
"""
import base64, functools, http.server, json, re, socketserver, sys, threading, uuid
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SB = "https://mock.supabase.co"
RUC = "20999999991"

# ---------------------------------------------------------------- servidor estático
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
handler.log_message = lambda *a, **k: None
httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

# ---------------------------------------------------------------- estado del "backend"
S = dict(empresas=[], tickets=[], configurado=False, creds_rpc=[], datos_posts=[], datos_dels=[],
         fn_calls=[], estado_calls={}, zips={}, otras_requests=[])
USER = {"id": "11111111-1111-1111-1111-111111111111", "email": "contador@ejemplo.pe"}


def jr(route, body, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body),
                  headers={"access-control-allow-origin": "*"})


def cors_ok(route):
    route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*",
                                       "access-control-allow-methods": "*"})


def on_supabase(route, request):
    if request.method == "OPTIONS":
        return cors_ok(route)
    url, path = request.url, re.sub(r"^https://mock\.supabase\.co", "", request.url).split("?")[0]
    body = request.post_data_json if request.post_data else None
    if path == "/auth/v1/token":
        return jr(route, {"access_token": "AT", "refresh_token": "RT", "expires_in": 3600, "user": USER})
    if path == "/rest/v1/lmi_empresas":
        if request.method == "POST":
            S["empresas"].append(dict(id=str(uuid.uuid4()), ruc=body["ruc"], razon_social=body["razon_social"], created_by=USER["id"]))
            return route.fulfill(status=201, body="", headers={"access-control-allow-origin": "*"})
        return jr(route, S["empresas"])
    if path == "/rest/v1/lmi_miembros":
        return jr(route, [dict(empresa_id=e["id"], rol="admin") for e in S["empresas"]])
    if path == "/rest/v1/lmi_tickets":
        return jr(route, list(reversed(S["tickets"])))
    if path == "/rest/v1/lmi_datos":
        if request.method == "POST":
            S["datos_posts"].extend(body if isinstance(body, list) else [body])
            return route.fulfill(status=201, body="", headers={"access-control-allow-origin": "*"})
        if request.method == "DELETE":
            S["datos_dels"].append(url)
            return route.fulfill(status=204, body="", headers={"access-control-allow-origin": "*"})
        return jr(route, [])
    if path == "/rest/v1/rpc/lmi_credenciales_estado":
        return jr(route, [dict(configurado=S["configurado"], ruc=RUC if S["configurado"] else None,
                               client_id="cid-1" if S["configurado"] else None, usuario_sol="MODDATOS" if S["configurado"] else None,
                               ultimo_ok=None, ultimo_error=None)])
    if path == "/rest/v1/rpc/lmi_guardar_credenciales":
        S["creds_rpc"].append(body); S["configurado"] = True
        return route.fulfill(status=204, body="", headers={"access-control-allow-origin": "*"})
    if path == "/functions/v1/sire-sync":
        return on_function(route, body)
    S["otras_requests"].append(path)
    return jr(route, {"message": "ruta no simulada: " + path}, 404)


def on_function(route, b):
    S["fn_calls"].append(b)
    emp = S["empresas"][0]
    if b["accion"] == "solicitar":
        t = dict(id=str(uuid.uuid4()), empresa_id=emp["id"], libro=b["libro"], periodo=b["periodo"],
                 num_ticket=f"2026{len(S['tickets']) + 1:08d}", estado="solicitado", cod_estado_proceso=None,
                 des_estado_proceso=None, cod_proceso=None, archivos=[], detalle_error=None,
                 created_at="2026-11-23T20:00:00Z")
        S["tickets"].append(t)
        return jr(route, {"ok": True, "ticket": t})
    t = next(x for x in S["tickets"] if x["id"] == b["ticket_id"])
    if b["accion"] == "estado":
        n = S["estado_calls"][t["id"]] = S["estado_calls"].get(t["id"], 0) + 1
        if n < 2:
            t.update(estado="en_proceso", cod_estado_proceso="05", des_estado_proceso="En proceso")
        else:
            cod = "080400" if t["libro"] == "compras" else "140400"
            nombre = f"LE{RUC}{t['periodo']}00{cod}00111.zip"
            t.update(estado="terminado", cod_estado_proceso="06", des_estado_proceso="Terminado", cod_proceso="3",
                     archivos=[dict(nombre=nombre, codTipo="01")])
        return jr(route, {"ok": True, "ticket": t})
    if b["accion"] == "descargar":
        t["estado"] = "descargado"
        for a in t["archivos"]:
            a["path"] = f"{emp['id']}/{t['libro']}/{t['periodo']}/{t['num_ticket']}/{a['nombre']}"
        return jr(route, {"ok": True, "ticket": t, "archivos": [dict(nombre=a["nombre"], url=f"https://mock.storage/{t['libro']}.zip") for a in t["archivos"]]})
    return jr(route, {"ok": False, "error": "accion?"}, 400)


def fallar(msg):
    print("✘", msg); sys.exit(1)


def check(cond, msg):
    if not cond:
        fallar(msg)
    print("✔", msg)


# ---------------------------------------------------------------- prueba
with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_context(viewport={"width": 1300, "height": 1400}).new_page()
    errores = []
    pg.on("pageerror", lambda e: errores.append(str(e)))
    pg.on("console", lambda m: errores.append(m.text) if m.type == "error" and "ruta no simulada" not in m.text and "Failed to load resource" not in m.text else None)

    pg.route("**/config.js", lambda r: r.fulfill(content_type="application/javascript",
             body=f'window.SIRE_CONFIG={{SUPABASE_URL:"{SB}",SUPABASE_ANON_KEY:"anon-key"}};'))
    pg.route(re.compile(r"^https://mock\.supabase\.co/.*"), on_supabase)
    pg.route("https://mock.storage/*", lambda r: r.fulfill(body=S["zips"][r.request.url.split("/")[-1][:-4]], content_type="application/zip",
             headers={"access-control-allow-origin": "*"}))

    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    pg.wait_for_function("window.SireSync && typeof render==='function' && DB")
    check((pg.text_content("#cloudStat") or "").startswith("☁ Nube: iniciar sesión"), "cabecera indica nube sin sesión")
    check(pg.is_visible("#gate") and not pg.is_visible("header"), "sin sesión: solo se ve la pantalla de acceso, la app queda oculta")

    # empresa de prueba local + ZIPs que "entrega SUNAT"
    pg.evaluate("A.mockEmpresa()"); pg.wait_for_function(f"DB.activa==='{RUC}'")
    compras_zip = pg.evaluate("""async()=>{const f=mockSire();const z=new JSZip();z.file('LE20999999991202610000804000021111.txt',await f.text());return await z.generateAsync({type:'uint8array'}).then(u=>Array.from(u));}""")
    ventas_txt = "\n".join(
        ["RUC|Apellidos y Nombres o Razón social|Periodo|CAR SUNAT|Fecha de emisión|Fecha Vcto/Pago|Tipo CP/Doc.|Serie del CDP|Nro CP|Nro Final|Tipo Doc Identidad|Nro Doc Identidad|Razón social|Exportación|BI|Dscto BI|IGV|Dscto IGV|Exonerado|Inafecto|ISC|BI IVAP|IVAP|ICBPER|Otros|Total CP|Moneda|TC"] +
        ["|".join([RUC, "EMPRESA DEMO S.A.C.", "202610", "", f"{d:02d}/10/2026", "", "01", "F001", str(100 + d), "", "6", "20100049181", "CLIENTE SA", "0.00", "100.00", "0.00", "18.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "118.00", "PEN", "1.000"]) for d in (3, 9, 17)])
    ventas_zip = pg.evaluate("""async(t)=>{const z=new JSZip();z.file('propuesta_sin_nombre_oficial.txt',t);return await z.generateAsync({type:'uint8array'}).then(u=>Array.from(u));}""", ventas_txt)
    S["zips"]["compras"] = bytes(compras_zip); S["zips"]["ventas"] = bytes(ventas_zip)
    pg.evaluate("SireSync.pausa=()=>15")

    # --- login
    pg.fill("#g_mail", "contador@ejemplo.pe"); pg.fill("#g_pw", "clave-web-123"); pg.click("#g_ok")
    pg.wait_for_selector("#gate", state="detached")
    check(pg.is_visible("header"), "con sesión: la app se muestra completa")
    pg.evaluate("A.tab('sire')")
    pg.wait_for_selector("text=Registrar esta empresa en la nube")
    check(True, "login correcto y se ofrece registrar la empresa")

    pg.click("text=Registrar esta empresa en la nube")
    pg.wait_for_selector("text=Credenciales API SUNAT de EMPRESA DEMO")
    check(len(S["empresas"]) == 1 and S["empresas"][0]["ruc"] == RUC, "empresa registrada en la nube con su RUC")
    check(pg.is_disabled("button:has-text('Sincronizar ahora') >> nth=0"), "sin credenciales no se puede sincronizar")

    # --- credenciales
    pg.fill("#sy_cid", "cid-1"); pg.fill("#sy_cs", "SECRETO-API"); pg.fill("#sy_user", "MODDATOS"); pg.fill("#sy_pass", "CLAVE-SOL-X")
    pg.click("text=Guardar credenciales")
    pg.wait_for_selector("text=Configuradas")
    c = S["creds_rpc"][0]
    check(c["p_client_secret"] == "SECRETO-API" and c["p_clave_sol"] == "CLAVE-SOL-X" and c["p_ruc"] == RUC, "credenciales por empresa enviadas solo al RPC de Vault")
    check(pg.input_value("#sy_cs") == "" and pg.input_value("#sy_pass") == "", "los campos secretos se vacían tras guardar")
    check("SECRETO-API" not in pg.content() and "CLAVE-SOL-X" not in pg.content(), "los secretos no quedan en el DOM")

    # --- sincronización COMPRAS
    pg.click("text=Sincronizar ahora (202610) >> nth=0")
    pg.wait_for_function("(DB.empresas['%s'].bases[2026]||{})[10] && DB.empresas['%s'].bases[2026][10].compras.length>0" % (RUC, RUC), timeout=20000)
    n_comp = pg.evaluate(f"DB.empresas['{RUC}'].bases[2026][10].compras.length")
    check(n_comp >= 6, f"COMPRAS: propuesta RCE descargada y cargada en la app ({n_comp} registros)")
    acciones = [x["accion"] for x in S["fn_calls"] if x.get("libro", "compras") == "compras" or "ticket_id" in x]
    check(acciones[0] == "solicitar" and "estado" in acciones and acciones[-1] == "descargar", "COMPRAS: flujo solicitar → estado (en proceso→terminado) → descargar")

    # --- sincronización VENTAS (independiente)
    pg.evaluate("A.tab('sire')")
    pg.click("text=Sincronizar ahora (202610) >> nth=1")
    pg.wait_for_function("(DB.empresas['%s'].bases[2026][10].ventas||[]).length>0" % RUC, timeout=20000)
    n_vta = pg.evaluate(f"DB.empresas['{RUC}'].bases[2026][10].ventas.length")
    check(n_vta == 3, f"VENTAS: propuesta RVIE descargada y cargada, nombre no oficial normalizado ({n_vta} registros)")
    solicitudes = [(x["libro"], x["periodo"]) for x in S["fn_calls"] if x["accion"] == "solicitar"]
    check(solicitudes == [("compras", "202610"), ("ventas", "202610")], f"se pidieron tickets independientes por libro: {solicitudes}")
    check(pg.evaluate(f"DB.empresas['{RUC}'].bases[2026][10].compras.length") == n_comp, "cargar ventas no altera las compras")

    pg.evaluate("A.tab('sire')")
    pg.wait_for_selector("#sy_tickets table")
    check(pg.locator("#sy_tickets tbody tr").count() == 3, "lista de tickets muestra cabecera + 2 tickets")
    check("Descargado" in pg.inner_text("#sy_tickets"), "tickets figuran como descargados")

    # --- persistencia por empresa en la nube
    pg.check("input[type=checkbox]")
    pg.wait_for_function("window.__n=1", timeout=1000)
    pg.wait_for_timeout(2600)
    claves = sorted({d["clave"] for d in S["datos_posts"]})
    check("cfg" in claves and any(k.startswith("b|2026|") for k in claves), f"persistencia por empresa en lmi_datos: {claves}")
    check(all(d["empresa_id"] == S["empresas"][0]["id"] for d in S["datos_posts"]), "todo lo guardado va con el empresa_id de la empresa")
    blob = json.dumps(S["datos_posts"])
    check("SECRETO-API" not in blob and "CLAVE-SOL-X" not in blob, "ningún secreto viaja a lmi_datos")

    pg.screenshot(path="/tmp/sire_tab.png", full_page=True)
    # --- cerrar sesión devuelve la puerta de acceso
    pg.evaluate("Cloud.logout()")
    pg.wait_for_selector("#gate")
    check(pg.is_visible("#gate") and not pg.is_visible("header"), "al cerrar sesión vuelve la pantalla de acceso")

    check(not S["otras_requests"], f"sin peticiones no previstas: {S['otras_requests']}")
    check(not errores, f"sin errores en consola: {errores}")
    br.close()
print("\nTODAS LAS PRUEBAS DE INTERFAZ OK")
