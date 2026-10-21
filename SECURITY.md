# Security

Report a vulnerability in Alfred.report or this repository through a private security advisory
on the repository. Do not open a public issue for active exploits or leaked credentials.

Runtime secrets live in the account's Cloudflare Secrets Store (see docs/CONFIG.md). Never commit
API keys, tokens, `.dev.vars` or `alfred.config.json`. `npm run secret-scan` runs in the gate.
