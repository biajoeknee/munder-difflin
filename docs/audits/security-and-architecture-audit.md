# Munder Difflin — Security & Architecture Audit

**Audit date:** 2026-07-25
**Commit audited:** `7f5d09d` (branch `main`), working copy on `claude/munder-difflin-security-audit-wr5buq`
**Scope:** whole repository, source-traced. Documentation treated as low-trust; every significant claim below is tied to source with file:line and an evidence label.
**Question 1 (primary):** Should this repository be granted *unrestricted execution* on a workstation holding SSH keys, git/cloud/API credentials, and proprietary source?
**Question 2 (secondary):** Is it a sound long-term foundation for a headless, programmable coding-agent orchestration platform?

**Evidence labels:** `[Confirmed]` read in source · `[Inferred]` strong cross-file inference · `[Docs-only]` asserted only in comments/README · `[Unresolved]` not determinable from the checkout.

---

## SECTION 1 — Executive Security Assessment

### Overall trust assessment

Munder Difflin is a **legitimate, unusually well-engineered multi-agent Claude Code harness**. It is an Electron desktop app whose stated and actual purpose is to spawn autonomous CLI coding agents (Claude Code, Codex, Antigravity, OpenCode, Crush, etc.) in real PTYs, coordinate them through a file-based message bus, and let a "GOD" orchestrator agent ("Michael") route work — optionally triggered remotely from Slack or a generic webhook.

After tracing the source (not the docs), across five independent investigation streams:

> **No malware was found.** No hidden execution paths, no covert telemetry or exfiltration, no credential harvesting, no obfuscation, no anonymous remote-code-execution, and no behaviour unrelated to the stated purpose. The codebase is, if anything, *defensively over-engineered* around secrets and SSRF (OS-keychain secret storage, a loopback capability-token broker that never reveals secrets to agents, a rigorous SSRF block-list, constant-time auth everywhere, a strict renderer CSP, loopback-only PII-free telemetry, and no auto-updater).

The reason to withhold unrestricted execution is therefore **not hidden malice — it is the product's advertised, default-on capability**: it runs autonomous LLM agents with permission prompts **disabled by default**, those agents **inherit the machine's entire environment** (SSH agent socket, `AWS_*`, `GITHUB_TOKEN`, …), it **silently weakens Claude Code's global safety settings**, and an LLM orchestrator can **spawn arbitrary processes** and be **prompt-injected** from remote channels. That is high-authority execution working as designed, not a Trojan — but it is fundamentally incompatible with "unrestricted access to a sensitive workstation."

### Would I personally grant this software unrestricted execution privileges?

**No — not on a machine holding real SSH keys, cloud credentials, git credentials, or proprietary source.** This is a firm no, driven by the default posture (Findings H1–H3) rather than by any discovered malicious behaviour. It is safe to run **inside an isolated VM or container whose environment holds no standing credentials you are unwilling to expose to every spawned agent**, ideally with the inbound Slack/webhook features left off.

### Risk rating

| Dimension | Rating |
|---|---|
| Presence of malicious/covert behaviour | **Low** (none found) |
| Code-level security engineering (crypto, SSRF, secret handling) | **Low–Medium** (strong, a few real gaps) |
| **Risk of granting *unrestricted* access to a sensitive workstation** | **High** |
| Composite trust rating for the audited question | **High** |

### Highest-impact findings first

1. **`autoMode` defaults to `true`** → every agent spawns with `--permission-mode bypassPermissions` (Claude) / `--dangerously-bypass-approvals-and-sandbox` (Codex) / `--yolo` (others). Unattended full shell/tool execution out of the box. `config.ts:334`. `[Confirmed]`
2. **Full environment inheritance** — each agent PTY is spawned with `{ ...process.env }`, so every agent (and any prompt-injection steering it) inherits `SSH_AUTH_SOCK`, `AWS_*`, `GITHUB_TOKEN`, etc. `pty.ts:275-285`. `[Confirmed]`
3. **Global weakening of Claude Code's own safety gates** — every claude spawn writes `skipDangerousModePermissionPrompt:true` + `skipAutoPermissionPrompt:true` into the user's **global** `~/.claude/settings.json` and auto-trusts each cwd in `~/.claude.json`, silently and persistently, affecting the user's Claude Code usage **outside this app too**. `config.ts:490-523`. `[Confirmed]`
4. **LLM output → arbitrary process spawn** — the GOD-authored spawn-request `command` field is an unvalidated arbitrary binary, and it flows into a `` which ${command} `` shell interpolation (a command-injection sink). GOD is prompt-injectable via Slack/webhook/inbox/web/memory. `index.ts:3106`, `pty.ts:183`. `[Confirmed]`
5. **No hard cost/runtime ceiling by default** — breaker `hardStop:false`, cost/token caps undefined, worker reaping is idle-*output*-based, `defaultWorkerTokenCap:0`. A runaway agent's spend and wall-clock are unbounded. `breaker.ts`, `config.ts:344`, `index.ts`. `[Confirmed]`
6. **Remote task-injection surface** — opt-in Slack/webhook servers are exposed to the internet via `tunnelmole`; an authenticated request drives autonomous GOD execution. Off by default, strongly gated, but by design it is authenticated remote command of a high-authority agent. `slack.ts`, `webhook.ts`, `index.ts:3555-3568`. `[Confirmed]`

---

## SECTION 2 — Repository Architecture

### Top-level layout

```
munder-difflin/
├── src/
│   ├── main/        Electron MAIN process — 34 modules, ~13.7k LOC (privileged: FS, PTY, net, git, DB)
│   ├── preload/     contextBridge IPC surface (index.ts) — the renderer↔main boundary
│   ├── renderer/    React + PixiJS "office" UI — ~23.9k LOC (all UI; not needed headless)
│   └── shared/      dependency-free modules imported by both main & renderer (hire, integrations, providers…)
├── resources/       bundled node helpers (kg.cjs, md-slack-reply.cjs) + read-only skills/ (markdown)
├── build/           electron-builder assets (icons, entitlements, notarize.cjs)
├── tools/           postinstall + build scripts (.cjs) + map generators
├── scripts/         two verification .mjs scripts
├── blog/, landing-remotion/, seo/, prototypes/   marketing/site sub-projects (separate package.json)
├── hive/            sample/seed hive assets
└── docs/            design docs (DESIGN.md, HIVE.md, SPEC.md, MEMORY_GRAPH_SPEC.md, this audit)
```

There is **one application** (the Electron app). "blog", "landing-remotion", "seo" are website sub-projects with their own lockfiles (100% npm-registry, per supply-chain review) and are not part of the runtime.

### Component map (traced to source)

