export type CalloutKind = "law" | "kill" | "proof";

export type Block =
  | { type: "lede"; text: string }
  | { type: "p"; text: string }
  | { type: "h3"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "callout"; kind: CalloutKind; title: string; body: string }
  | { type: "code"; label: string; code: string }
  | { type: "principles"; items: { n: string; title: string; body: string }[] }
  | { type: "days"; items: { day: string; title: string; why: string; items: string[] }[] }
  | { type: "stack"; layers: { name: string; detail: string }[] };

export type Chapter = {
  id: string;
  num: string;
  title: string;
  kicker: string;
  blocks: Block[];
};

export const BRIEF_META = {
  id: "MB-001",
  classification: "Building today for tomorrow",
  title: "Alfred.report",
  subtitle: "The operating system for one principal and a staff of ephemeral agents.",
  replaces: "Mimo v2.5 Pro repair ticket",
  date: "4 September 2026",
  status: "Constitution — execute, do not decorate",
};

export const COVER_DECK = [
  "The last brief diagnosed wreckage and prescribed a token rotation. That is janitorial work wearing a general's coat.",
  "This brief names the category, the physics, the kernel, and the one closed loop that proves the system is real.",
];

export const CHAPTERS: Chapter[] = [
  {
    id: "verdict",
    num: "00",
    title: "The verdict",
    kicker: "Why the previous brief cannot be executed",
    blocks: [
      {
        type: "lede",
        text: "Mimo wrote a repair ticket and called it a plan. Five failure modes. None of them are “the token expired.”",
      },
      {
        type: "p",
        text: "The wreckage is real: Hermes gateway dark for nine days, an MCP memory sidecar disabled with invalid flags, eighteen MySQL processes, five uncoordinated Grok sessions, OpenClaw holding 630MB as a second control plane. The diagnosis of symptoms is mostly accurate. The strategy is inverted. It treats a decaying integration as the brain, an org chart as authority, and cleanup as Phase 2 of a system that is already insolvent.",
      },
      {
        type: "h3",
        text: "Five ways the ticket fails as strategy",
      },
      {
        type: "table",
        headers: ["Mimo move", "What it actually is", "What a constitution requires"],
        rows: [
          [
            "Phase 1: rotate cf-memory token, enable config, fix CLI args",
            "Restoring a 2025 MCP hack. Hermes already has four native memory layers. Cloudflare shipped Agent Memory in April 2026 as a managed extract/retrieve service designed to sit beside Hermes without changing the loop. The sidecar with --env and --connect-timeout is not that product.",
            "A memory doctrine: canon on disk, bounded native memory, one external provider, promotion after GATE.",
          ],
          [
            "Keep OpenClaw and Hermes, then ‘establish command’",
            "Two harnesses, zero kernel. OpenClaw is gateway-first (Node daemon, channels, 138 CVEs in 63 days of 2026 disclosures). Hermes is agent-first (learning loop, memory, self-generated skills). Dual-running them on 8GB is the wreckage.",
            "One harness. One process supervisor. One source of truth.",
          ],
          [
            "Alfred as Commander, A-Teams, President plays golf",
            "Org-chart cosplay. Naming a profile Commander does not grant budgets, evals, or a durable unit of work. 2026 production systems run outcome-managed agents and ephemeral workers, not standing armies.",
            "Chief of Staff, not army. The principal sets outcomes and audits. The system closes missions.",
          ],
          [
            "roster.json, GATE.md, EVALS.md, two delegation models",
            "Literature. Artifacts without a kernel object. Until Mission is a first-class record with acceptance and evidence, Alfred can only chat.",
            "Mission is the atomic unit. Sessions die. Missions persist until GATE.",
          ],
          [
            "Phase 2: kill redundant sessions (after ‘fixing the brain’)",
            "Housekeeping scheduled after the house is on fire. 5 Grok sessions + 18 MCP servers on 8GB/4 vCPU is insolvency. You cannot test memory on a swapping box.",
            "Resource physics on Day 0. Tokens, RAM, processes, and context are the budget.",
          ],
        ],
      },
      {
        type: "callout",
        kind: "kill",
        title: "Do not execute Mimo Phase 1 as written",
        body: "Do not rotate a token on a disabled MCP server and call it a brain. Do not enable a second commander. Do not spawn A-Teams on an 8GB box that already cannot supervise one gateway. Stop the bleed, pick one harness, then install the kernel.",
      },
    ],
  },
  {
    id: "physics",
    num: "01",
    title: "First principles",
    kicker: "The physics of a staff that actually closes work",
    blocks: [
      {
        type: "lede",
        text: "Models are abundant. Closure is scarce. Design for the scarce thing.",
      },
      {
        type: "principles",
        items: [
          {
            n: "I",
            title: "An agent is a loop, not a person",
            body: "Perceive, plan, act, evaluate, remember. A profile named Alfred is a costume. Authority is not a biography. It is identity plus budget plus a channel that can say no.",
          },
          {
            n: "II",
            title: "Memory is a promotion policy",
            body: "Not a database you toggle. What survives compaction, under what key, with what supersession, at what token cost. Bounded beats infinite. Hermes caps MEMORY.md near 2,200 characters so the system is forced to choose. That constraint is the feature.",
          },
          {
            n: "III",
            title: "One harness, one supervisor, one source of truth",
            body: "Everything else is a plugin. A second control plane is not redundancy. It is two goldfish arguing about the client.",
          },
          {
            n: "IV",
            title: "The atomic unit is the Mission, not the session",
            body: "Sessions die. Context windows rot. A Mission is a durable object: objective, budget, tools, acceptance, evidence, report. Work that cannot be named as a Mission is not work. It is spend.",
          },
          {
            n: "V",
            title: "Authority is a budget",
            body: "Tools, tokens, wall-clock, blast radius, write access. Delegation without a budget is unaccountable spend. The principal funds missions. The staff may not overdraw.",
          },
          {
            n: "VI",
            title: "Done is evidence, not a speech",
            body: "GATE.md that is not executed is literature. A worker cannot mark complete. An independent check reads evidence against acceptance. No evidence, no close.",
          },
          {
            n: "VII",
            title: "Specialists are ephemeral",
            body: "Spawn, isolate, return a handoff document, die. Persistent specialists become five Grok sessions. Hermes already has delegate_task for this: restricted tools, isolated session, no shared history.",
          },
          {
            n: "VIII",
            title: "The human is the principal, not a golfer",
            body: "The 2026 pattern is not disappearance. It is outcomes and audit. Agents handle handoffs so people are not routers. Sessions never start from scratch. The principal plays the game that only the principal can play — judgment, clients, capital — while the staff closes the rest.",
          },
        ],
      },
      {
        type: "callout",
        kind: "law",
        title: "Law",
        body: "If it does not survive a new session, a process restart, and an independent GATE, it is not part of the operating system. It is chat.",
      },
    ],
  },
  {
    id: "category",
    num: "02",
    title: "Category",
    kicker: "Design the game, then the product",
    blocks: [
      {
        type: "lede",
        text: "Category design first. Product second. If you compete as “my agent army,” you will keep adding sessions until the box dies.",
      },
      {
        type: "h3",
        text: "The old category is a trap",
      },
      {
        type: "p",
        text: "Chat sessions. Personal assistants. Butler agents. Swarms. The market already has those, and they all fail the same way: they start work in five places, remember in none, verify in none, and report as vibes. You do not have a labor shortage. You have a closure shortage.",
      },
      {
        type: "h3",
        text: "Problem",
      },
      {
        type: "p",
        text: "A principal with real clients (sites, ops, people who expect a finished thing) is paying for motion. Five Grok sessions re-derive the world. A commander profile with sixty skills cannot retrieve a client fact tomorrow. A morning brief fires sixty-one times and still cannot say whether Graham Beisly’s website is done.",
      },
      {
        type: "h3",
        text: "Ramifications",
      },
      {
        type: "list",
        items: [
          "Token insolvency — you pay for context rot and duplicate MCP processes, not for closed missions.",
          "Goldfish command — no durable client model, no decision log, no procedure that improves.",
          "Unverifiable ‘done’ — the only completion signal is the model announcing it.",
          "Principal as router — you re-paste context between sessions because the system will not hand off.",
          "Security and ops debt — a second gateway (OpenClaw) with a 2026 CVE storm, plus a Hermes gateway that has been dead for nine days, is not a staff. It is an attack surface with a payroll.",
        ],
      },
      {
        type: "h3",
        text: "The new category",
      },
      {
        type: "p",
        text: "Alfred.report — a Chief of Staff operating system. One principal. One commander role. Ephemeral specialists. Durable missions. Eval-gated close. A reporting channel the principal can trust without sitting in the loop.",
      },
      {
        type: "p",
        text: "This is the 2026 edge, not a novelty: agent harnesses are the new OS layer (runtime, memory, gateway, policy). Hermes bets that memory and self-improvement are the hard problem. OpenClaw bets that routing is. Cloudflare Agent Memory, Honcho, Hindsight exist because stuffing the window is a solved-and-failed idea. BCG’s operating-system-of-work work says the unit of change is the end-to-end outcome, not the task. Wharton/Karayev: agents handle handoffs; cloud sessions never start from scratch; people stop being copy-paste routers.",
      },
      {
        type: "table",
        headers: ["Old game", "Alfred.report"],
        rows: [
          ["Pay per session-hour", "Pay per closed mission"],
          ["Personality as product (Alfred the butler)", "Role as product (Chief of Staff)"],
          ["Standing army of chats", "Ephemeral workers, durable Mission"],
          ["Memory = leftover context", "Memory = keyed promotion with forgetting"],
          ["Skills from a marketplace", "Skills earned from GATEd missions (agentskills.io, self-generated)"],
          ["Two harnesses for ‘coverage’", "One harness; channels are peripherals"],
          ["Done = the model said so", "Done = evidence + independent GATE + report"],
        ],
      },
      {
        type: "callout",
        kind: "proof",
        title: "Lightning rod — the sentence the category must make true",
        body: "“Handle Graham Beisly’s website. Research, fix, verify, report. One mission. One budget. One GATE.” If that sentence cannot run without you in the middle, you do not have a Alfred.report. You have chat with extra steps.",
      },
    ],
  },
  {
    id: "kernel",
    num: "03",
    title: "The kernel",
    kicker: "What to keep, what to kill, what sits at the center",
    blocks: [
      {
        type: "lede",
        text: "Pick Hermes. Demote or decommission OpenClaw as a control plane. Install a kernel the harness serves — not a personality the harness improvises.",
      },
      {
        type: "stack",
        layers: [
          { name: "Principal", detail: "Outcomes, budgets, veto. One human. Not a router." },
          { name: "Command kernel — Alfred as role", detail: "Mission store, memory doctrine, identity, budgets, GATE, process supervisor." },
          { name: "One harness — Hermes", detail: "Agent loop, MEMORY.md / USER.md, SQLite FTS5, skills, cron, delegate_task, profiles." },
          { name: "One gateway", detail: "Discord + CLI as the reporting plane. Hermes messaging is first-class. Do not run a second commander for channels." },
          { name: "Ephemeral workers", detail: "Isolated sessions, restricted tools, structured handoff, die. No standing Grok sessions." },
        ],
      },
      {
        type: "h3",
        text: "Why Hermes is the harness, not OpenClaw",
      },
      {
        type: "list",
        items: [
          "Memory-first four-layer design already matches the actual gap. OpenClaw still leans on the window and JSONL replay — recall latency in 2026 harness comparisons was orders of magnitude worse.",
          "delegate_task already isolates workers. You do not need a second delegation invention.",
          "Cron already works — morning-brief has 61 successful fires. That is the reporting plane, starving for a Mission object to report on.",
          "Skills are self-generated SKILL.md files, agentskills.io portable, updated from evidence. OpenClaw’s ClawHub model is a supply-chain (341 malicious skills in 2026 audits).",
          "CVE load is not close. OpenClaw absorbed a three-digit CVE wave in 2026 including critical RCE. Hermes is not holy; it is operable.",
          "The thing that is already alive on the box (agent sessions, cron) is Hermes. The thing that is dead is the Hermes gateway process — which is a supervisor problem, not a reason to keep a 630MB second OS.",
        ],
      },
      {
        type: "callout",
        kind: "kill",
        title: "OpenClaw policy",
        body: "Not a second Alfred. If a specific channel is unmatched, it may live as a dumb pipe under the kernel — never as a commander, never with skills marketplace enabled, never with auth off. Default action: decommission. The 8GB envelope does not fund two operating systems.",
      },
      {
        type: "h3",
        text: "What already exists and must be reused, not rebuilt",
      },
      {
        type: "p",
        text: "Alfred’s profile, roster, GATE.md, EVALS.md, and two delegation sketches are not wasted. They are unenforced. The kernel makes Mission the object they hang off, makes GATE executable, and makes roster a set of Hermes profiles (isolated memory) spawned per mission — not 24/7 processes.",
      },
    ],
  },
  {
    id: "mission",
    num: "04",
    title: "The Mission object",
    kicker: "If it cannot be a Mission, it is not work",
    blocks: [
      {
        type: "lede",
        text: "This is the schema. Everything else in the staff exists to move one of these from drafted to complete — or to abort it with a reason.",
      },
      {
        type: "code",
        label: "missions/{id}.yaml — source of truth on disk",
        code: `id: mb-beisly-site
principal: you
client: Graham Beisly
objective: >
  Restore Graham Beisly's website to a verified working
  state the client would accept, and report what changed.
state: drafted   # drafted | active | gated | complete | failed | aborted
budget:
  tokens: 800000
  wall_clock: 4h
  max_workers: 2
  blast: "staging-first; prod only after GATE"
tools_allowed:
  - browser
  - repo
  - dns_read
  - deploy_staging
constraints:
  - no prod write without GATE
  - no client message without principal
acceptance:
  - "Canonical URL returns 200 and renders primary content"
  - "No uncaught console errors on home and the reported broken path"
  - "Root cause written in one paragraph a non-engineer can read"
  - "Fix is in version control with a revert path"
evidence: []
handoffs: []
report: null`,
      },
      {
        type: "h3",
        text: "Lifecycle",
      },
      {
        type: "list",
        items: [
          "Drafted — principal or Alfred names the outcome. No spend yet.",
          "Active — budget is live. Workers may spawn. Mid-flight noise is exception-only (blocker, budget, safety).",
          "Gated — worker claims done. Independent checker (different session, checklist against acceptance) reads evidence only.",
          "Complete — GATE passed, report delivered on the principal’s channel, memory promotion ran.",
          "Failed / aborted — reason, spend, and what to remember. Failure is a first-class close.",
        ],
      },
      {
        type: "h3",
        text: "Handoff protocol",
      },
      {
        type: "p",
        text: "Workers do not dump transcripts. They return a structured handoff: deliverables, decisions, uncertainties, constraints, evidence pointers. This is the 2026 multi-agent pattern that actually works — hybrid memory (private worker scratch + shared blackboard) plus a document, not a vibe.",
      },
      {
        type: "code",
        label: "handoff.json — what a worker is allowed to return",
        code: `{
  "mission_id": "mb-beisly-site",
  "worker": "research-1",
  "status": "blocked | progressed | claimed_done",
  "deliverables": ["..."],
  "decisions": ["..."],
  "uncertainties": ["..."],
  "evidence": ["path or url"],
  "spend": { "tokens": 0, "minutes": 0 },
  "recommend": "continue | gate | abort | ask_principal"
}`,
      },
      {
        type: "callout",
        kind: "law",
        title: "Completion law",
        body: "A Mission is not complete until every acceptance item has evidence, GATE passes, the principal receives a report they did not have to prompt for, and memory promotion has written what should persist — and what should be forgotten.",
      },
    ],
  },
  {
    id: "memory",
    num: "05",
    title: "Memory doctrine",
    kicker: "Four layers. One provider. Promotion, not hoarding.",
    blocks: [
      {
        type: "lede",
        text: "cf-memory as an MCP sidecar is not Alfred’s brain. Treating it as Phase 1 is how you spend a day restoring a corpse.",
      },
      {
        type: "p",
        text: "Hermes native memory is always on: MEMORY.md and USER.md (bounded, must consolidate), SQLite FTS5 session archive, skills as procedural memory. External providers are additive, and Hermes permits exactly one at a time. That is the correct topology. A broken MCP with invalid CLI args is not a layer. It is a leak.",
      },
      {
        type: "h3",
        text: "The four layers you will actually run",
      },
      {
        type: "table",
        headers: ["Layer", "What lives here", "Rule"],
        rows: [
          [
            "0 — Canon",
            "CLIENTS.md, missions/*.yaml, SOPs, GATE checks, identity file. Git or disk. Always loaded by path, never hoped-for recall.",
            "If the staff must not forget it, it is a file, not a memory.",
          ],
          [
            "1 — Native (always on)",
            "MEMORY.md (~2.2k chars), USER.md (principal model), SQLite FTS5 for cold recall via session_search.",
            "When full, consolidate. Do not raise the cap. Forgetting is load-bearing.",
          ],
          [
            "2 — Procedural",
            "SKILL.md files earned from GATEd missions. YAML frontmatter plus the procedure, pitfalls, verification.",
            "A skill unused in GATE is dead weight. Sixty unread skills is a costume.",
          ],
          [
            "3 — One external provider",
            "Pick one: Cloudflare Agent Memory (Apr 2026 managed extract/retrieve, profile-scoped Durable Objects, keyed supersession, FTS + vector + HyDE fused), Honcho (user modeling), or self-hosted Hindsight / OpenViking if sovereignty beats ops.",
            "hermes memory setup. Never two. Never a DIY MCP with --env / --connect-timeout as the primary store.",
          ],
        ],
      },
      {
        type: "h3",
        text: "What to do with the expired cf-memory token",
      },
      {
        type: "p",
        text: "Classify it. If it is the old community MCP wrapper, disable it permanently and delete the invalid args. If you want Cloudflare in 2026, use Agent Memory as a proper provider/binding — extraction on compaction, retrieval on demand, facts and instructions keyed so new memory supersedes old rather than accumulating contradictions. That is a different product from “rotate the token and set enabled: true.”",
      },
      {
        type: "h3",
        text: "Promotion — the only write that matters",
      },
      {
        type: "p",
        text: "After every GATE, Alfred writes three things: which fact changed (keyed, superseding), which procedure was learned (skill create or revise), and what must be forgotten. Memory poisoning is a real 2026 failure mode. Hoarding is how you get a confident, wrong commander.",
      },
      {
        type: "callout",
        kind: "proof",
        title: "Memory is real when",
        body: "Session A stores a client fact. Process restarts. Session B retrieves it unprompted. Session C supersedes it. Canon still matches. If any of those fail, you do not have a brain. You have a log.",
      },
    ],
  },
  {
    id: "resources",
    num: "06",
    title: "Resource doctrine",
    kicker: "8GB is a physics envelope, not a suggestion",
    blocks: [
      {
        type: "lede",
        text: "Tokens, RAM, MCP processes, and context windows are the budget. The box is already overdrawn. Day 0 is a freeze, not a feature.",
      },
      {
        type: "table",
        headers: ["Resource", "Hard cap on this box", "Why"],
        rows: [
          ["Harness processes", "1 Hermes gateway + 1 supervisor (systemd/restart)", "A second OS is 630MB you do not have."],
          ["MCP servers", "1 process per capability, pooled", "18 MySQL clones are a fork bomb with a vendor name."],
          ["Persistent model sessions", "0 unless a Mission is Active", "Five Grok sessions are competing principals, not workers."],
          ["Workers", "Ephemeral; idle-kill; max per Mission", "delegate_task, then death. No pets."],
          ["Cron", "Must declare expected spend", "morning-brief is allowed. Open-ended “check everything” is not."],
          ["Tokens", "Hard stop per Mission", "Overdraw requires principal confirm. No silent extension."],
        ],
      },
      {
        type: "h3",
        text: "Day 0 — stop the bleed",
      },
      {
        type: "list",
        items: [
          "Identify live vs idle Grok sessions. Kill idle. Kill duplicates. The principal talks to Alfred on one channel.",
          "Collapse MCP to one server per capability. If eighteen MySQL processes exist, seventeen are bugs.",
          "Confirm Hermes gateway supervision — why it has been dead nine days is a process question (restart policy, crash loop, Discord token, event-loop freeze). Fix the supervisor, not the mythology.",
          "Snapshot configs before changing memory. Do not “enable” broken flags.",
          "Measure: RSS by process, MCP count, session count, tokens/hour at idle. Idle should be cron-only.",
        ],
      },
      {
        type: "callout",
        kind: "kill",
        title: "Insolvency rule",
        body: "If idle token burn is not approximately zero except cron, the system is not ready for a brain, a staff, or a client mission. Do not add capability on top of a leak.",
      },
    ],
  },
  {
    id: "authority",
    num: "07",
    title: "Command authority",
    kicker: "Identity × budget × channel",
    blocks: [
      {
        type: "lede",
        text: "Alfred does not become Commander by prompt. He becomes Commander when the kernel will refuse him.",
      },
      {
        type: "h3",
        text: "Identity file — the only biography that matters",
      },
      {
        type: "code",
        label: "identity/alfred.md — bound into the commander profile",
        code: `role: Chief of Staff
principal: one human
may:
  - open a Mission from a one-liner
  - spend up to the Mission budget
  - spawn ephemeral workers with restricted tools
  - write memory per doctrine
  - report on ack, exception, and close
  - abort with a reason when GATE cannot pass
may_not:
  - exceed budget without principal confirm
  - touch production without GATE
  - run a second harness as commander
  - mark complete without evidence
  - message a client without principal
  - download marketplace skills
escalate_when:
  - budget would overdraw
  - prod write required
  - client communication required
  - two missions contend for the same system
channel: Discord DM or CLI — one surface
report: ack → exception-only mid-flight → close-out
morning_brief: fleet of Missions, spend, blockers — not a novel`,
      },
      {
        type: "h3",
        text: "QA is a second pass, not a vibe",
      },
      {
        type: "p",
        text: "GATE.md and EVALS.md become an executable checklist agent. Different session. Read-only against the Mission. Inputs: acceptance items and evidence pointers. Output: pass, fail with gaps, or abort. The worker that did the work is recused. This is the evaluation component every 2026 agentic OS lists and almost nobody implements — which is why demos work and production lies.",
      },
      {
        type: "callout",
        kind: "law",
        title: "Refusal is the feature",
        body: "A commander who cannot refuse is a butler. Wire the refusals first: over-budget, prod-without-GATE, complete-without-evidence. Then give him work.",
      },
    ],
  },
  {
    id: "sequence",
    num: "08",
    title: "Build sequence",
    kicker: "Today for tomorrow — no army until one loop closes",
    blocks: [
      {
        type: "lede",
        text: "Order is the strategy. Reverse it and you get Mimo again: a token, a mess, a speech about A-Teams.",
      },
      {
        type: "days",
        items: [
          {
            day: "0",
            title: "Physics",
            why: "You cannot install a brain on a swapping box, and you cannot trust a test while five sessions burn tokens.",
            items: [
              "Kill idle and duplicate Grok sessions. Principal keeps one channel to Alfred.",
              "Collapse MCP to one process per capability.",
              "Put Hermes gateway under a real supervisor (restart, logs, health). Explain the nine-day death with a cause, not a guess.",
              "Decide OpenClaw: decommission default. Pipe-only if a channel is truly unmatched.",
              "Snapshot ~/.hermes and related configs. Record idle RSS, process count, tokens/hour.",
            ],
          },
          {
            day: "1",
            title: "Kernel",
            why: "This is the real Phase 1. Memory without a Mission object is a diary. A Mission object without GATE is a blog.",
            items: [
              "Create missions/ with the schema in this brief. Empty is fine. The folder is the store.",
              "Write identity/alfred.md and bind it to the commander profile.",
              "Turn GATE into an executable check (script or recused agent) that reads evidence against acceptance.",
              "Point morning-brief at the Mission fleet: states, spend, blockers. Stop writing essays.",
              "Define the reporting channel. One. Discord or CLI. Not both as competing brains.",
            ],
          },
          {
            day: "2",
            title: "Memory doctrine",
            why: "Native first. One provider second. MCP archaeology never.",
            items: [
              "Hygiene on MEMORY.md / USER.md. Consolidate. Put clients and standing decisions in Canon files.",
              "Disable the broken cf-memory MCP permanently unless it is already the 2026 Agent Memory provider — it is not.",
              "hermes memory setup — pick one: Cloudflare Agent Memory, Honcho, or self-hosted Hindsight/OpenViking.",
              "Run the three-session test: store, restart, retrieve, supersede.",
              "Add the post-GATE promotion ritual to the commander identity (fact, skill, forget).",
            ],
          },
          {
            day: "3",
            title: "One closed loop",
            why: "The only proof. Everything after this is multiplication. Everything before it is plumbing.",
            items: [
              "Open Mission mb-beisly-site (or the current equivalent) with objective, budget, acceptance.",
              "Alfred acknowledges on the channel with budget and constraints.",
              "At most two ephemeral workers. Structured handoffs. No standing chats.",
              "GATE against evidence. Fail closed if gaps.",
              "Close-out report unprompted. Promote memory. Idle burn returns to cron-only.",
            ],
          },
          {
            day: "4+",
            title: "Staff, not army",
            why: "A-Teams are profiles you spawn when a second concurrent Mission needs a specialist — not processes you keep warm for company.",
            items: [
              "Earn skills from the closed loop. Delete unused skills until the set is load-bearing.",
              "Add a specialist profile only when two Active missions contend.",
              "Only then name roles (research, builder, iceberg). They remain ephemeral.",
              "Never scale past the resource table. If you need more box, buy more box — do not fork MCP.",
            ],
          },
        ],
      },
      {
        type: "callout",
        kind: "kill",
        title: "Forbidden until Day 3 passes",
        body: "No A-Teams. No new agent products. No second harness. No marketplace skills. No “while we’re here” features. The closed loop is the product.",
      },
    ],
  },
  {
    id: "proof",
    num: "09",
    title: "Proof",
    kicker: "The system is real when these are true, not when they are promised",
    blocks: [
      {
        type: "lede",
        text: "Do not ask Alfred if he is ready. Run the gates.",
      },
      {
        type: "table",
        headers: ["Gate", "Pass condition"],
        rows: [
          ["Harness", "One commander process. OpenClaw is gone or demoted to a pipe."],
          ["Idle", "Token burn ≈ 0 except declared cron."],
          ["MCP", "Process count equals capability count, not 18."],
          ["Gateway", "Hermes gateway survives restart and receives Discord/CLI."],
          ["Memory", "Fact stored in A is retrieved in B after restart; C supersedes it."],
          ["Canon", "Client and standing decisions live in files Alfred loads by path."],
          ["Mission", "A one-liner opens a Mission record with budget and acceptance."],
          ["Refusal", "Alfred refuses prod-without-GATE and complete-without-evidence."],
          ["GATE", "A recused checker can fail a false ‘done’."],
          ["Close", "A real client issue closes with an unprompted report."],
        ],
      },
      {
        type: "h3",
        text: "The only mission that matters first",
      },
      {
        type: "p",
        text: "Handle Graham Beisly’s website — or whatever the live equivalent is the day you execute. Not as a vibe. As mb-beisly-site. If you skip this and build staff anyway, you have rebuilt Mimo with better adjectives.",
      },
      {
        type: "callout",
        kind: "proof",
        title: "Definition of done for this brief",
        body: "You are not done when the box is tidy. You are not done when memory “feels” on. You are done when a Mission opens from a sentence, spends inside a budget, dies if it cannot prove acceptance, and writes a report the principal did not have to beg for. That is Alfred.report. Everything else is costume.",
      },
    ],
  },
];

