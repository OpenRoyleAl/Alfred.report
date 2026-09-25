#!/bin/sh
# alfred-pi installer — https://alfred.report/install.sh
# Tries published npm, then a local Alfred-Report package (Vultr dogfood).

set -eu

ALFRED_PACKAGE="@openroyleal/alfred-pi"
ALFRED_INSTALL_URL="${ALFRED_INSTALL_URL:-https://alfred.report}"
LOCAL_PKG="${ALFRED_PI_SRC:-$HOME/projects/OpenRoyleAl/alfred-report/packages/alfred-pi}"
NPM_PREFIX="${ALFRED_NPM_PREFIX:-$HOME/.local}"
CF_SKILLS_REPO="https://github.com/cloudflare/skills.git"
CF_SKILLS_DIR="${OPENROYLEAL_CF_SKILLS_DIR:-${ALFRED_PI_SKILLS_DIR:-$HOME/.alfred-pi/skills/cloudflare}}"
PI_SKILLS_DIR="${PI_SKILLS_DIR:-$HOME/.pi/agent/skills}"

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

if [ -d "$HOME/.local/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) PATH="$HOME/.local/bin:$PATH"; export PATH ;;
  esac
fi

printf '\033[2m→\033[0m Installing %s …\n' "${ALFRED_PACKAGE}"
installed=""
if npm install -g --ignore-scripts --prefix "${NPM_PREFIX}" "${ALFRED_PACKAGE}"; then
  installed="npm"
else
  printf '\033[33m!\033[0m npm registry miss — trying local package\n'
  if [ -f "${LOCAL_PKG}/package.json" ]; then
    npm install -g --ignore-scripts --prefix "${NPM_PREFIX}" "${LOCAL_PKG}"
    installed="local"
  else
    printf '\033[31m✗\033[0m no published package and no local source at %s\n' "${LOCAL_PKG}"
    printf '    Package may not be published yet — see %s/pi\n' "${ALFRED_INSTALL_URL}"
    exit 1
  fi
fi

# Herdr agent wrapper (pane.report_agent → agent=alfred)
PKG_HERDR="${LOCAL_PKG}/herdr-plugin/alfred-herdr"
if [ -f "$PKG_HERDR" ]; then
  install -m 755 "$PKG_HERDR" "${NPM_PREFIX}/bin/alfred-herdr"
  printf '\033[2m→\033[0m Installed alfred-herdr (Herdr agent label)\n'
elif [ -f "${LOCAL_PKG}/../alfred-pi/herdr-plugin/alfred-herdr" ]; then
  install -m 755 "${LOCAL_PKG}/../alfred-pi/herdr-plugin/alfred-herdr" "${NPM_PREFIX}/bin/alfred-herdr"
fi
# Prefer alfred-herdr as alfred.report / alfred-report when present
if [ -x "${NPM_PREFIX}/bin/alfred-herdr" ]; then
  ln -sfn alfred-herdr "${NPM_PREFIX}/bin/alfred.report" 2>/dev/null || true
  ln -sfn alfred-herdr "${NPM_PREFIX}/bin/alfred-report" 2>/dev/null || true
fi

if ! command -v alfred-pi >/dev/null 2>&1; then
  if [ -x "${NPM_PREFIX}/bin/alfred-pi" ]; then
    printf '\033[33m!\033[0m Add to PATH: export PATH="%s/bin:$PATH"\n' "${NPM_PREFIX}"
  fi
fi

sync_cf_skills() {
  if ! command -v git >/dev/null 2>&1; then
    printf '\033[31m✗\033[0m git is required for live Cloudflare skills.\n'
    return 1
  fi
  mkdir -p "$(dirname "$CF_SKILLS_DIR")"
  if [ -d "$CF_SKILLS_DIR/.git" ]; then
    remote=$(git -C "$CF_SKILLS_DIR" remote get-url origin 2>/dev/null || true)
    case "$remote" in
      https://github.com/cloudflare/skills|https://github.com/cloudflare/skills.git|git@github.com:cloudflare/skills|git@github.com:cloudflare/skills.git) ;;
      *) printf '\033[31m✗\033[0m refusing non-Cloudflare git origin at %s\n' "$CF_SKILLS_DIR"; return 1 ;;
    esac
    git -C "$CF_SKILLS_DIR" remote set-url origin "$CF_SKILLS_REPO"
    git -C "$CF_SKILLS_DIR" fetch --prune origin main
    git -C "$CF_SKILLS_DIR" checkout -B main origin/main
    git -C "$CF_SKILLS_DIR" reset --hard origin/main
  elif [ -e "$CF_SKILLS_DIR" ]; then
    printf '\033[31m✗\033[0m refusing non-git skills path %s\n' "$CF_SKILLS_DIR"
    return 1
  else
    git clone --branch main --single-branch "$CF_SKILLS_REPO" "$CF_SKILLS_DIR"
  fi
  mkdir -p "$PI_SKILLS_DIR"
  if [ -d "$CF_SKILLS_DIR/skills" ]; then
    for skill_path in "$CF_SKILLS_DIR/skills"/*; do
      [ -d "$skill_path" ] || continue
      name=$(basename "$skill_path")
      target="$PI_SKILLS_DIR/$name"
      if [ -e "$target" ] || [ -L "$target" ]; then
        if [ -L "$target" ]; then
          ln -sfn "$skill_path" "$target"
        fi
      else
        ln -sfn "$skill_path" "$target"
      fi
    done
  fi
  printf '\033[32m✓\033[0m live Cloudflare skills: %s\n' "$CF_SKILLS_DIR"
  git -C "$CF_SKILLS_DIR" log -1 --format='  HEAD %h %cI %s'
  printf '  harness: %s\n' "$PI_SKILLS_DIR"
}

printf '\033[2m→\033[0m Syncing official Cloudflare skills from origin/main …\n'
sync_cf_skills

printf '\n\033[32m✓\033[0m install alfred report — done (%s)\n\n' "${installed:-unknown}"
printf '  First launch:  \033[1malfred report\033[0m          # wake word Alfred.report!\n'
printf '  Resume:        \033[1malfred report <slug>\033[0m   # kebab slug only\n'
printf '  Update:        \033[1malfred report update\033[0m\n'
printf '  Login:         \033[1malfred login\033[0m or %s/login\n\n' "${ALFRED_INSTALL_URL}"