| Concern | Where it lives | Electron-coupled? |
|---|---|---|
| **App lifecycle / windows / IPC glue** | `main/index.ts` (3592 LOC — the god-object) | Yes |
| **Process execution (PTY)** | `main/pty.ts` (`PtyManager`), `main/hiddenClaude.ts`, `main/shellEnv.ts` | Only `type WebContents` |
| **Orchestration core / message bus** | `main/hive.ts` (`HiveManager`, 2130 LOC) | **No** (pure Node + files) |
| **Circuit breaker (policy)** | `main/breaker.ts` (`CircuitBreaker`) | No |
| **Operator control (pause/gate/steer/halt)** | `main/control.ts` (`ControlRegistry`) | No |
| **Agent lifecycle hooks callback** | `main/hooks.ts` (`HookServer`, Unix domain socket) | `Notification` only |
| **Scheduler / missions / heartbeat** | `main/index.ts` (`syncMissions`, `armHeartbeat`) | Yes |
| **Ephemeral-worker system** | `main/index.ts` (`processSpawnRequest`, watcher) + `main/closingTime.ts` | Yes |
| **Git + worktree management** | `main/git.ts`, worktree GC in `index.ts` | No |
| **Filesystem (path-guarded)** | `main/fs.ts` (`safeJoin`, listDir/read/write) | No |
| **Durable store** | `main/db.ts` (better-sqlite3, WAL) | `app.getPath` only |
| **Semantic memory / reflection** | `main/memory.ts`, `main/reflect.ts` | No |
| **Knowledge graph** | `main/knowledge.ts`, `main/kg-core.cjs`, `resources/kg.cjs` | `app` for paths |
| **Telemetry (OTel collector)** | `main/telemetry.ts` (loopback OTLP/HTTP) | No |
| **Secret broker + integrations** | `main/integrationBroker.ts`, `main/integrations.ts`, `shared/integrations.ts` | `safeStorage` only |
| **Inbound Slack** | `main/slack.ts`, `main/slack-trigger.cjs` | No |
| **Inbound generic webhook** | `main/webhook.ts` | No |
| **Realtime voice (OpenAI)** | `main/realtime.ts`, `main/realtimeActions.ts`, `main/realtimeCompletionWatcher.ts`, `renderer/src/realtime/*` | Yes (renderer) |
| **Voice dictation (Groq)** | `main/freeflow.ts`, `main/groq.ts` | No |
| **Shareable hires (deep link)** | `main/hire.ts`, `shared/hire.ts` | No |
| **Renderer state** | `renderer/src/store/*` (Zustand + localStorage) | Renderer |
| **Office scene** | `renderer/src/scene/office/*` (PixiJS) | Renderer |

### Startup sequence (`app.whenReady()`, `index.ts:3514`) `[Confirmed]`

1. Force `realtimeVoiceEnabled=false` (mic-gate hygiene after a crash).
2. Handle a cold-start `munderdifflin://` deep link from argv.
3. `process.env.MD_SLACK_REPLY_CONFIG = <userData>/slack-reply.json` (a **path** only, no secret).
4. `persist.open()` — open/migrate SQLite (guarded; a DB failure degrades to defaults).
5. `bootstrapHiveServices()` (`index.ts:3395`): `ensureHive` → `archiveOrphanedAgents` → `hive.startRouter()` (1.5 s poll) → `startEphemeralWorkerWatcher()` (1.5 s poll) → `integrationBroker.start()` (loopback) → `ensureDefaultMissions` → `syncMissions` → `hookServer.start()` (UDS) → `telemetry.start()` (loopback OTLP) → `memory.start()` → `reflector.start()` → `armAlwaysOnBeats()` (fleet snapshot every 8 s, breaker/cost beat every 30 s).
6. `powerMonitor` resume/unlock/suspend listeners (sleep-survival + PTY health re-check).
7. `createWindow()`.
8. Auto-start Slack server **only if** `slackEnabled && slackSigningSecret`; auto-start webhook **only if** `webhookEnabled && webhookSecret`.

### Dependency direction & global state

- **Direction:** `shared/` (leaf, dependency-free) ← `main/*` modules ← `main/index.ts` (composition root). The renderer depends only on `preload`'s `cth` bridge + `shared/` types. The network/orchestration modules are deliberately **electron-free** so they import "sideways" into pure Node, not "up" into Electron. This is a clean, testable direction.
- **Global state** concentrates in `index.ts` module scope: `ptyManager`, `hive`, `control`, `telemetry`, `breaker`, `hookServer`, `memory`, `knowledge`, `persist`, and several `Map`s (`ptyToAgent`, `worktreePaths`, `liveWorkers`, `preservedWorktrees`, `missionTimers`). It is singleton-by-module, not injected — normal for an Electron main entry, but it is what makes `index.ts` a 3.6k-LOC god-object.

### Is the architecture clean / layered / auditable?

- **Clean & layered where it counts:** the coordination primitives (`hive`, `breaker`, `control`, `telemetry`, the three network servers, `hire`, `integrationBroker`) are small, single-responsibility, electron-free, and independently testable. The file-based bus (`registry.json`, `tasks.json`, `log.jsonl`, `agents/<id>/inbox|outbox`) is simple and inspectable.
- **Highly coupled at the top:** `index.ts` is a single 3592-line module that wires every IPC channel, the spawn core, the scheduler, and the worker system. It is the main maintainability/auditability liability.
- **Easy to reason about / audit:** yes, notably so. The code is densely and honestly commented (comments describe real constraints, PR history, and threat models), symbols are descriptive, and the data flow is traceable. **Not** intentionally difficult to understand — the opposite.

---

## SECTION 3 — Supply Chain Audit

**Result: no malicious or remote-code-fetching supply-chain behaviour found.** `[Confirmed]`

- **Registry hygiene:** 814/815 packages resolve to `registry.npmjs.org` with integrity hashes; the lone non-registry dep is `@electron/node-gyp` via `git+ssh://…/electron/node-gyp.git#<commit SHA>` — official Electron org, **commit-pinned** (secure). No `.npmrc`, so no registry override / dependency-confusion vector. All scoped names are reputable public scopes (`@codemirror`, `@xterm`, `@electron`, `@openai`, `@monaco-editor`). Sub-project lockfiles (blog, landing-remotion) are 100% registry. `package-lock.json`. `[Confirmed]`
- **Version pinning:** `package.json` uses caret ranges, but `package-lock.json` pins exact versions + integrity, and CI/build uses `npm ci` (`ci.yml:20`, `release.yml:48`). `[Confirmed]`
- **Install scripts:** the app's own postinstall (`electron-rebuild -f && node tools/ensure-pty-perms.cjs && node tools/patch-node-pty-conpty.cjs`) is vetted — `ensure-pty-perms.cjs` only chmods node-pty's `spawn-helper`; `patch-node-pty-conpty.cjs` text-patches a Windows ConPTY crash. **Neither touches the network.** `[Confirmed]` Native modules `node-pty` + `better-sqlite3` compile/download prebuilds at install (expected for a terminal harness).
- **`tunnelmole`** (`slack.ts:190`, `webhook.ts:152`, dynamic `import`): exposes a local port to the public internet and is marked `hasInstallScript:true` in the lockfile; its install-time script could not be inspected (node_modules absent in this checkout). Its runtime use is **opt-in and auth-gated**. Severity: Medium. `[Confirmed opt-in / Unresolved install script]`
- **`localtunnel`** (`package.json:48`): **declared but never imported** anywhere in `src/` — a dead dependency (superseded by tunnelmole per CHANGELOG). Recommend removal. `[Confirmed]`
- **No runtime code fetching / auto-update:** no `autoUpdater`/`electron-updater`/`setFeedURL` anywhere; the one `curl … | sh` string (`MemoryPanel.tsx:135`) is **display-only** setup text, never executed. `[Confirmed]`
- **CI/CD:** `ci.yml` uses plain `pull_request` (no `pull_request_target`, no fork-secret exposure); `release.yml` gates Apple signing secrets to macOS; `notarize.cjs` never logs credentials. `[Confirmed]`

