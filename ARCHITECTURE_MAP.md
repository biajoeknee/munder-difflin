# ARCHITECTURE_MAP — Munder Difflin

Reference document produced by the engine-extraction investigation
(2026-07-25). Inventory, dependency graph, execution flow, ownership
boundaries. **No recommendations here** — see `INVESTIGATION.md` for findings
and the final report for conclusions.

Line references are against commit `7f5d09d`.

---

## 1. System overview

Munder Difflin is an Electron app that runs a fleet of **real agent CLI
processes** (`claude`, and bridged: `codex`, `agy`, `qwen`, `crush`, `pi`,
`opencode`) as PTY children of the Electron **main process**, coordinates them
through an **on-disk, git-committed "hive"** (`<harnessHome>/hive/`), and
visualizes them in a **renderer** (React + Pixi office floor with terminal
tabs).

There are four planes:

| Plane | Transport | Owner |
| --- | --- | --- |
| Byte plane (terminal I/O) | node-pty streams | main (`PtyManager`), rendered by xterm in the renderer |
| Control plane (agent lifecycle semantics) | Claude Code hooks → generated `cth-hook.cjs` shim → Unix socket / named pipe → `HookServer` | main |
| Coordination plane (agent↔agent messaging, tasks, memory) | plain files under `hive/` + single-committer git | main (`HiveManager` router); agents read/write their own dirs |
| Presentation plane (avatars, kanban, gauges, terminals) | IPC (`preload` bridge, 107 `ipcMain` handlers + ~15 push channels) | renderer |

Key structural fact: agents never call git and never talk to each other
directly — coordination is stigmergic (files), routed and committed solely by
the main process (`HIVE.md` locked decisions 1–2; `hive.ts:1575-1595` inlines
git identity `-c user.name=Hive`).

## 2. Layer inventory

| Layer | Files | LOC | Role |
| --- | --- | --- | --- |
| `src/main/` | 36 | 13,193 | orchestration engine + Electron composition root (`index.ts`, 3,592 LOC) |
| `src/shared/` | 8 | 1,734 | pure logic shared main↔renderer (provider presets, command catalogs) — zero Electron |
| `src/preload/` | 1 | 1,076 | `contextBridge` — pure forwarding shim; the de-facto engine API surface (112 invoke + 22 push channels) |
| `src/renderer/src/` | ~100 | 23,870 | React/Pixi UI **plus several renderer-resident control loops** (see §6.4) |

## 3. Module inventory — `src/main`

Column "Electron surface" lists every direct `electron` import of the module.
Classification per the investigation taxonomy (ui-only / lifecycle / ipc /
filesystem-path / notifications / removable-with-interface / fundamental).

### 3.1 Engine core (in the minimal spawn→monitor→cleanup closure)

Mechanically derived: these are the exact `src/` files that esbuild bundles
for the working headless slice in `headless/` (12 files, 4,944 LOC).

