# alfred-grok

**Alfred.report!** Reserve harness (newbie-rich TUI path).

- **Master** is always cloud Alfred.report! (shared Agent Memory).
- This package is a thin brand layer over [mweinbach/open-grok](https://github.com/mweinbach/open-grok).
- Upstream updates: `alfred-grok update` (git pull of your linked checkout) — our CLI name and login stay Alfred.
- `alfred-grok login` → Google on https://alfred.report/login (no API key hell).

## Modes

| Mode | Meaning |
|------|---------|
| Ronin | alfred-grok alone |
| Team | alfred-pi + alfred-grok |
| Web-only | no local harness |

## Install

```bash
# from monorepo
npm link ./packages/alfred-grok
# or
npx --yes @openroyleal/alfred-grok login
```
