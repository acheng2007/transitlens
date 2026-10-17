#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root_dir="$PWD"
python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 'Python 3.11 or newer is required')"
for service in bus-service voice-service; do
  if [[ ! -x "$service/.venv/bin/python" ]]; then python3 -m venv "$service/.venv"; fi
  "$service/.venv/bin/pip" install -q -r "$service/requirements.txt"
  if [[ ! -f "$service/.env" ]]; then (umask 077; cp "$service/.env.example" "$service/.env"); fi
done
if [[ ! -d web/node_modules ]]; then (cd web && npm ci); fi
bus_pid='' voice_pid=''
cleanup() {
  [[ -z "$bus_pid" ]] || kill "$bus_pid" 2>/dev/null || true
  [[ -z "$voice_pid" ]] || kill "$voice_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
(cd "$root_dir/bus-service" && exec .venv/bin/uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8003) &
bus_pid=$!
(cd "$root_dir/voice-service" && exec .venv/bin/uvicorn main:app --env-file .env --host 127.0.0.1 --port 8002) &
voice_pid=$!
cd web
npm run dev -- --host 0.0.0.0 --port "${WEB_PORT:-5173}" --strictPort
