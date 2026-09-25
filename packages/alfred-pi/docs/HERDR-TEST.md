# Herdr dogfood — alfred-pi on Vultr

Host: `openroyleal-960` (`ssh -F ~/.ssh/config vultr`)

## One-time / after pull

```sh
export PATH="$HOME/.local/bin:$PATH"
cd ~/projects/alfred-report/packages/alfred-pi
npm install -g --ignore-scripts --prefix "$HOME/.local" .
alfred login
alfred-pi --self-test      # wake-word unit check (no inference)
alfred-pi --smoke          # tiny Workers AI pong via gateway alfred
```

## Interactive (TUI)

```sh
export PATH="$HOME/.local/bin:$PATH"
alfred pi                  # or: alfred report  → splash then TUI
```

Boot: MIMO/Omarchy-style blocky **Al**fred.report! splash (gold Al · cream rest · OpenRoyle**Al** corner · `#c9a227`/`#0a0a0a`), then menus:
**Chat · Models · Resume mission · Usage · Login/Logout · Text REPL · Help · Exit**

Arrow keys / `j` `k` · Enter · `q` quit.

### Chat slash (inline popover)

In **Chat**, type `/` on an empty `alfred>` prompt to open an **inline** slash popover attached above the prompt (keeps `/` in the input line — no center takeover modal):

- **type** after `/` to filter in-place (`/mo` → `/models`, `/model`, …) — no separate `filter:` field
- **↑↓** or **Tab** to move
- **Enter** to run the selected command
- **Esc** or backspace on lone `/` to dismiss
- Does **not** bind Herdr prefix (`ctrl+b`)

Commands: `/models` `/model` `/usage` `/map` `/resume` `/mission` `/login` `/logout` `/help` `/menu` `/exit`  
(`/model` → `/models`, `/map` → `/usage` map view, `/mission` → `/resume`. Default model mode: **Alfred-auto**.)

You can still type a full `/command` manually and Enter, same as before.

```sh
alfred-pi --repl           # text fallback
alfred-pi --no-splash      # skip splash
```

## Try inline slash

```sh
export PATH="$HOME/.local/bin:$PATH"
alfred-pi --self-test          # includes slash catalog checks (no inference)
alfred-pi --no-splash          # skip splash → TUI
# → Chat / prompt → type /
# → popover above alfred> /… · type mo · ↑↓ · Enter on /models · Esc dismiss
# → /model opens searchable select (Workers AI catalog · burns zero for UI)
```

No MIMO. No npm publish.

## Expect

- `alfred pi` splash then TUI.
- Typing `alfred report` / wake in Chat or REPL is local ready — **never** model refusal.
- Models / Resume / Usage / Login work from TUI.
- Herdr relay+web stay ready.

No npm publish required for this dogfood.

## Herdr plugin (New Agent pane launch)

See [HERDR-OMARCHY.md](./HERDR-OMARCHY.md) for the `alfred.report` plugin, PATH shell, aliases (`alfred pi` / `alfred report` / `alfred.report`), and Omarchy laptop copy steps.
