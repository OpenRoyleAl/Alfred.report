#!/bin/sh
# Launch Alfred.report! (alfred-pi) in the focused Herdr pane.
set -eu

PATH="${HOME}/.local/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"
export PATH

HERDR="${HERDR_BIN_PATH:-/usr/local/bin/herdr}"
LAUNCHER="${HOME}/.local/bin/alfred-herdr"
if [ ! -x "$LAUNCHER" ]; then
  LAUNCHER="${HOME}/.local/bin/alfred-pi"
fi
if [ ! -x "$LAUNCHER" ]; then
  echo "alfred-pi missing — install to ~/.local/bin" >&2
  exit 1
fi

PANE="${HERDR_PANE_ID:-}"
if [ -z "$PANE" ] && [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
  PANE=$(printf "%s" "$HERDR_PLUGIN_CONTEXT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\"focused_pane_id\") or d.get(\"pane_id\") or \"\")" 2>/dev/null || true)
fi
if [ -z "$PANE" ]; then
  PANE=$("$HERDR" pane current 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[\"result\"][\"pane\"][\"pane_id\"])" 2>/dev/null || true)
fi
if [ -z "$PANE" ]; then
  echo "No focused Herdr pane — New Agent → browse folder, focus the pane, then launch." >&2
  exit 1
fi

exec "$HERDR" pane run "$PANE" "$LAUNCHER"
