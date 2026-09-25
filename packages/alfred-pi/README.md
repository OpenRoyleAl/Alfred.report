# alfred-pi

Local harness for [Alfred.report](https://alfred.report). Wake word **Alfred.report!**

Published npm `@openroyleal/alfred-pi` is not on the registry yet. This tree is the dogfood package:

```sh
npm install -g --ignore-scripts --prefix "$HOME/.local" .
# then: alfred pi   /   alfred report
```

## Launch

- **`alfred pi`** / **`alfred report`** — persistent splash home: logo-like **Alfred.report!** wordmark (**Al** gold · **fred** cream · **.** gold · **report** cream · **!** gold) + OpenRoyle**AI** corner, with `Alfred>` prompt (`Type your message… / for commands`). Does **not** auto-advance to a numbered menu.
- **Enter** / type a message → chat · **`/`** → slash popover · **Esc** or **Ctrl+P** → numbered settings menu · **`/exit`** returns to shell with resume hints.
- **`alfred-pi --repl`** — text REPL (`Alfred>`) with `/slash` commands.
- **`alfred-pi --no-splash`** — skip splash (land on numbered menu).
- **Chat `/`** — mimo-style inline slash popover above prompt (filter in-place · ↑↓ · Enter · Esc).
- Wake phrases (`alfred report`, `Alfred.report!`, `alfred pi`, `wake`) are handled **locally** — no model call, no refusal.

Palette matches alfred.report board: black/dark + gold `#c9a227` on **Al** / **.** / **!**.

## Missions (not sessions)

User-facing copy says **mission**. Ids are human kebab meat slugs (`board-brief`, `access-login`, `siri-setup`) — never `session-YYYYMMDD` dumps or UUIDs. New missions get `mission-sep13-pi`-style meat from clock, then alfred-mem-style rename from the first prompt when possible. Resume shows title + slug; copy `alfred report <slug>`.

## Login

Default **`alfred login`** / **`/login`** is Access-first KISS: open [alfred.report/login](https://alfred.report/login) (OSC-8 + plain URL), then paste account id + gateway token. No vault language on the default path. Operator dogfood only: `alfred login --vault` / `ALFRED_PI_OPERATOR=1`.

## Models

Curated Workers AI ladder (~7) — llama-3.2-1b default first. Does **not** dump the full Workers AI catalog. MIMO noted only when gateway keys are configured.

See [docs/HERDR-TEST.md](./docs/HERDR-TEST.md).


## Default skills: live Cloudflare checkout

Alfred.report! defaults to the official [Cloudflare skills](https://github.com/cloudflare/skills), kept as a **live git checkout** at `~/.alfred-pi/skills/cloudflare` (override with `OPENROYLEAL_CF_SKILLS_DIR` / `ALFRED_PI_SKILLS_DIR`), and linked into the Pi harness path `~/.pi/agent/skills/`. It is not a marketplace dump and no `SKILL.md` files are vendored into this repository.

Install, login, and TUI start ensure the checkout exists. `alfred-pi update`, `alfred report update`, or `alfred-pi skills sync` fetch `origin/main` and reset the managed checkout to the latest commit. Verify it with:

```sh
alfred-pi skills status
git -C ~/.alfred-pi/skills/cloudflare remote -v
git -C ~/.alfred-pi/skills/cloudflare log -1 --format='%h %cI %s'
```
