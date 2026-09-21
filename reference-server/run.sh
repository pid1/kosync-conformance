#!/usr/bin/env sh
# Start (or stop) the reference kosync server for conformance runs.
# Uses podman if present, otherwise docker. See README.md in this directory.
set -eu

IMAGE="${KOSYNC_IMAGE:-docker.io/koreader/kosync:latest}"
NAME="${KOSYNC_NAME:-kosync-ref}"
PORT="${KOSYNC_PORT:-8080}"

if command -v podman >/dev/null 2>&1; then RUNTIME=podman
elif command -v docker >/dev/null 2>&1; then RUNTIME=docker
else echo "need podman or docker on PATH" >&2; exit 2
fi

case "${1:-start}" in
  start)
    if [ "$RUNTIME" = podman ]; then
      podman machine start >/dev/null 2>&1 || true
    fi
    $RUNTIME rm -f "$NAME" >/dev/null 2>&1 || true
    # 17200 is the plaintext listener; 7200 serves HTTPS with a self-signed
    # certificate that Node's fetch will not accept.
    $RUNTIME run -d --name "$NAME" -p "${PORT}:17200" "$IMAGE" >/dev/null
    printf 'waiting for %s' "$NAME"
    i=0
    while [ "$i" -lt 60 ]; do
      if curl -sf -m 2 -H 'Accept: application/vnd.koreader.v1+json' \
           "http://127.0.0.1:${PORT}/healthcheck" | grep -q '"state":"OK"'; then
        printf ' ready\n'
        echo "reference server on http://127.0.0.1:${PORT}"
        exit 0
      fi
      printf '.'; sleep 1; i=$((i + 1))
    done
    printf '\n'
    echo "server did not become healthy; logs follow" >&2
    $RUNTIME logs "$NAME" >&2 || true
    exit 1
    ;;
  stop)
    $RUNTIME rm -f "$NAME" >/dev/null 2>&1 || true
    echo "stopped"
    ;;
  reset)
    # GIN_ENV=production in the image, so the app uses Redis database 1.
    $RUNTIME exec "$NAME" redis-cli -n 1 flushdb >/dev/null
    echo "flushed"
    ;;
  *)
    echo "usage: $0 [start|stop|reset]" >&2; exit 2 ;;
esac
