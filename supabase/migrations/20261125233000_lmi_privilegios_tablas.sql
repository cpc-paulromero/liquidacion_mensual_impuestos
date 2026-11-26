-- Este proyecto no concede privilegios de datos por defecto a las tablas nuevas: se otorgan de forma explícita y mínima.
-- Las políticas RLS siguen decidiendo QUÉ filas ve o cambia cada usuario.
grant select, insert, update, delete on public.lmi_empresas to authenticated;
grant select, update, delete          on public.lmi_miembros to authenticated;   -- altas solo vía lmi_agregar_miembro()
grant select, insert, update, delete on public.lmi_datos    to authenticated;
grant select                          on public.lmi_tickets  to authenticated;   -- escribe solo la Edge Function
grant select, insert, update, delete on public.lmi_tickets  to service_role;
-- lmi_credenciales y lmi_acceso_permitido: sin privilegios para el navegador; solo funciones SECURITY DEFINER.
