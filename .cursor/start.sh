#!/usr/bin/env bash
# Per-boot startup for the OpenBao Passkeys dev environment.
#
# Launches the OpenBao dev server (the KV v2 backend the extension talks to) in
# the background and waits until it is ready. Idempotent: if OpenBao is already
# healthy it returns immediately, so it is safe to run on every boot / restart.
set -euo pipefail

BAO_ADDR="http://127.0.0.1:8200"
LOG="/tmp/openbao.log"

is_healthy() {
  curl -sf "${BAO_ADDR}/v1/sys/health" >/dev/null 2>&1
}

if is_healthy; then
  echo "OpenBao already running at ${BAO_ADDR}."
  exit 0
fi

echo "Starting OpenBao dev server…"
touch "$LOG"
nohup bao server -dev -dev-root-token-id=root -dev-listen-address=0.0.0.0:8200 >"$LOG" 2>&1 &

for _ in $(seq 1 30); do
  if is_healthy; then
    echo "OpenBao dev server ready at ${BAO_ADDR} (root token 'root', KV mount 'secret')."
    exit 0
  fi
  sleep 1
done

echo "OpenBao did not become ready within 30s; recent log:" >&2
tail -n 20 "$LOG" >&2 || true
exit 1
