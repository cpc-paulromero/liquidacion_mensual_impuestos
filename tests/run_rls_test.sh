#!/usr/bin/env bash
# Prueba de seguridad de la migración en un PostgreSQL temporal (sin Supabase real).
# Uso: sudo bash tests/run_rls_test.sh   (necesita PostgreSQL 15+ instalado)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../supabase/migrations"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"; D="$(mktemp -d)"; PORT=54329
chown postgres "$D"
runuser -u postgres -- "$PGBIN/initdb" -D "$D/data" -A trust -U postgres >/dev/null
runuser -u postgres -- "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D" -l "$D/log" -w start >/dev/null
trap 'runuser -u postgres -- "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null; rm -rf "$D"' EXIT
P=(psql -h "$D" -p $PORT -U postgres -v ON_ERROR_STOP=1 -q)
"${P[@]}" -c "create database t" ; P+=(-d t)
"${P[@]}" -f "$HERE/rls_stub.sql"
# En Supabase la extensión ya existe; en el PostgreSQL de prueba el stub de vault la reemplaza.
grep -v "create extension if not exists supabase_vault" "$MIG"/*.sql | "${P[@]}" -f -
"${P[@]}" -f "$HERE/rls_test.sql"