Minor: lockfile root version `0.3.2` vs `package.json` `0.3.3` (cosmetic drift).

---

## SECTION 4 — Network Audit

**Determination: nothing leaves the machine except through disclosed, user-configured features using the user's own credentials. There is no analytics, telemetry-to-vendor, crash reporting, licensing, feature-flag, remote-config, or heartbeat-to-home traffic.** `[Confirmed]`

### Outbound

| Destination | Purpose | Protocol / Auth | Trigger | Optional? | Payload |
|---|---|---|---|---|---|
| `api.openai.com` (`/v1/realtime/client_secrets`) | Mint **ephemeral** realtime token | HTTPS, Bearer = user BYOK key (main-only) | Realtime voice start | Yes (off by default) | model id; **raw key never leaves main** (`realtime.ts`) |
| `api.openai.com` wss (renderer) | Realtime voice stream | WSS, ephemeral token | Live voice session | Yes | mic audio + non-secret hive summaries |
| `api.groq.com` | Voice-dictation transcription | HTTPS, Bearer = user Groq key | Free Flow dictation | Yes (needs key) | audio bytes (`freeflow.ts`/`groq.ts`) |
| `slack.com/api/chat.postMessage` | Post reply into a thread | HTTPS, Bearer = user bot token (main-only) | Agent/worker replies | Yes (Slack off by default) | channel, thread_ts, text |
| `github.com` via `gh` CLI | List issues / CI runs | subprocess `gh` (user's own auth) | Issues/CI panel | Yes | repo-scoped reads |
| arbitrary HTTPS (hire manifest) | Fetch a hire template | HTTPS, **SSRF-guarded** | User clicks a `munderdifflin://` link | Yes | GET; body-capped 64 KB |
| user-registered integration hosts | REST integration calls | via loopback broker; injected auth | Agent uses an integration | Yes | per-integration |
| tunnelmole service | Establish public tunnel | tunnelmole protocol | Slack/webhook enabled | Yes | forwards inbound to local port |

The realtime key-mint pattern is OpenAI's recommended flow (raw key stays server-side; only a short-lived token reaches the renderer). `[Confirmed]`

### Inbound (both opt-in, off by default)

| Listener | Bind | Public? | Auth |
|---|---|---|---|
| Slack Events (`slack.ts`) | `0.0.0.0:<port>` | Yes, via tunnel | HMAC-SHA256 over raw body + 5-min replay guard, constant-time |
| Generic webhook (`webhook.ts`) | `0.0.0.0:<port>` | Yes, via tunnel | shared secret via `timingSafeEqual`, body cap, rate limit |
| Slack reply loopback (`slack.ts:444`) | `127.0.0.1` | No | per-session token + loopback check |
| Telemetry OTLP (`telemetry.ts`) | `127.0.0.1` | No | none (loopback boundary); PII-allowlisted |
| Integration broker (`integrationBroker.ts:103`) | `127.0.0.1` | No | per-worker capability token |
| Hive proxy bridge (`hive.ts:2125`) | `127.0.0.1` | No | loopback |
| Hook server (`hooks.ts:95`) | **Unix domain socket** | No | **none** (see Finding M1) |

**Finding M4:** the two *public* servers bind all interfaces (`listen(port)` with no host arg — `webhook.ts:141`, `slack.ts:179`), not just loopback, so they are also reachable on the LAN even before the tunnel. The loopback services correctly pin `127.0.0.1`.

---

## SECTION 5 — Credential Handling

Two distinct stores exist — this split is the crux of the credential posture:

- **Encrypted broker** — `<userData>/integration-secrets.json`, mode `0600`, each value encrypted with Electron **`safeStorage`** (OS keychain / DPAPI), fail-closed with no plaintext fallback. Holds integration secrets (`int:<id>`), provider BYOK keys (`apikey:<backend>`), and the realtime OpenAI key (`apikey:openai`). `integrations.ts:84-136`. `[Confirmed]`
- **Plaintext config** — `<userData>/config.json`, `JSON.stringify(...,2)`, no encryption. Holds `slackBotToken`, `slackSigningSecret`, `webhookSecret`, `groqApiKey`. `config.ts:262-310, 408`. `[Confirmed]`

Both files live under `app.getPath('userData')` — **not** in a git repo, **not** the hive/harnessHome.

### Credential flow (origin → storage → transmission → child inheritance)

| Credential | Storage | Over IPC to renderer? | Child-process inheritance |
|---|---|---|---|
| Anthropic/OpenAI/Gemini/OpenRouter/Groq **BYOK** | encrypted broker | **No** (write-only; `:has` boolean only) | Injected as env into **non-Claude** engines at spawn only (`index.ts:2022-2066`) |
| OpenAI realtime | encrypted broker | **No** (only ephemeral token crosses) | No |
| Integration secrets (GitHub PAT, Stripe…) | encrypted broker | **No** | No — worker reaches them only through the loopback broker with a per-worker token; **never sees the value** (`integrationBroker.ts`) |
| Slack bot token / signing secret | **plaintext config** | **Yes** (via `config:get`) | No |
| Webhook secret | **plaintext config** | **Yes** | No |
| Groq (Free Flow) | **plaintext config** | **Yes** | No |
| `SSH_AUTH_SOCK`, `AWS_*`, `GITHUB_TOKEN`, git creds | not managed by app | — | **Yes — inherited by every agent** via `{...process.env}` (`pty.ts:275-285`) |

- **Capability tokens:** `grant(workerId, ids)` → `randomBytes(32).toString('base64url')`, in-memory only, never persisted, `revoke()` on teardown, matched with `timingSafeEqual`. `integrationBroker.ts:129-152`. `[Confirmed]`
- **No secret is logged** — no `console.*` prints a token, Authorization header, or env dump; `groq.ts` even has an egress `containsSecret` filter. `[Confirmed]`
- **`shellEnv.ts` captures only `$PATH`**, cached in memory, never written to disk. `[Confirmed]`

### Findings
- **H2** (High): full-env inheritance by bypass-mode agents (above).
- **H3** (High): global weakening of `~/.claude/settings.json` (Section 12 / Finding H3).
- **M2** (Medium–High): four secrets stored **plaintext** in config.json.
- **M3** (Medium–High): full config (incl. those four) returned **unredacted** to the renderer via `config:get` (`index.ts:2208`), which also renders untrusted agent/Slack content — a renderer compromise would read them (the encrypted-broker keys stay safe; CSP `connect-src` limits exfil paths).
- **L-sec** (Low): secrets an agent pastes into a hive message **subject/body** or `memory.md` are not redacted before local persistence (`log.jsonl`, backups) — local-only. Redaction runs only on the voice IPC path (`hive.ts:1275`).

---

## SECTION 6 — Process Execution

Every process launch was enumerated. `[Confirmed]`

| Site | Call | Shell? | Arg source |
|---|---|---|---|
| Agent PTY | `pty.spawn(file, args|cmdline, …)` `pty.ts:270` | No (array argv), except the install-script path | `command`/`args` from renderer or GOD spawn-request |
| Hidden Claude | `pty.spawn` `hiddenClaude.ts:130` | No | internal (model config) |
| Command resolution | `spawnSync($SHELL, ['-ilc', \`which ${command}\`])` `pty.ts:183`, also `shellEnv.ts`, `memory.ts` | **Yes (`-ilc`)** | `command` (string-interpolated) |
| Install banner | `$SHELL -lc <script>` / `cmd.exe /d /s /c "<script>"` `pty.ts:246-252` | **Yes** | `buildMissingCliScript(bin, provider)` (internal) |
| git | `spawn('git', [args], {cwd})` `git.ts:10`; `spawnSync('git', ['-c',…])` `hive.ts:1576` | No | literal argv |
| gh | `spawn('gh', [literal], {cwd})` `github.ts` | No | literal argv |
| Hook shim / proxy | `spawn(process.execPath, [fixed path])` `hive.ts:803` | No | fixed path |
| KG extract | `spawnSync('pdftotext', ['-q', srcPath, '-'])` `kg-core.cjs:212` | No | file path |

### Command-injection sink (Finding H4) `[Confirmed]`
`resolveCommand()` interpolates the caller's `command` into `` which ${command} `` and runs it under `$SHELL -ilc` (`pty.ts:183`). In the normal (renderer) path `command` is user-typed (self-inflicted, not an attacker). **But** the GOD-authored ephemeral-worker spawn-request sets `command` from LLM output with no validation (`index.ts:3106`), so a prompt-injected GOD can put shell metacharacters into `command` (`claude; curl …|sh`) and they execute. The hire-manifest path is *not* reachable here (it cannot carry a raw command — Section 8/hire). Net-new privilege is bounded (GOD can already spawn arbitrary binaries by design), but it is a genuine injection and a defense-in-depth gap: prefer `execFile`-style resolution + a `command` allowlist/validation mirroring `shared/hire.ts`.

The `shellScript` install path is shell-executed but its content comes from `buildMissingCliScript` (internal, provider-keyed), not from the model. `cmd.exe` routing on Windows is carefully quoted (`buildCmdCommandLine`, `pty.ts:60`) and neutralizes metacharacters. Timeouts: `resolveCommand`/PATH capture use 3 s; git 8 s; there is **no** overall spawn timeout on agents (by design — they are long-lived). Cleanup is thorough via `teardownPty` (archive + worktree gate + map cleanup) on both explicit kill and natural exit.

---

## SECTION 7 — Filesystem Safety

- **Path guard:** `safeJoin(root, rel)` resolves, computes the relative path, and rejects anything starting with `..` or absolute — a correct traversal guard, shared by `fs.ts` and `git.ts:getDiff`. `fs.ts:12-18`. `[Confirmed]`
- **Caveat:** the `fs:readFile`/`writeFile`/`listDir` IPCs take **both** `root` and `rel` from the renderer, so the guard only prevents `rel` escaping the *renderer-chosen* root — effectively the (trusted) renderer has broad FS read/write. Acceptable under the local-trust model + strict CSP, but the "sandboxed to cwd" framing is only true because the renderer *chooses* to pass cwd. `index.ts:2285-2299`.
- **Read caps:** 2 MB read cap + null-byte binary sniff (`fs.ts:52-71`); 2 MB diff cap (`git.ts:147`).
- **Destructive FS:** `removeWorkerScratch` is tightly guarded — it only ever deletes a path that resolves to exactly `HIVE_ROOT/agents/<workerId>` and never a live worker (`index.ts:354-364`). The worktree-isolation path slugifies the renderer-supplied id and asserts the resolved worktree stays under the worktrees root before creating it (`index.ts:1872-1876`). `transcript.ts` rejects non-UUID session ids before `path.join` (path-traversal guard). `[Confirmed]`
- **LLM influence on destructive FS:** the agents themselves (running with bypassed permissions) can read/write/delete anything the user can — that is *their own shell*, outside these IPCs. The main-process FS IPCs are bounded as above.

---

## SECTION 8 — Git Safety

- **All git runs are array-argv** `spawn('git', [...], {cwd})` with an 8 s timeout + SIGKILL — no shell, no injection. `git.ts:6-28`, `hive.ts:1576`. `[Confirmed]`
- **Read ops** (status/log/branches/aheadBehind/diff/isRepo) are non-mutating.
- **Mutating ops:** `addWorktree` (creates `agent/<slug>` branch), `removeWorktree` (`worktree remove --force`), and hive `commit` (`add -A` + `commit`). **No** `reset --hard`, `clean -fdx`, `checkout --force`, `push`, `rebase`, or `stash drop` in the main-process git surface.
- **Worktree teardown is safety-gated** for ephemeral workers: `worktreeHasUnintegratedWork` **fails safe** (any dirty tree, un-integrated commit, or failed query ⇒ keep), and reclaim requires `worktreeIsGcSafe` proving clean+integrated (handles squash-merge). GC is re-entrancy-guarded + throttled. `git.ts:250-310`, `index.ts:3194`. `[Confirmed]`
- **Finding L3:** a *normal* isolated agent (not an ephemeral worker) takes the unconditional `removeWorktree(..., '--force')` branch on tab close (`index.ts:270-279`), discarding uncommitted/untracked changes. Intentional, but a real data-loss surface not covered by the closing-time protocol.
- **Concurrency:** a single committer with 5× retry + stale-`index.lock` recovery, but the retry uses a **main-thread spin-lock** (Finding L1). `tasks.json` has **multiple uncoordinated writers** (harness `writeTasks` IPC + GOD editing the file with Write/Edit) with no lock ⇒ possible lost updates. `[Inferred]`

---

## SECTION 9 — Isolation

> **There is effectively no security isolation. Git worktrees are the only separation, and — per the audit's own instruction — they are not a security boundary.** `[Confirmed]`

- **No Docker / VM / container / namespace / seccomp / restricted-user** mechanism anywhere in the codebase.
- Agents run as the **same OS user** as the app, with the **full inherited environment** (Section 5), and — by default — with **permission prompts disabled** (Section 12).
- Worktrees isolate *working trees* (so agents don't clobber each other's files), not privileges, network, or process capability.
- The only real OS-level boundaries present are: the renderer's `contextIsolation`/CSP (bounds the UI), `safeStorage` (bounds secret-at-rest), macOS TCC folder prompts + hardened runtime + entitlements (bounds first-launch folder access), and loopback/UDS binds on the local servers. None of these constrains a *spawned agent*.

**Implication:** the isolation must be provided **by the host** (run the whole app in a disposable VM/container). The app provides none itself.

---

## SECTION 10 — Permissions

| Capability | Assumed? | Notes |
|---|---|---|
| Filesystem (full) | **Yes** | agents + renderer FS IPC; macOS declares Documents/Desktop/Downloads/Removable/Network usage strings |
| Shell / arbitrary process | **Yes** | core purpose; bypass mode by default |
| Network (outbound) | **Yes** | OpenAI/Groq/Slack/GitHub/integrations/tunnel |
| Network (inbound public) | Opt-in | Slack/webhook via tunnel |
| Clipboard | **Yes** | read + write IPC (xterm/editor copy-paste) |
| Browser (external) | Restricted | `openExternal` limited to `https:`/`x-apple.systempreferences:` (`index.ts:2753`) |
| Accessibility | No | not requested |
| Notifications | Yes | native toasts (gated on `notifications` setting) |
| Microphone | Opt-in | gated to live voice feature only (`setPermissionRequestHandler`, `index.ts:1566`) |
| SSH / git creds / keychain | **Inherited** | via `{...process.env}` + user's credential helpers |
| Login item | Opt-in | `setLoginItemSettings` behind a UI toggle |

**Least privilege is *not* followed for the spawned agents** (they inherit everything). It *is* followed for several narrower surfaces: mic (feature-gated), BYOK key injection (scoped to the model's provider prefix when identifiable — `index.ts:2029-2044`), openExternal (scheme-restricted), and the write-only secret broker.

---

## SECTION 11 — Secret Leakage

| Channel | Leaks secrets? | Evidence |
|---|---|---|
| Logs (`console.*`) | **No** | targeted grep: no token/header/env printed |
| Telemetry | **No** | loopback-only, PII-allowlist, raw records never persisted (`telemetry.ts:433`) |
| Crash dumps | **No** (none configured) | no crash-reporter |
| Database | **Partial** | `command_history` stores every user prompt **verbatim, unencrypted** (`db.ts:134`) — a pasted secret persists |
| Session persistence | **No** for stored creds | config/broker in userData, not repo |
| Temp files | **No** | Slack downloads sanitized + capped; no secret temp files |
| stdout/stderr | **No** | secrets used only in headers |
| Model prompts | **By user action** | a user/agent may put a secret into a prompt/message |
| Review/voice agents | **No** | voice `get_config` uses a secret-excluding allowlist; mint never exposes key |
| Memory / embeddings | **Partial** | agent `memory.md` is un-redacted, mined into searchable MemPalace, and copied into **forever-retained** `hive/backups/<stamp>/` (`reflect.ts:201-209`) |

Net: the app does not *exfiltrate* secrets, but three **local** persistence paths (SQLite prompt history, un-redacted `memory.md` + permanent backups, un-redacted message subjects in `log.jsonl`) will retain a secret if a human or agent puts one into that content. `[Confirmed]`

---

## SECTION 12 — Dangerous Code Paths

- **No `eval`, no `new Function`, no `Function()` in application code.** The only `new Function` reference is `import 'pixi.js/unsafe-eval'` (`OfficeFloor.tsx:4`), a PixiJS shim that makes Pixi **avoid** eval under the strict CSP — a compliance measure, not a weakening. `[Confirmed]`
- **Dynamic `import()`:** exactly one, `await import('tunnelmole')` — a **literal** string (ESM-in-CJS workaround). `[Confirmed]`
- **Dynamic `require`:** `kg.cjs:31 require(c)` iterates a **fixed candidate list** (env `KG_CORE` set by main), not attacker input. `[Confirmed]`
- **No unsafe YAML / pickle / deserialization / runtime compilation / template execution / plugin loading of remote code.** Hire manifests and MCP references are allowlist-validated, never executed as code.
- **`hiddenClaude.ts`** ("hidden" = UI-invisible, not covert): spawns an ephemeral read-only Claude for one-shot text transforms; hardcodes `bypassPermissions` but its sole caller (`reflect.ts:279`) restricts tools to read-only and feeds it on-disk memory with a verify-before-write gate. Low risk. `[Confirmed]`
- **Finding H3 (High):** `ensureClaudePermissionsAccepted` (`config.ts:490-523`, called every claude spawn) writes `skipDangerousModePermissionPrompt:true` + `skipAutoPermissionPrompt:true` to the user's **global** `~/.claude/settings.json` and `hasTrustDialogAccepted:true` per cwd in `~/.claude.json` — silently, persistently, machine-wide. This is the single most consequential "dangerous path": it degrades the user's Claude Code safety posture beyond this app's lifetime.

---

## SECTION 13 — Reliability

- **DB:** WAL + `synchronous=NORMAL` + `busy_timeout=5000` + FK on; each migration runs in a transaction; `open()` is guarded so corruption can't crash startup; single main-process writer. Scope is low-criticality (window bounds + prompt history). No explicit `integrity_check`/recovery. `db.ts`. `[Confirmed]`
- **Idempotency / duplicate dispatch:** spawn-requests are archived by atomic rename + guarded by `liveWorkers.has` (`index.ts:3101`); the router marks delivered mail `.sent`; Slack has a `seenEvents` dedup + `stop_hook_active` loop guard; hop-cap 12. Good. `[Confirmed]`
- **Crash recovery:** `archiveOrphanedAgents` on boot cleans stale `archived:false` entries; `killAll` suppresses per-PTY teardown storms on quit; `powerMonitor` re-arms schedulers and health-checks PTYs after sleep. `[Confirmed]`
- **Finding H5 (High):** **no hard cost/runtime ceiling by default** — `hardStop:false` (breaker caps at "constrained", never kills), `costCapUsd`/`costCapTokens`/`agentTokenCaps`/`maxTurns` undefined, `defaultWorkerTokenCap:0`, worker reap is idle-*output*-based (20 min). A worker that keeps printing but never signals `done` runs unbounded in wall-clock and spend; steer/constrain are just inbox messages the model may ignore. Only `stop`→`ptyManager.kill` truly halts, and it's gated behind default-off `hardStop`. `breaker.ts`, `index.ts`. `[Confirmed]`
- **Finding M6 (Medium):** **non-atomic state writes** — `writeJson` is truncate+write (`hive.ts:1565`); only inbox delivery uses `atomicWriteJson`. A crash mid-write of `registry.json` makes the live roster read as **empty** (`readJson` fallback `{godId:null,agents:{}}`), breaking broadcast and closing-time. `[Confirmed]`
- **Finding L1 (Low):** **main-thread blocking** — `commit()` runs `spawnSync git` + retries with `sleepSync` = `Atomics.wait` on a `SharedArrayBuffer` (`hive.ts:177-180, 1583-1595`), blocking the entire event loop under lock contention/slow disk. Routing commits every ~1.5 s. `resolveCommand` also `spawnSync`s an interactive login shell per spawn. `[Confirmed]`
- Resource exhaustion is otherwise bounded (body caps on all servers, 4 MB proxy cap, ring-buffer spans, serialized mine/reflect with in-flight guards + 120–180 s timeouts).

---

## SECTION 14 — Observability

- **Structured, append-only logs:** `hive/log.jsonl` (`{ts, kind, …}` for spawn/archive/session/route/drain/tasks/condense — logs message **subject**, not body) and `hive/cost-ledger.jsonl` (PII-free token/cost rows). `fleet.json` holds live per-agent tokens/usd/status/breaker/backlog (+cwd paths). `[Confirmed]`
- **Secrets in logs:** no secret reaches `console.*`; but `log.jsonl` message subjects, SQLite prompt history, and `memory.md`/backups are un-redacted local stores (Section 11).
- **Forensic adequacy:** the JSONL logs + git history of the hive give a solid routing/lifecycle trail. **Gaps:** hook payloads are anonymous over the UDS (no record of *which* process posted one), tool *arguments* are not persisted (ephemeral span ring only), and spawn-request provenance beyond the archived JSON is not logged. Adequate for operational debugging; thin for adversarial forensics.

---

## SECTION 15 — Code Quality

- **Type safety:** strict TypeScript across main/renderer/shared; IPC args are runtime-guarded (`typeof` checks) at handler boundaries. Good.
- **Error handling:** pervasive try/catch with best-effort degradation and honest comments about *why* each guard exists. Occasionally *too* swallowing (empty catches), but deliberate.
- **Tests:** a `test/` dir + two `scripts/verify-*.mjs` smoke checks; unit coverage appears light relative to the surface (the electron-free modules are written to be testable, but few tests are checked in). `[Inferred]`
- **Dead code / debt:** `localtunnel` unused; `index.ts` is a 3592-line god-object; `hive.ts` is 2130 lines; several `// TODO`/`// tracked, not yet hardened` notes (e.g. worktree reuse). Feature flags are config-driven and disclosed.
- **Maintainability:** high readability, strong comments, clean module boundaries below `index.ts`; the two mega-modules and the file-bus concurrency are the main debt.
- Overall engineering quality is **well above average** for an app of this ambition.

---

## SECTION 16 — Maliciousness Review

**Assumed untrusted; actively tried to falsify trust. Result: no evidence of malicious behaviour.** `[Confirmed]`

Explicitly searched for and **did not find**: hidden execution paths (every spawn/require sink traces to literal/fixed/model-mediated args), unexpected downloads or runtime code fetching (none; no auto-update), covert telemetry/exfiltration (telemetry is loopback-only + PII-allowlisted; renderer CSP blocks arbitrary egress), credential harvesting (zero references to `.ssh`/`id_rsa`/`.aws/credentials`; secrets encrypted or write-only), covert persistence (only a user-toggled login item; no launchd/cron/rc-file writes), obfuscation (no base64/hex-decode-then-exec; no packed source), misleading documentation (docs match source), or execution unrelated to the stated purpose (everything ties to the agent-harness function).

The behaviours that *look* alarming are all disclosed design: `bypassPermissions` by default, remote-triggerable autonomy, public tunnels, an LLM that can spawn processes and reach integration credentials via the broker. These are the product working as advertised — a legitimate high-authority-execution risk to weigh, **not** a Trojan.

---

## SECTION 17 — Orchestration Architecture

**The engine is architecturally sound.** Routing is deterministic; the file-based bus is simple and inspectable; the only non-determinism is the GOD model's decisions (which is the point).

### Task lifecycle (submission → completion), with call chain `[Confirmed]`

1. **Submission** — two surfaces feed one bus:
   - `HiveManager.send()` (`hive.ts:981`) → `normalize()` (`955`) → `routeMessage()` (`988`); or
   - an agent writes JSON into `agents/<id>/outbox/`, drained by `startRouter()` (1.5 s poll, `hive.ts:1122`) → `routeOnce()` (`1132`), which **forces `msg.from = owning dir`** (sender is authoritative, `1147`) then routes and renames to `outbox/.sent/`.
2. **Routing** — `routeMessage` (`988-1069`): hop-cap 12; `to:'human'` and `to:'god'` both resolve to `registry.godId` (GOD is the human's proxy; no separate approval queue); `broadcast` fans out to active non-archived inbox-capable agents; delivery = `deliver()` → `atomicWriteJson` into the recipient `inbox/`; undeliverable/hookless targets bounce to GOD or a renderer "terminal handoff". Every route appends `log.jsonl`, emits to the renderer, and notifies the closing-time observer.
3. **Planning / worker creation** — GOD (an LLM) drops `HIVE_ROOT/spawn-requests/<id>.json`; `ephemeralWorkerTick()` (1.5 s, re-entrancy-guarded) → `processSpawnRequest()` (`index.ts:3078`) → `spawnAgentCore()` (`1805`).
4. **Prompt construction / provisioning** — `hive.ensureAgent()` (`hive.ts:401`) creates the agent's inbox/outbox, writes `identity.md`/`memory.md`/`.gitignore`/`cursor.json`, upserts `registry.json`, injects env (`AGENT_ID/AGENT_NAME/HIVE_ROOT/AGENT_DIR` + OTel + MemPalace + KG + BYOK), and for Claude adds `--append-system-prompt <injected>` and `--settings <dir>/settings.json` wiring lifecycle hooks to the UDS + per-session MCP scoped to cwd.
5. **Worktree creation** — isolated agents get `harnessHome/worktrees/<slug>` on an `agent/<slug>` branch (`index.ts:1864`, `git.ts:222`).
6. **Agent launch** — `PtyManager.spawn()` (`pty.ts:203`) resolves the command against the user PATH and forks a PTY with the merged env.
7. **Verification / evaluation** — lifecycle hooks POST to `HookServer` (`hooks.ts`), which drives avatar state, the autonomous "keep working on Stop" loop (`decision:block`, guarded by `stop_hook_active`), the circuit breaker, and the cost ledger. Memory condensing (`reflect.ts`) uses backup → verify-don't-trust → atomic-swap.
8. **Result persistence** — worker signals completion by writing an `act:"done"` outbox message; `workerSignaledDone()` (stale-done guarded) → `ptyManager.kill` → `teardownPty` (safety-gated worktree preservation).
9. **Notification** — worker replies in its own Slack thread; failures/reaps `informGod()`; the Slack done-poller posts a fallback summary; `closingTime.ts` runs an ACK/COMPLETE shutdown handshake.

### Finding M1 (Medium) — the HookServer trust gap `[Confirmed]`
`hooks.ts:80-96` binds a plain Unix domain socket with **no authentication** and `handle()` trusts the caller-supplied `agent_id` (`116-117`). Any local process — or any agent/MCP forging *another* agent's id — can: force an inbox drain for any agent (advancing its `cursor.json` so unread messages are marked processed → **silent message loss**), overwrite another agent's resume `sessionId`, trip another agent's breaker via forged `PostToolUse`, or pollute the cost ledger via forged `CostSample`. Protection is filesystem perms only. On a shared/multi-user host this is an integrity risk; on a single-user isolated host it is minor.

---

## SECTION 18 — Electron Coupling

**Orchestration does *not* fundamentally depend on Electron.** Only **10 of ~34** main modules import `electron`, and several import only a *type* or `app.getPath`:

| Coupling | Modules | Nature |
|---|---|---|
| Deep (BrowserWindow/ipcMain/app/dialog/shell/clipboard/powerMonitor) | `index.ts` | the composition root + all IPC + lifecycle |
| `type WebContents` only | `pty.ts` | output routing target (trivially abstractable) |
| `Notification` | `hooks.ts` | native toast (optional) |
| `app.getPath` | `db.ts`, `config.ts`, `knowledge.ts` | userData/paths (inject a dir) |
| `safeStorage` | `integrations.ts` | secret encryption (swap for keytar/KMS) |
| Renderer/voice | `realtime.ts`, `realtimeActions.ts` | UI-oriented |

**Electron-free already:** `hive.ts` (the 2130-LOC core), `breaker.ts`, `control.ts`, `closingTime.ts`, `telemetry.ts`, `webhook.ts`, `slack.ts`, `hire.ts`, `integrationBroker.ts`, `git.ts`, `fs.ts`, `transcript.ts`, `reflect.ts`, `memory.ts`, `kg-core.cjs`. The renderer (~23.9k LOC of React/PixiJS/Monaco/xterm) is **pure UI** — nothing headless needs it.

**Effort to separate orchestration from UI:** moderate. The real work is decomposing `index.ts`: (a) replace `liveWebContents().send(...)` push-points with an `EventEmitter`/transport, (b) replace `app.getPath` with an injected config dir, (c) replace `Notification`/`dialog` with no-op/headless adapters, (d) keep `node-pty` (works headless). Estimate **~1–2 focused engineering weeks** to a runnable headless engine, plus the security hardening in Section 21.

---

## SECTION 19 — Parallel Candidate Execution

The architecture **could** support the one-task → N-independent-candidate pattern with modest change, because the isolation primitives already exist:

- **Independent worktree per candidate:** already implemented (`addWorktree`, one per agent id).
- **Independent memory:** each agent has its own `agents/<id>/` dir + `memory.md`.
- **Same commit / repo / task / setup:** the spawn-request already carries `cwd`, `command`, `model`, `objective`; three requests with the same objective and distinct ids would fan out.
- **Independent verification:** the hook/breaker/telemetry path is per-agent.

**What's missing for clean candidate execution:**
1. **No "candidate group" abstraction** — spawn-requests are independent; there's no notion of "N candidates for task T, evaluate, pick winner." You'd add a group id + an evaluator/selector step.
2. **Shared file-bus namespace** — all agents read/write one `registry.json`/`log.jsonl`; candidates aren't namespaced, so cross-candidate "no communication" isn't enforced (broadcast reaches everyone). You'd scope the bus per group.
3. **Non-atomic registry writes** (Finding M6) become more dangerous under high-concurrency fan-out.
4. **No aggregate cost ceiling** across a candidate group (Finding H5).

Feasible, but it needs a group/selector layer and bus namespacing before it's safe at N-way concurrency.

---

## SECTION 20 — Headless Operation

**Yes — the system could expose a CLI/SDK/daemon/HTTP/RPC without Electron**, and the smallest path already exists in embryo:

- The **generic webhook server** (`webhook.ts`) is already a headless-friendly HTTP task API (POST → work, GET → status) with auth, and it's electron-free.
- The **hive bus** + **spawn-request queue** are the de-facto RPC: dropping a JSON file spawns a worker. A daemon wrapping `HiveManager` + `processSpawnRequest` + `PtyManager` with an HTTP/RPC front is the minimal change.

**Smallest architectural change:** extract a `HarnessEngine` class from `index.ts` (owning `PtyManager`, `HiveManager`, breaker, telemetry, worker watcher, mission scheduler) with (a) an injected paths/config provider replacing `app.getPath`, (b) an `EventEmitter` replacing renderer `webContents.send`, and (c) a thin `node:http`/RPC adapter reusing the existing auth patterns. The renderer becomes one optional client of that engine.

---

## SECTION 21 — Recommended Refactoring

To make this a reusable, trustworthy headless orchestration platform:

**Security hardening (do first — gates adoption):**
1. **Flip `autoMode` to opt-in**, or add a hard, non-bypassable per-agent capability policy (tool allow/deny, path scoping) enforced in the hook `PreToolUse` path rather than relying on the CLI's own prompts.
2. **Stop mutating global `~/.claude/settings.json`;** scope permission pre-acceptance to a harness-local settings file passed via `--settings`, never the user's global config.
3. **Validate the spawn-request `command`** against an allowlist and use `execFile`-style resolution — eliminate the `` which ${command} `` shell interpolation (Finding H4).
4. **Authenticate the HookServer** (per-agent shared token in the shim + constant-time check) and stop trusting payload `agent_id` (bind id to the connection/token) — Finding M1.
5. **Make all hive state writes atomic** (route `registry.json`/`tasks.json`/`fleet.json`/`cursor.json` through `atomicWriteJson`) and add a lock/single-writer for `tasks.json` — Finding M6.
6. **Move the 4 plaintext config secrets into the encrypted broker** and **redact secrets in `config:get`** before it crosses IPC — Findings M2/M3.
7. **Add hard, default-on cost/runtime ceilings** (wall-clock + token cap per worker, aggregate per group) with a deterministic kill — Finding H5.
8. **Provide real isolation** as a first-class option: spawn agents inside a container/VM/restricted-user with a scrubbed environment (no SSH/cloud/git creds unless explicitly granted) — Section 9.

**Architecture/extraction:**
9. **Extract `HarnessEngine`** from `index.ts`; introduce an `AgentSpawner` interface (node-pty impl + future container impl) and a `Transport`/`EventBus` interface replacing renderer push-points.
10. **Introduce a `HiveStore` interface** over the file bus so the JSONL/atomic-write concerns live in one place (and can later back onto SQLite/Postgres).
11. **Decompose `index.ts`** (IPC handlers → per-domain modules; scheduler, worker watcher, and spawn core into the engine).
12. **Move main-thread-blocking git off the event loop** (worker thread or async git) — Finding L1.
13. **Remove `localtunnel`;** review `tunnelmole`'s install script; make public exposure require an explicit, separate confirmation.

**Boundaries to introduce:** `AgentSpawner`, `HiveStore`, `Transport`, `SecretStore`, `PolicyEngine` (the hook-time capability gate). These five interfaces convert the current Electron app into an embeddable engine + thin UI/daemon clients.

---

## SECTION 22 — Final Verdict

### Scores (0–10)

| Dimension | Score | Rationale |
|---|---:|---|
| **Trustworthiness** (absence of malice / truth-in-advertising) | **8** | No malicious behaviour found; docs match source; defensively built. Docked for the silent global-settings mutation and plaintext secrets. |
| **Engineering Quality** | **8** | Strong, well-documented, testable core. Docked for the two mega-modules, non-atomic writes, main-thread blocking. |
| **Security** (code-level hygiene) | **6.5** | Excellent crypto/SSRF/secret handling; real gaps: command-injection sink, unauth hook socket, plaintext config secrets, global-settings mutation. |
| **Architecture** | **7.5** | Clean electron-free core + simple bus; docked for the `index.ts` god-object and un-namespaced bus. |
| **Maintainability** | **7** | Very readable; two 2–3.6k-LOC modules and file-bus concurrency are the debt. |
| **Extensibility** | **8** | Provider presets, MCP catalog, hire manifests, mission scheduler all pluggable. |
| **Auditability** | **8** | Densely and honestly commented; traceable data flow; docked for size. |
| **Suitability for Long-Term Use** | **6.5** | Solid foundation; needs the security hardening + `index.ts` decomposition. |
| **Suitability as Headless Orchestrator** | **6.5** | Core is electron-free and the bus is headless-ready; needs engine extraction + Section 21 hardening. |

### Overall recommendation

Two questions, two answers:

- **"Grant this unrestricted execution on a workstation holding SSH/cloud/git credentials and proprietary source?"** → **Reject** for that specific use. Run it **only inside a disposable VM/container with no standing credentials**, Slack/webhook off.
- **"Adopt as the long-term foundation for a headless coding-agent orchestration platform?"** → **Adopt after significant refactoring** (equivalently: **Fork before adoption**). The orchestration engine is genuinely good and mostly Electron-free; adoption is gated on closing the Section 21 security items (foremost: opt-in permissions, no global-settings mutation, spawn-command validation, hook-socket auth, atomic state, real isolation) and extracting `HarnessEngine`.

**Composite: Adopt after significant refactoring / Fork before adoption — never on bare metal with real credentials.**

---

## Open Questions / Unresolved

1. **`tunnelmole` install script** — not inspectable in this checkout (node_modules absent). Review it under a real `npm install` before trusting the install step. `[Unresolved]`
2. **Actual test coverage** — `test/` exists but coverage of the electron-free core wasn't measured. `[Unresolved]`
3. **DNS-rebind residual** in `hire.ts` — acknowledged in-source (no connection pinning between DNS check and fetch). Low, but real. `[Confirmed as residual]`
4. **`tasks.json` multi-writer** — GOD edits it directly with Write/Edit while the harness also writes it; the exact interleaving risk depends on GOD's behaviour. `[Inferred]`
5. **Windows named-pipe hook path** — same auth gap as the UDS; not exercised on this Linux checkout. `[Inferred]`

---

## Appendix A — Important files inspected

**Main process (privileged):** `src/main/index.ts` (spawn core, IPC, lifecycle, worker watcher, scheduler), `pty.ts`, `hiddenClaude.ts`, `shellEnv.ts`, `hive.ts`, `hooks.ts`, `breaker.ts`, `control.ts`, `git.ts`, `fs.ts`, `db.ts`, `config.ts`, `telemetry.ts`, `integrations.ts`, `integrationBroker.ts`, `slack.ts`, `slack-trigger.cjs`, `webhook.ts`, `hire.ts`, `freeflow.ts`, `groq.ts`, `realtime.ts`, `realtimeActions.ts`, `realtimeCompletionWatcher.ts`, `memory.ts`, `reflect.ts`, `knowledge.ts`, `kg-core.cjs`, `transcript.ts`, `usage.ts`, `pricing.ts`, `closingTime.ts`.
**Preload / shared:** `src/preload/index.ts`, `src/shared/hire.ts`, `src/shared/integrations.ts`, `src/shared/agentProvider.ts`, `src/shared/claudeCommands.ts`, `src/shared/codexCommands.ts`, `src/shared/mcpCatalog.ts`.
**Renderer (sampled):** `src/renderer/index.html` (CSP), `src/renderer/src/realtime/*`, `components/SettingsModal.tsx`, `components/MemoryPanel.tsx`, `scene/office/OfficeFloor.tsx`, `store/*`.
**Build / packaging / CI:** `package.json`, `package-lock.json`, `electron-builder.yml`, `electron.vite.config.ts`, `build/notarize.cjs`, `build/entitlements.mac.plist`, `.github/workflows/{ci,release,blog}.yml`, `tools/{ensure-pty-perms,patch-node-pty-conpty,copy-main-assets,agent-env}.cjs`, `resources/{kg.cjs,md-slack-reply.cjs,skills/*}`.

## Appendix B — Commands executed (representative)

- `git log --oneline`, `git branch -a` — repo state.
- `find src/main src/renderer …` / `wc -l` — module inventory + sizes.
- `grep` for: `webPreferences|nodeIntegration|contextIsolation|sandbox`; `ipcMain.handle`; `setWindowOpenHandler|openExternal|setPermissionRequestHandler`; `bypassPermissions|--yolo|autoMode`; `spawn|exec|eval|Function|require(`; `OTEL_EXPORTER_OTLP_ENDPOINT|127.0.0.1|listen(`; `autoUpdater|electron-updater`; `from 'electron'`; `Content-Security-Policy|localtunnel`.
- Targeted `Read` of every file in Appendix A (full or specific line ranges).
- Four parallel sub-audits (supply-chain, credentials, orchestration/reliability, dangerous-paths/renderer), each source-tracing its domain and cross-checked against primary reads above.

*End of report.*