export function briefToMarkdown(): string {
  const lines: string[] = [
    `# ${BRIEF_META.title} — ${BRIEF_META.id}`,
    ``,
    `_${BRIEF_META.subtitle}_`,
    ``,
    `${BRIEF_META.classification} · ${BRIEF_META.date} · Replaces: ${BRIEF_META.replaces}`,
    ``,
    `Status: ${BRIEF_META.status}`,
    ``,
    ...COVER_DECK.map((p) => p),
    ``,
  ];

  for (const ch of CHAPTERS) {
    lines.push(`## ${ch.num}  ${ch.title}`, ``, `*${ch.kicker}*`, ``);
    for (const b of ch.blocks) {
      switch (b.type) {
        case "lede":
          lines.push(`> ${b.text}`, ``);
          break;
        case "p":
          lines.push(b.text, ``);
          break;
        case "h3":
          lines.push(`### ${b.text}`, ``);
          break;
        case "list":
          for (const item of b.items) lines.push(`- ${item}`);
          lines.push(``);
          break;
        case "table":
          lines.push(`| ${b.headers.join(" | ")} |`);
          lines.push(`| ${b.headers.map(() => "---").join(" | ")} |`);
          for (const row of b.rows) lines.push(`| ${row.join(" | ")} |`);
          lines.push(``);
          break;
        case "callout":
          lines.push(`**${b.kind.toUpperCase()} — ${b.title}**`, ``, b.body, ``);
          break;
        case "code":
          lines.push(`*${b.label}*`, ``, "```", b.code, "```", ``);
          break;
        case "principles":
          for (const p of b.items) {
            lines.push(`### ${p.n}. ${p.title}`, ``, p.body, ``);
          }
          break;
        case "days":
          for (const d of b.items) {
            lines.push(`### Day ${d.day} — ${d.title}`, ``, `_${d.why}_`, ``);
            for (const item of d.items) lines.push(`- ${item}`);
            lines.push(``);
          }
          break;
        case "stack":
          for (const layer of b.layers) {
            lines.push(`- **${layer.name}** — ${layer.detail}`);
          }
          lines.push(``);
          break;
      }
    }
  }
  return lines.join("\n");
}