| Module | LOC | Responsibility | Internal deps | Electron surface |
| --- | --- | --- | --- | --- |
| `pty.ts` | 390 | `PtyManager`: spawn/kill/write/resize PTYs (node-pty), CLI path resolution (`which` via interactive shell + candidate dirs), Windows cmd.exe quoting, per-session `lastOutputAt` activity clock, natural-exit handler | — | `WebContents` **type-only** (erased); output sink is `{send, isDestroyed}`, null-tolerant (`safeSend`, :118-124) — *removable-with-interface (already null-safe)* |
| `git.ts` | 311 | worktree add/remove (`agent/<slug>` branches), branch/status/log/diff queries, safety gates `worktreeHasUnintegratedWork` (:250) and `worktreeIsGcSafe` (:291) — both fail toward "keep" | `fs.ts` | **none** |
| `hive.ts` | 2,130 | `HiveManager`: on-disk hive (registry, board, tasks, log.jsonl, per-agent identity/memory/inbox/outbox), FIPA-lite message normalize+route+commit, `ensureAgent` spawn injection (identity refresh, `--append-system-prompt` protocol, `--settings` hook file, `AGENT_*`/`HIVE_SOCK` env, OTel env, non-Claude hook bridges/proxy sidecars), single-committer git with retry + stale-lock recovery, cost ledger, `drainForStop` | `shared/agentProvider`, `shared/claudeCommands`, `shared/mcpCatalog`, `usage` (type) | **none** — constructor takes `(getHome, emit?)`, both injected (:268-271) |
| `hooks.ts` | 296 | `HookServer`: UDS/named-pipe server for the hook shim; implements Stop→inbox-drain autonomy loop, operator halt/deny/steer gates, session-id capture, transcript-path discovery, context-window telemetry, cost samples | `hive`, `pricing`, `config`/`control`/`breaker` (types) | `Notification` (:274, config-gated, try/caught — *notifications*); renderer via injected `getWebContents()` callback, `?.send` everywhere — *removable-with-interface* |
| `transcript.ts` | 229 | locate Claude Code project dirs / seed session `.jsonl` for `--resume`, offline usage summing, tail-read context tokens | `pricing` | **none** |
| `config.ts` | ~560 | `HarnessConfig` read/write/defaults, model tiering (`modelForRole`), mission presets, `ensureClaudePermissionsAccepted` (pre-accepts Claude first-run gates in `~/.claude`) | `shared/agentProvider`, `shared/mcpCatalog`, `shared/integrations` (type) | `app.getPath('userData')` (:381) — *filesystem-path* |
| `pricing.ts` | ~90 | static $/Mtok table + `estimateCostUsd` | — | **none** |
| `fs.ts` | ~90 | `safeJoin` path-escape guard, misc fs helpers | — | **none** |

Plus, from `src/shared` (all zero-Electron, pure data/logic):
`agentProvider.ts` (521 LOC — provider presets: binary names, install
commands, auto-mode/resume flags, hook-bridge descriptors, hive-awareness),
`claudeCommands.ts`, `codexCommands.ts`, `mcpCatalog.ts`.

### 3.2 Engine support (used by the app's orchestration; substitutable or optional)

| Module | LOC | Responsibility | Electron surface |
| --- | --- | --- | --- |
| `closingTime.ts` | ~300 | graceful shutdown protocol over hive mail (broadcast → per-worker ACK → COMPLETE → teardown); "never types into terminals" (header) | `WebContents` type-only; emits via injected callback |
| `realtimeCompletionWatcher.ts` | ~470 | dispatch-completion detection from `tasks.json` card flips + inbox done-replies; by internal decision "electron-free + reader-injected" (header :9-16) | **none** |
| `breaker.ts` | ~300 | `CircuitBreaker` policy: repeated-tool / error-storm / token-velocity / cost-cap trips → steer / constrain / stop ladder | **none** |
| `control.ts` | ~110 | `ControlRegistry`: operator pause/halt/tool-gate/steer state | **none** |
| `shellEnv.ts` | ~80 | login-shell env capture | **none** |
| `hiddenClaude.ts` | ~200 | one-shot hidden `claude -p` runs (title generation etc.) via child_process | **none** |
| `usage.ts` | 102 | `UsageProvider` interface + aggregation | **none** |
| `telemetry.ts` | ~550 | loopback OTLP collector for Claude Code OTel (live cost/usage source) | **none** |
| `db.ts` | ~220 | better-sqlite3 store (`harness.db`): task history, command history | `app.getPath('userData')` (:81) — *filesystem-path* |
| `memory.ts` | ~290 | MemPalace CLI wrapper (semantic memory), detect-and-degrade | **none** |
| `knowledge.ts` | ~130 | knowledge-graph CLI wrapper around `kg-core.cjs` | `app.getPath` (:62) + `app.isPackaged`/`app.getAppPath`/`process.resourcesPath` resource lookup (:66-77) — *filesystem-path* |
| `reflect.ts` | ~500 | memory reflection/summarization loops | **none** |

### 3.3 Peripheral (feature edges; nothing in 3.1 imports them)

