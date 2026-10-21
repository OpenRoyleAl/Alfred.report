# Edge desktop: a real computer Alfred can drive for the user

Goal: a full, usable **Omarchy** desktop (not headless) on Cloudflare, one Alfred can log into and
drive with a browser for the user, like a cloud desktop.

Researched 2026-10-20 (Asia/Manila) against the full Cloudflare changelog (RSS, 1,369 entries back to
2024-02-26) and the docs (`cf docs search` plus the pages linked below). Every claim is sourced. Where
nothing was found, this doc says so.

## Priority (updated 2026-10-21)

The desktop is **nice-to-have, not required**. Voice (ORAL / The Report) and missions come first.
The required capability is "Alfred drives a browser for the user", and Browser Run covers it.
Nothing here builds on deprecated Sandbox SDK APIs. That rules out the removed `sandbox.desktop`,
`exposePort()` (use Sandbox tunnels), the HTTP/WebSocket transports (use RPC), and default
sessions. If the desktop experiment ever runs, it uses plain Containers or Sandbox SDK 1.0 (`@next`)
with our own VNC extension.

### 2026-10-21 changelog re-check
- **Think agents use a `@cloudflare/computer` workspace** ([2026-10-20](https://developers.cloudflare.com/changelog/post/2026-10-20-think-computer-workspace/)). Think and Agent Skills now get a `Workspace` (files kept in DO storage, plus a `WorkerJavaScriptBackend` for code execution). `@cloudflare/shell` and Think's `createExecuteTool` are deprecated. This is a **filesystem + code-execution workspace, not a display**, so it does **not** open a non-headless desktop path and the Omarchy verdict below is unchanged. Alfred uses neither deprecated package (checked with `git grep`). It is still a good home for mission scratch files and skills, so it is a candidate to replace ad hoc file tools in the Alfred DO.
- **Sandbox SDK desktop removed** ([2026-06-09](https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/#desktop)). Cloudflare's guidance is to rebuild it yourself with extensions. We won't plan around it.
- Nothing else since 2026-10-01 adds GPUs, nested virtualisation, or a hosted desktop.

## Verdict

| Question | Answer |
| --- | --- |
| Full Omarchy (the distribution) on Cloudflare? | **No verified path.** Omarchy installs from its ISO (full disk or dual boot) or runs in a local VM ([omarchy.org](https://omarchy.org)). Containers run *your image inside a Firecracker microVM*, with no ISO boot or bootloader. No GPU or nested-virtualisation offering appears anywhere in the changelog or docs. |
| A full, non-headless Linux desktop on Cloudflare? | **Yes, it has been shown to work.** Cloudflare's own Sandbox SDK shipped a desktop feature: "a full Linux desktop inside the sandbox (display server, desktop environment, and VNC/noVNC) so agents and apps could drive a GUI". It was **removed in 0.10.2** for low adoption, and Cloudflare suggests building it yourself on the sandbox ([changelog 2026-06-09](https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/)). |
| An Omarchy-*style* desktop (Arch + Hyprland + Omarchy config) in a Container? | **Plausible, not verified.** Arch publishes `linux/amd64` images, and Containers require `linux/amd64`. But Hyprland would have to run on CPU-only software rendering behind a VNC bridge, and I could not test that here: deploys are not allowed, and the box has no Docker. |
| Best verified path for "Alfred drives a browser for the user" today? | **Browser Run persistent browser + Live View.** These are GA/stable features, detailed below. It gives a real Chrome that Alfred drives and the user can watch and take over, but not a whole desktop. |

**Not scaffolded.** I only scaffold when a viable path exists. For Omarchy I could not verify one, so
nothing desktop-related is in the code. The rest of this doc covers the evidence, the limits, and the
experiment that would settle it.

## The building blocks (verified)

### Containers (the only place a full GUI stack can run)
- **Runtime:** "Each container instance runs in a Firecracker microVM with its own kernel and network." Images must be built for `linux/amd64` ([architecture](https://developers.cloudflare.com/containers/concepts/architecture/)).
- **Size:** the largest preset is `standard-4`, with 4 vCPU, 12 GiB RAM and 20 GB disk. Custom types allow up to 4 vCPU, 12 GiB and 20 GB, with at least 3 GiB per vCPU ([limits](https://developers.cloudflare.com/containers/platform/limits/); [changelog 2026-09-29](https://developers.cloudflare.com/changelog/post/2026-09-29-remove-disk-to-memory-ratio/)). There is **no GPU instance type** in the limits page or the changelog.
- **Run time:** there is no fixed maximum. The platform may stop an instance with SIGTERM, then SIGKILL up to 15 minutes later. "All disk is ephemeral by default" ([FAQ](https://developers.cloudflare.com/containers/faq/)).
- **Persistence:**
  - Snapshots (public beta, `durable_object` scheduling policy only): up to 20 GB, kept 30 days from creation or last restore ([changelog 2026-09-30](https://developers.cloudflare.com/changelog/post/2026-09-30-snapshots/), [limits](https://developers.cloudflare.com/containers/platform/limits/#snapshot-limits)).
  - Alternatively, FUSE-mounted R2 ([FAQ](https://developers.cloudflare.com/containers/faq/)).
- **Per-user control:** the `durable_object` scheduling policy (public beta) lets a Durable Object choose the image and size at `ctx.container.start()`. It also supports the managed `cloudflare/debian-trixie` image ([changelog 2026-09-30](https://developers.cloudflare.com/changelog/post/2026-09-30-durable-object-scheduling-policy/), [scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)).
- **Getting pixels out:** a Worker or Durable Object reaches container ports with `ctx.container.getTcpPort(port).fetch()` / `.connect()` ([Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)). Cloudflare documents WebSocket proxying to a container ([example](https://developers.cloudflare.com/containers/examples/websocket/)). noVNC speaks VNC over WebSocket, so it fits this model; the retired Sandbox desktop used VNC/noVNC.
- **Other:**
  - Docker-in-Docker works, but iptables does not and IP forwarding is off under the `durable_object` policy ([FAQ](https://developers.cloudflare.com/containers/faq/)).
  - The cf CLI can express all of this: `@cloudflare/config` has `defineContainer` with `schedulingPolicy: "durable-object"` and named images (checked in `cf` 1.0.0-beta.19's bundled types).

### Sandbox SDK 1.0 / `@cloudflare/computer`
- **Sandbox SDK 1.0:** your own Durable Object controls each sandbox, with snapshots, terminals, and previews on your own hostnames with your own authentication ([changelog 2026-09-30](https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/)). Its **built-in desktop API is gone** (removed in 0.10.2, see above).
- **`@cloudflare/computer`** (preview, 2026-08-03) is an agent runtime with a SQLite-backed filesystem, shell and Git, running on isolates or Containers. It has **no display or GUI** ([changelog](https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/)).

### Browser Run (verified path for browser work)
- **Persistent browser tool:** the Agents SDK (v0.28.0 or later) has a `browserTool` whose tabs, cookies and logins survive between turns while the session lives. The default idle timeout is 10 minutes. If the session expires, the tool starts a fresh browser and the logins are lost ([changelog 2026-10-13](https://developers.cloudflare.com/changelog/post/2026-10-13-persistent-browser/)).
- **Live View:** a person can watch and **control** a session's tab, or the full browser UI, through `live.browser.run` (modes `tab`, `full`, `devtools`). A read-only mode also exists ([Live View](https://developers.cloudflare.com/browser-run/features/live-view/); [changelog 2026-09-14](https://developers.cloudflare.com/changelog/post/2026-09-14-guardrails/)).
- **Human in the Loop:** a structured handoff lets the agent ask a human to take over through Live View, then resume ([changelog 2026-07-28](https://developers.cloudflare.com/changelog/post/2026-07-28-human-in-the-loop/)).
- **Multiple clients per session:** supported, with `@cloudflare/puppeteer` 1.1.0 or later ([changelog 2026-09-29](https://developers.cloudflare.com/changelog/post/2026-09-29-concurrent-session-connections/)).
- **Limits:**
  - Sessions close after inactivity: 1 minute by default, settable up to 20 minutes, and kept alive by activity.
  - Sessions also close when Browser Run rolls out a release.
  - Workers Paid allows 200 concurrent browsers per account ([limits](https://developers.cloudflare.com/browser-run/limits/)).
  - Browser Run is a **browser**, not a desktop: no other apps, and no files beyond the browser.

### Searched for, not found
- No GPU Containers or GPU instance types.
- No nested virtualisation or KVM in Containers. The only KVM entries are the *Cloudflare One Appliance* on customer hypervisors.
- No managed "cloud desktop", VDI, Wayland or Hyprland product.
- Browser-based **RDP** with Access is GA ([2025-09-22](https://developers.cloudflare.com/changelog/post/2025-09-22-browser-based-rdp-ga/)), but it reaches *your own* Windows servers over Tunnel/WARP. It is not a Cloudflare-hosted computer.

## Best path, if we pursue a desktop

1. **Browser now (the required part):**
   - Add Browser Run `browserTool` to the Alfred agent so missions can log in and act in a real Chrome.
   - When a site needs the user (2FA, consent), hand off through Human in the Loop and Live View.
   - The pieces needed are the `BROWSER` and `LOADER` bindings plus Agents SDK 0.28 or later.
   - This is the verified path for "Alfred drives a browser for the user".
2. **Desktop experiment (optional, after voice and the browser tool)**: one owner-only Container behind Access, with no deprecated Sandbox desktop APIs:
   - Image: Arch `linux/amd64` with a headless Wayland session (Hyprland with Omarchy's configs), a VNC server, noVNC/websockify and Chromium.
   - Instance: `standard-4`, started from a Durable Object with the `durable_object` policy.
   - Persistence: snapshot on idle, restore on next login.
   - Display: stream noVNC through the Worker's WebSocket proxy.
   - Alfred drives it with screenshots, keyboard and mouse (`xdotool`/`wtype`-style tools via `exec()`).

### Limits to expect on the desktop path
- **No GPU:** rendering is on the CPU (Mesa software rendering), so Hyprland's effects and video will be slow. Whether Hyprland runs well that way is the main unknown.
- **Size cap:** 4 vCPU, 12 GiB and a 20 GB disk/image, which is small for a full Omarchy package set.
- **Persistence:** not a real disk. Snapshots are point-in-time, immutable, kept 30 days and in beta. Platform restarts lose anything not yet snapshotted.
- **Not Omarchy proper:** there is no bootloader, ISO installer, systemd-as-PID-1 machine, hardware drivers or disk encryption, so it is "Omarchy config on Arch in a container".
- **Latency:** VNC over WebSocket through a Worker, so no native client.

### What would settle viability
- Build the image locally with Docker and run Hyprland headless + VNC + noVNC on CPU rendering at 4 vCPU / 12 GiB.
- If that is usable, deploy one owner-only test instance and measure frame rate, input latency, cold start and snapshot restore time.

Neither step was possible in this round: deploys are not permitted, and the build box has no Docker.
