-- Endurecimiento tras el linter de seguridad de Supabase.
alter function public.sire_touch_updated_at() set search_path = '';
revoke execute on function public.sire_empresa_alta_admin() from public, anon, authenticated;