| Module | LOC | Responsibility | Electron surface |
| --- | --- | --- | --- |
| `slack.ts` + `slack-trigger.cjs` | ~800 | Slack socket-mode ingress + reply helper sidecar | none |
| `webhook.ts` | 260 | HTTP ingress → spawn-request files | none |
| `integrationBroker.ts` | ~340 | loopback secret broker (capability tokens for workers) | none |
| `integrations.ts` | ~200 | integration registry + secret storage | `app`, `safeStorage` — *removable-with-interface* (secret store) |
| `github.ts` | ~120 | PR/issue helpers | none |
| `groq.ts` | ~180 | Groq API (voice transcription) | none |
| `realtime.ts`, `realtimeActions.ts`, `realtimeCost.ts` | ~1,300 | voice-Michael: OpenAI realtime session + voice tool-actions (read-layer + dispatch) | `ipcMain` in both — *ipc* |
| `freeflow.ts` | ~170 | "freeflow" doc sync | none |
| `hire.ts` | ~380 | `munder://` hire-link manifests | none |
| `kg-core.cjs` | ~470 | pure-JS knowledge-graph store | none |

### 3.4 Composition root — `index.ts` (3,592 LOC)

Not a module: the place where everything above is constructed, wired, and
exposed over IPC. Section map:

| Lines | Contents |
| --- | --- |
| 1–226 | imports; **singleton construction at import time**: `PtyManager` (:67), `HiveManager` (:77, emit → `liveWebContents()?.send`), `ControlRegistry`, `TelemetryCollector`, `CircuitBreaker`, `HookServer` (:118), `MemoryManager`, `KnowledgeManager`, `MemoryReflector`, `PersistStore`, `IntegrationBroker`; worktree/agent maps (:168-228) |
| 244–430 | shared lifecycle: `teardownPty` (:244 — archive, broker revoke, worktree finalize), `informGod` (:291), `finalizeWorkerWorktree` (:306 — preserve-vs-remove gate), `syncKeepAwake` (:405, powerSaveBlocker) |
| 435–847 | missions/scheduler (`syncMissions`, `armHeartbeat` adaptive beat), floor-quiet/stuck heuristics, `godActionableInboxCount`, `reengageGod` (:706 — inbox only, delivery delegated to renderer nudge), `runBreakerBeat` (:723), `writeFleetSnapshot` (:775) |
| 849–878 | `liveWebContents()` (:849) — nullable renderer handle |
| 880–1363 | Slack ingress plumbing + done-observer; webhook server; autonomous-request protocol builder |
| 1364–1456 | window bounds persistence, hire-link handling |
| 1458–1705 | single-instance lock (:1458), `createWindow` (:1505, `backgroundThrottling:false` :1533), `openFloor`, app menu |
| 1707–1804 | missing-CLI installer script builder |
| **1805–2076** | **`spawnAgentCore`** — the single spawn choke point (see §6.1) |
| 2077–2480 | ~107 `ipcMain.handle` registrations (pty/git/hive/config/db/slack/webhook/voice/…) |
| 2482–2900 | `teardownAndQuit`, `ClosingTimeController` wiring, quit dialog |
| 2903–3009 | `initCompletionWatcher` wiring (voice completion) |
| 3010–3393 | **ephemeral-worker subsystem** (see §6.2): spawn-request poller, done-scan, idle reap, token cap, preserved-worktree GC |
| 3395–3592 | `bootstrapHiveServices` (:3395 — hive bootstrap, hook server start, telemetry, missions, watchers; zero Electron calls), `armAlwaysOnBeats`, PTY health checks, `powerMonitor` resume hooks, `app.whenReady` boot, `window-all-closed` (darwin-exempt :3587) |

## 4. Dependency graph (engine-relevant edges)

