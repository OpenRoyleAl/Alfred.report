#!/bin/sh
# alfred-pi installer — https://alfred.report/install.sh
# Installs @openroyleal/alfred-pi and wires the `alfred` CLI.

set -eu

ALFRED_PACKAGE="@openroyleal/alfred-pi"
ALFRED_CMD="alfred"
ALFRED_INSTALL_URL="${ALFRED_INSTALL_URL:-https://alfred.report}"

printf '\033[1m  alfred-pi installer\033[0m\n'
printf '\033[2m  There are many agent harnesses but this one is yours\033[0m\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '\033[31m✗\033[0m Node.js is required (20+). Install from https://nodejs.org/\n'
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")
if [ "${NODE_MAJOR}" -lt 20 ] 2>/dev/null; then
  printf '\033[33m!\033[0m Node %s detected — 20+ recommended.\n' "$(node -v)"
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '\033[31m✗\033[0m npm is required.\n'
  exit 1
fi

printf '\033[2m→\033[0m Installing %s …\n' "${ALFRED_PACKAGE}"
if ! npm install -g --ignore-scripts "${ALFRED_PACKAGE}"; then
  printf '\033[31m✗\033[0m npm install failed.\n'
  printf '    Package may not be published yet — see %s/pi\n' "${ALFRED_INSTALL_URL}"
  exit 1
fi

if ! command -v "${ALFRED_CMD}" >/dev/null 2>&1; then
  NPM_PREFIX=$(npm prefix -g 2>/dev/null || echo "")
  if [ -n "${NPM_PREFIX}" ] && [ -d "${NPM_PREFIX}/bin" ]; then
    printf '\033[33m!\033[0m Add to PATH: export PATH="%s/bin:$PATH"\n' "${NPM_PREFIX}"
  fi
fi

printf '\n\033[32m✓\033[0m install alfred report — done\n\n'
printf '  First launch:  \033[1malfred report\033[0m          # wake word Alfred.report!\n'
printf '  Resume:        \033[1malfred report <slug>\033[0m   # kebab slug only\n'
printf '  Update:        \033[1malfred report update\033[0m\n'
printf '  Login:         \033[1m/login\033[0m or %s/login\n\n' "${ALFRED_INSTALL_URL}"
