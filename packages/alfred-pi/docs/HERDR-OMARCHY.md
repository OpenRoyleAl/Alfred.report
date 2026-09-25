# Herdr + Omarchy — Alfred.report! agent launcher

> **Path note (2026-09-13):** dogfood tree lives at `~/projects/OpenRoyleAl/alfred-report/`. Compat symlink remains at `~/projects/alfred-report` → that folder.

Vultr already has this wired. Copy the same entry to Hans’s Omarchy laptop Herdr.

## What was registered (Vultr)

| Piece | Path |
| --- | --- |
| Herdr config | `~/.config/herdr/config.toml` |
| Pane PATH shell | `~/.local/bin/herdr-login-shell` |
| CLI | `~/.local/bin/alfred-pi`, `alfred`, `alfred.report`, `alfred-report` |
| Herdr-aware wrapper | `~/.local/bin/alfred-herdr` (labels pane as `alfred`) |
| Plugin | `~/.herdr-plugins/alfred-report/` (`herdr-plugin.toml` + `launch.sh`) |
| Plugin id | `alfred.report` |

Actions (multiple names → same launch): **alfred pi**, **alfred report**, **alfred.report**, **Alfred.report!**

Native `herdr agent start --kind` has no `alfred` kind (needs a Herdr binary update). Custom agents use this plugin + PATH binaries — same practical UX as typing `mimo` / `grok` / `cursor-agent` in a pane.

**Agent list / status notifications:** `alfred-herdr` and `alfred-pi` call `pane.report_agent` (source `herdr:alfred`, agent `alfred`) like `mimo-herdr`. States: `working` / `blocked` / `idle`. `alfred.report` / `alfred-report` aliases point at `alfred-herdr`. Inside a Herdr pane, `alfred pi` prefers `alfred-herdr`. Then `herdr agent list` shows alfred with status (same notification path as cursor/mimo).


## Default skills (official Cloudflare, always current)

Every Alfred.report!/alfred-pi launch uses the official `https://github.com/cloudflare/skills` checkout at `~/.alfred-pi/skills/cloudflare` (shared with Larga). This is a tracked `origin/main` git clone—not a random marketplace bundle or a frozen vendor snapshot. Skill folders are linked into `~/.pi/agent/skills/` (the path Pi actually loads). No `SKILL.md` files are copied into alfred-report.

Install/login/TUI start ensure it exists. `alfred report update` (or `alfred-pi skills sync`) runs fetch plus a managed reset to `origin/main`, so Herdr launches see the current Cloudflare skills.

## UX (KISS)

1. Herdr → **New workspace / New Agent** → browse folder → focus the pane  
2. Launch Alfred one of:
   - type `alfred pi` / `alfred report` / `alfred.report` / `alfred-pi` Enter  
   - plugin action **Alfred.report!** / **alfred pi** / **alfred report** / **alfred.report**  
   - key: `prefix+a` (ctrl+b then a) on Vultr  
3. TUI stays in that pane (models, missions, keep running). No MIMO.
4. In **Chat**, type `/` for an inline slash popover above `alfred>` (filter in-place · ↑↓ · Enter · Esc).  
   Herdr prefix `ctrl+b` is not stolen by alfred-pi. See [HERDR-TEST.md](./HERDR-TEST.md).

## Omarchy laptop — exact copy steps

```sh
# 1) Ensure alfred-pi on PATH (no npm publish required if using local package)
export PATH="$HOME/.local/bin:$PATH"
# either published:
#   npm install -g --ignore-scripts --prefix "$HOME/.local" @openroyleal/alfred-pi
# or local dogfood tree (same as Vultr):
#   npm install -g --ignore-scripts --prefix "$HOME/.local" ~/projects/OpenRoyleAl/alfred-report/packages/alfred-pi

# 2) PATH shell for Herdr panes
cat > ~/.local/bin/herdr-login-shell <<SH
#!/bin/bash
export PATH="${HOME}/.local/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"
exec /bin/bash "$@"
SH
chmod +x ~/.local/bin/herdr-login-shell

# 3) Single-token aliases
ln -sfn alfred-pi ~/.local/bin/alfred.report
ln -sfn alfred-pi ~/.local/bin/alfred-report

# 4) Herdr label wrapper (optional but matches agent list)
curl -fsSL -o ~/.local/bin/alfred-herdr \
  # or copy from Vultr: ~/.local/bin/alfred-herdr
# (see snippet below)

# 5) Plugin directory
mkdir -p ~/.herdr-plugins/alfred-report
# copy from Vultr:
#   scp -r vultr:~/.herdr-plugins/alfred-report/ ~/.herdr-plugins/
# or recreate herdr-plugin.toml + launch.sh from packages/alfred-pi/herdr-plugin/

# 6) Link + enable
herdr plugin link ~/.herdr-plugins/alfred-report
herdr plugin enable alfred.report

# 7) Append to ~/.config/herdr/config.toml
```

### Snippet for `~/.config/herdr/config.toml`

```toml
[terminal]
default_shell = "/home/OPENROYLEAL_OR_YOU/.local/bin/herdr-login-shell"
shell_mode = "non_login"
new_cwd = "follow"

[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "alfred.report.alfred-pi"
description = "Alfred.report! (alfred pi)"
```

Replace the home path with your Omarchy user home. Then:

```sh
herdr server reload-config
herdr plugin action list --plugin alfred.report
# expect titles: alfred.report, alfred pi, alfred report, Alfred.report!
```

### Smoke (do not burn MIMO)

```sh
export PATH="$HOME/.local/bin:$PATH"
alfred-pi --self-test          # wake-word only, no inference
herdr plugin list | grep alfred
# optional: herdr pane report-agent <pane> --source custom:alfred-report --agent alfred --state idle
# herdr agent list   # should include agent=alfred when reported / alfred-herdr running
```

## Vultr note

Use `/usr/local/bin/herdr` (0.8.2). `~/.local/bin/herdr` may be a newer binary that needs GLIBC_2.39 and will fail on this host — keep `/usr/local/bin` ahead of `~/.local/bin` when calling `herdr` on Vultr, or call `/usr/local/bin/herdr` explicitly.