```
                    ┌────────────────────────────────────────────────┐
                    │            index.ts (composition root)         │
                    │  constructs singletons, registers 107 IPC      │
                    │  handlers, owns spawnAgentCore + worker loop   │
                    └──┬──────┬──────┬──────┬──────┬──────┬─────────┘
                       │      │      │      │      │      │
              ┌────────▼─┐ ┌──▼───┐ ┌▼─────┐ ┌────▼───┐ ┌▼────────┐
              │ pty.ts   │ │git.ts│ │hive  │ │hooks.ts│ │config.ts│
              │(node-pty)│ │      │ │ .ts  │◄┤(UDS srv)│ │(app.get │
              └────────┬─┘ └──┬───┘ └┬───┬─┘ └────┬───┘ │  Path)  │
                       │      │      │   │        │     └─────────┘
                       │   ┌──▼──┐   │   │   ┌────▼──────┐
                       │   │fs.ts│   │   │   │pricing.ts │
                       │   └─────┘   │   │   └───────────┘
                       │             │   └── shared/agentProvider.ts
                       │             │       shared/claudeCommands.ts
                       │             │       shared/mcpCatalog.ts
                       ▼             ▼
                node-pty (native)  filesystem + git  (hive/, worktrees/)

  transcript.ts ← index.ts, hooks.ts (transcript_path), spawn resume seeding
  support tier (closingTime, completionWatcher, breaker, control, telemetry,
  usage, db, memory, knowledge, reflect) ← constructed/injected by index.ts only
  peripherals (slack, webhook, broker, realtime*, github, groq, hire, freeflow)
    ← index.ts only; NOTHING in the core imports them
```

Reverse-dependency property (verified by import grep): no module in §3.1
imports anything from §3.2 or §3.3 except type-only references
(`hooks.ts` → `control`/`breaker` types as optional constructor params;
`hive.ts` → `usage` type).

## 5. Electron coupling — full direct-import census

Every `from 'electron'` in `src/main` + `src/shared` (grep-verified):

| File | Imports | Classification |
| --- | --- | --- |
| `index.ts` | `app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, screen, shell, Notification` | composition root: lifecycle + ipc + ui-only + notifications |
| `config.ts` | `app` (getPath) | filesystem-path |
| `db.ts` | `app` (getPath) | filesystem-path |
| `knowledge.ts` | `app` (getPath) | filesystem-path |
| `integrations.ts` | `app`, `safeStorage` | filesystem-path + removable-with-interface (secret encryption) |
| `realtime.ts`, `realtimeActions.ts` | `ipcMain` | ipc (peripheral voice) |
| `hooks.ts` | `Notification` + `WebContents` (type) | notifications + removable-with-interface |
| `pty.ts`, `closingTime.ts` | `WebContents` (type-only) | erased at compile time |
| `src/shared/*` | — | **zero** |

## 6. Execution flows

### 6.1 Spawn (all paths converge on `spawnAgentCore`, index.ts:1805)

```
renderer "Add Agent" ──IPC pty:spawn──┐
god drops <id>.json in                ├─► spawnAgentCore(opts, owner|null)
  hive/spawn-requests/ ──poller──────┘        │
                                              ▼
  1. provider inference                (shared/agentProvider)
  2. missing-CLI? → installer PTY + relaunch arm  (pty.isCommandAvailable)
  3. isolate? → addWorktree(<harnessHome>/worktrees/<slug>, agent/<slug>)  (git.ts:222)
  4. hive.ensureAgent → identity.md refresh, memory.md, inbox/outbox,
     registry upsert, log+commit; returns injection:
       args: --append-system-prompt <protocol>, --settings <agent>/settings.json
       env:  AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR, HIVE_SOCK [, OTEL_*]
  5. model tiering / --max-turns / --resume (+ transcript seeding, transcript.ts:36)
  6. ensureClaudePermissionsAccepted (config.ts:490)
  7. BYOK env (non-Claude only; integrations.getSecret → safeStorage)
  8. ptyManager.spawn(opts, owner)   [owner nullable; null ⇒ output dropped]
  9. syncKeepAwake (powerSaveBlocker)
```

### 6.2 Ephemeral worker loop (file-driven; index.ts:3010-3393)

