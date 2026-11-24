// Conexión a Supabase de la versión web (SIRE → Contasis).
// Supabase → Project Settings → API: copia "Project URL" y la clave "anon / publishable".
// La clave anon es pública por diseño: la seguridad la dan las reglas RLS de
// supabase/migrations/*.sql. NUNCA pongas aquí la clave service_role.
//
// Mientras estén vacías, la app funciona en MODO LOCAL (como antes): carga manual de
// archivos y datos en el navegador (IndexedDB), sin sincronización con SUNAT ni nube.
window.SIRE_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: ""
};
