#!/bin/sh
# Alfred.report! CLI shim — report/pi before Hermes profile alfred.
set -eu

# Login and non-login SSH both need the user bin (alfred-pi lives here).
if [ -d "$HOME/.local/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) PATH="$HOME/.local/bin:$PATH"; export PATH ;;
  esac
fi

HERMES="${HERMES_BIN:-$HOME/.local/bin/hermes}"
cmd="${1:-}"

usage() {
  cat <<'USAGE'
alfred.report! local CLI

  alfred report              start alfred-pi (wake word on first launch)
  alfred report <slug>       resume session by kebab slug
  alfred report update       update alfred-pi
  alfred pi                  same as alfred report (alias)
  alfred login               sign in via alfred.report (paste CF AI Gateway token)
  alfred login --vault       operator dogfood: wire from ~/.vault
  alfred help

Other args pass through to hermes -p alfred (legacy).
USAGE
}

run_pi() {
  # Inside Herdr panes, prefer alfred-herdr so agent list shows alfred (mimo pattern).
  if [ -n "${HERDR_PANE_ID:-}" ] && [ -x "$HOME/.local/bin/alfred-herdr" ]; then
    exec "$HOME/.local/bin/alfred-herdr" "$@"
  fi
  if command -v alfred-pi >/dev/null 2>&1; then
    exec alfred-pi "$@"
  fi
  if [ -x "$HOME/.local/bin/alfred-pi" ]; then
    exec "$HOME/.local/bin/alfred-pi" "$@"
  fi
  echo "Note: @openroyleal/alfred-pi not on PATH yet — open https://alfred.report/pi and run install."
  exit 1
}

case "$cmd" in
  ""|-h|--help|help)
    usage
    exit 0
    ;;
  report|pi)
    shift
    sub="${1:-}"
    case "$sub" in
      update)
        run_pi update
        ;;
      "")
        run_pi
        ;;
      *)
        run_pi --resume "$sub"
        ;;
    esac
    ;;
  update)
    run_pi update
    ;;
  login)
    shift
    run_pi login "$@"
    ;;
  status)
    run_pi status
    ;;
  *)
    # legacy Hermes alfred profile
    exec "$HERMES" -p alfred "$@"
    ;;
esac