```
spawn-requests/<id>.json {objective, cwd [,command,provider,model,slack,isolate,tokenCap]}
  → 1.5s poller validates (fail-fast → .failed/ + informGod)
  → spawnAgentCore(…, liveWebContents())          [owner may be null]
  → broker grant (MD_BROKER_URL/TOKEN) if broker up
  → hive.send(objective, from:'god') into worker inbox   [zero new transport]
  → request archived to .done/
per tick: outbox scan for act:'done' after spawnedAt  → kill PTY → teardown
backstops: idle reap (pty.idleFor > ~20 min), optional token cap
teardown → finalizeWorkerWorktree: worktreeHasUnintegratedWork?
  keep → preservedWorktrees registry (+ inform god with branch name)
  else → removeWorktree;  GC sweep (60s): worktreeIsGcSafe? → reclaim
```

### 6.3 Control plane (hooks)

```
claude (per-agent --settings) ─every lifecycle hook─► cth-hook.cjs shim
  ─one-line JSON over HIVE_SOCK─► HookServer.handle (hooks.ts:116)
     Status        → context gauge (retain + forward)
     PreToolUse    → operator gate (deny) / steer injection
     PostToolUse   → breaker loop-signal, steer injection
     Stop/Subagent → control.shouldHalt? → {continue:false}
                     hive.drainForStop:  unread inbox ⇒ {decision:'block'}
                     (keeps agent working — THE autonomy loop)
                     else genuine stop ⇒ idle (+ optional toast)
     every payload → transcript_path capture, session-id capture (registry)
```

### 6.4 Autonomy delivery — the renderer-resident links

Main **never types into a PTY**: the sole `ptyManager.write` call site is the
`pty:write` IPC handler (index.ts:2079). The typing plane lives in the
renderer (`useHive.ts`):

| Loop | Where | What it decides |
| --- | --- | --- |
| God existence | `useHive.ts:213-301` | checks live PTYs, **decides to spawn `pty-god`**, types `/remote-control` + orientation prompt into the TUI on timers |
| Idle inbox-wake nudge | `useHive.ts:502-533` (4 s interval) | polls each idle agent's inbox over IPC; new mail ⇒ **types a wake prompt into the agent's PTY** (`submitToPty` → `pty:write`). This is the delivery hop `reengageGod` (index.ts:701-705) explicitly relies on, and what starts a fresh interactive worker's first turn. |
| Turn-completion inference ×2 | `useHive.ts:475-498`; `usePtyParser.ts:57-71` | 12 s PTY-quiescence flips 'working'→'idle'; usePtyParser adds a 4 s idle drift **plus approval-prompt regex detection with generated y/n keystrokes** (:149-178) |
| Message delivery scheduling | `useHive.ts:564-656` | idle-gating, 4.5 s cooldowns, boot-grace windows, per-pty write serialization (`writeChains` map, :62-96) |
| Crash recovery | `useHive.ts:778-849`; `AgentStrip.tsx:48-129` | auto-revive after sleep (kill → respawn with `--resume`, worktree re-entry decision, debounce/retry); `restoreTeam` |
| Auto-compact targeting | `useHive.ts:754-768` | provider filter + dedup of which terminals receive `/compact` |
| Dispatch-through-god routing | `CommandCenterPanel.tsx:293-314` | renderer policy for routing user dispatches via god |
| Slack ingress dispatch | main → `slack:incomingMessage` → renderer | renderer creates the task card and injects the autonomy-protocol prompt into god's PTY; dropped if no window |
| Registry poll | `useHive.ts` (:417, 15 s) | mirrors hive registry into the UI store (feeds the loops above) |

`createWindow` sets `backgroundThrottling: false` (index.ts:1529-1533)
precisely because these renderer timers are load-bearing for the hive. The
renderer itself imports no Electron — everything rides the typed `window.cth`
IPC bridge — and the codebase states the opposite ideal where it chose to:
the voice action path keeps all policy in main ("the renderer is the
untrusted side, so it holds NO policy", renderer realtime/actions.ts:10-11).

### 6.5 Completion detection (four mechanisms + backstop)

1. **PTY exit** — `PtyManager.onExit` → `exitHandler` → `teardownPty` (natural death or `-p` runs).
2. **Stop hook + empty inbox** — turn-level idle (HookServer).
3. **Outbox `act:'done'`** — task-level, ephemeral workers (index.ts:3048).
4. **Task-card flip / done-reply** — dispatch-level (`realtimeCompletionWatcher.detectCompletion`).
Backstop: idle reap via `pty.idleFor`.

### 6.6 Shutdown

`teardownAndQuit` (index.ts:2482): stop watchers/servers → `pty.killAll`
(suppresses per-agent teardown storm) → hive final commit → `app.quit`.
Optional graceful path first: `ClosingTimeController` rides hive mail
(broadcast → ACKs → COMPLETE) with a 6-minute timeout.

## 7. Ownership boundaries

| State | Owner | Medium |
| --- | --- | --- |
| Agent processes + byte streams | main (`PtyManager` sessions map) | memory |
| Agent roster, messages, tasks, board, event log, cost ledger | main (`HiveManager`, single committer) | `hive/` files + git |
| Worktree bookkeeping (`worktreePaths`, `worktreeOrigins`, `liveWorkers`, `preservedWorktrees`) | main (`index.ts` module maps) | memory (+ fleet.json snapshot) |
| Session ids / transcript paths | main (registry + `HookServer` maps) | `registry.json` / memory |
| Config | main (`config.ts`) | `userData/config.json` |
| Task/command history | main (`db.ts`) | `userData/harness.db` (sqlite) |
| Agent status as displayed + idle inference + wake dedup | **renderer** (`useStore`, `useHive` refs) | renderer memory (rebuilt from polls) |
| **Spawn recipes (model, command, goal, worktreePath), per-agent message queues, restore recipes** | **renderer** (`store.ts:231-390`) | **`localStorage` — durable state main does not hold**; lost with the renderer profile |
| Terminal scrollback | renderer (xterm) | renderer memory |
| Secrets | main (`integrations.ts`) | `safeStorage`-encrypted at rest |
| Agent working state (WIP, memory.md) | the agent CLI processes themselves | worktrees + `hive/agents/<id>/` |

## 8. IPC surface (the de-facto engine API)

The preload (`src/preload/index.ts`, 1,076 LOC) is a pure forwarding shim —
every binding is a one-line `ipcRenderer` forward, zero business logic; its
only module-level side effect is `contextBridge.exposeInMainWorld` (:1074).
Surface: **112 unique invoke channels + 22 push-channel registrations**
(19 static, 3 dynamic per-pty: `pty:data:<id>`, `pty:exit:<id>`, plus
`hive:hookEvent`, `hive:contextUpdate`, `hive:changed`,
`control:breakerState`, `control:approvalRequest`, `missions:updated`,
`slack:incomingMessage`, `closingtime:*`, `realtime:*`, …). Handlers live in
`index.ts` (107 `ipcMain` registrations) + `realtime*.ts` (5).

The minimal orchestration path maps onto ~14 of the 134 channels:
`pty:spawn` (its `isolate` flag triggers worktree creation and returns
`worktreePath`), `pty:write`, `pty:resize`, `pty:kill`, `pty:list`,
`pty:data:<id>`, `pty:exit:<id>`, `hive:hookEvent`, `hive:inbox`, `hive:send`,
`hive:registry`, `hive:agentUsage`, `session:resolveCwd`, `hive:setArchived`.
The remaining ~120 are UI convenience, OS integration, telemetry display,
voice, ingress, and settings.

## 9. On-disk layout

```
<harnessHome>/
  hive/                     git repo, main-process-committed only
    PROTOCOL.md  registry.json  board.md  tasks.json  log.jsonl  fleet.json
    hooks.sock              HookServer UDS (win32: \\.\pipe\munder-difflin-<hash>)
    bin/cth-hook.cjs        hook shim (rewritten each bootstrap from embedded string)
    bin/hive-proxy.cjs      proxy-bridge sidecar for hookless CLIs
    spawn-requests/         worker queue (+ .done/ .failed/)
    agents/<id>/            identity.md memory.md settings.json inbox/ outbox/ cursor.json
  worktrees/<agent-slug>/   git worktrees on agent/<slug> branches
<userData>/                 (Electron app.getPath('userData'))
  config.json  harness.db
~/.claude/projects/<cwd-slug>/<sessionId>.jsonl    agent transcripts (Claude-owned)
```
