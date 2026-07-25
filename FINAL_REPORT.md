# FINAL REPORT — Munder as the execution engine for an orchestration platform

Engine-extraction investigation, 2026-07-25, against commit `7f5d09d`.
Evidence base: `INVESTIGATION.md` (findings F1–F11), `ARCHITECTURE_MAP.md`
(reference), `headless/` (executed proof). Charter question:

> Is Munder fundamentally an orchestration engine with an Electron application
> wrapped around it, or an Electron application whose orchestration
> capabilities are inseparable from the UI?

**Verdict: an orchestration engine with an Electron application wrapped around
it** — demonstrated by execution, not inference: the unmodified engine modules
ran the full spawn→isolate→stream→hook→complete→collect→cleanup path under
plain Node with a 30-line Electron stub (F9). One qualification keeps this
from being unconditional: the autonomy loop's *policy layer* — when to wake an
idle agent and type into its terminal, when god gets spawned, when a silent
turn counts as finished, when to revive a dead agent — is implemented in the
renderer today, along with a small amount of durable state (spawn recipes,
message queues) in `localStorage` (F6). The app's closed-loop autonomy
therefore does not yet survive losing its window. That layer is policy over
main-side primitives, not mechanism, and it is the single piece of real
orchestration living outside the engine.

---

## 1. Can Munder become the execution engine?

**Yes.** The mechanism layer is already an engine in everything but packaging:

- Electron-free at runtime across the whole minimal path (F1), with
  dependencies pointed inward by constructor injection that is already
  optional/nullable (F2).
- Coordination state is files + git under a single committer — host-agnostic
  persistence, audit trail, and crash recovery come with it (F4).
- A file-protocol job interface already ships and is exercised in production
  paths: spawn-request JSON in → isolated worktree run → outbox `act:"done"`
  out → branch preserved behind fail-safe git gates (F5).
- Executed headless twice in this investigation — deterministic stub and real
  `claude` agent — with hooks, transcript collection, and worktree gating all
  live (F9).

What it is *not yet*: a library. The engine has no entry point of its own —
`index.ts` is the only assembler, and it is inseparable from Electron (F3).
Extraction is therefore a re-hosting exercise (build a second, headless
composition root) rather than a refactoring of the engine itself.

## 2. What percentage of the orchestration layer appears reusable?

Measured against the orchestration-relevant code (src/main + src/shared,
14,927 LOC; the 23,870-LOC renderer is presentation and out of scope except
where noted):

| Tier | LOC | Share | Reusable as-is? |
| --- | --- | --- | --- |
| Engine core (F11 closure: pty, git, hive, hooks, transcript, config, pricing, fs + 4 shared) | 4,944 | 33% | **Yes — proven by execution, zero modifications** |
| Engine support (closingTime, completionWatcher, breaker, control, telemetry, usage, shellEnv, hiddenClaude, db, memory, knowledge, reflect) | 2,904 | 19% | Yes by construction (same injection pattern; not exercised by the slice) |
| Composition root (`index.ts`) | 3,592 | 24% | No as a file — but ~1,000 LOC of trapped engine logic inside it (spawnAgentCore, teardown/finalize, worker loop, beats) is re-hostable; the slice re-stated the parts it needed in ~40 lines |
| Feature edges (slack, webhook, broker, integrations, realtime/voice, github, groq, freeflow, hire) | ~3,490 | 23% | Mostly portable (little Electron) but platform-optional |
| Renderer-resident orchestration policy (`useHive.ts`, `usePtyParser.ts`, parts of `store.ts`/`AgentStrip`/`CommandCenterPanel`) | ~1k of 23,870 | — | Logic must be **re-implemented main-side** (it is interleaved with React lifecycle, zustand, and localStorage, so port the policy, not the code); the rest of the renderer is genuinely UI |

Bottom line: **~52% of the orchestration layer is reusable outright (core +
support), ~75% including the trapped-but-portable glue and feature edges; the
irreducibly Electron/UI-bound remainder is the shell itself.**

## 3. What architectural assumptions prevent extraction?

In descending order of severity (locations and effort in §4):

1. **The renderer owns the typing plane — plus the policy and state around
   it** (F6). Main never writes into a PTY (sole `ptyManager.write` call site
   is the `pty:write` IPC handler, index.ts:2079). Renderer timers own:
   idle-agent wake/mail delivery (a fresh interactive worker's first turn
   included), god's auto-spawn + boot orientation, two turn-completion
   inference loops (incl. approval-prompt auto-answering with generated
   keystrokes), delivery pacing, crash recovery (auto-revive with `--resume`,
   team restore), auto-compact targeting, and Slack dispatch — kept alive by
   `backgroundThrottling: false` (index.ts:1529-33). The renderer also holds
   durable state main lacks: spawn recipes, per-agent message queues, restore
   recipes (`localStorage`, store.ts:231-390). Headless closed-loop autonomy
   requires porting this policy layer and re-homing that state.
2. **Composition root import-time effects** (F3): singletons, 107 `ipcMain`
   registrations, and the single-instance lock all run at module scope of
   `index.ts`; none of its private orchestration functions are exported.
3. **`app.getPath('userData')`** hardcodes the config/db root (config.ts:381,
   db.ts:81, knowledge.ts:12) — trivially stubbable (the slice's stub is the
   existence proof) but must be decided once for a real engine (env var /
   constructor).
4. **`safeStorage` secret store** (integrations.ts) for BYOK non-Claude
   providers — needs a headless secret backend or a keyless mode (Claude/codex
   paths don't use it).
5. **Slack ingress terminates in the renderer** (card creation + god-PTY
   injection on `slack:incomingMessage`); with no window the message is
   dropped. Follows from #1.
6. Minor host assumptions: desktop `Notification` toasts (config-gated off),
   `powerSaveBlocker` keep-awake, `powerMonitor` resume-healing, app-menu /
   dialogs — all shell conveniences, none load-bearing.
7. A behavioral (not Electron) side effect worth an explicit decision:
   `ensureClaudePermissionsAccepted` runs at every Claude spawn
   (index.ts:2008) and mutates the **user-global** `~/.claude/settings.json`
   (`skipDangerousModePermissionPrompt`) and `~/.claude.json` per-folder trust
   flags (config.ts:490-523). A multi-tenant headless host inherits this
   unless scoped (e.g. per-run HOME) or made opt-in.

Explicitly *not* blockers (checked and cleared): BrowserWindow existence
(windowless operation is a supported macOS state, index.ts:3587-92); IPC
ownership (handlers are one-line delegations to engine methods); singleton
init order (bootstrapHiveServices is Electron-free, index.ts:3395-3422);
lifecycle ordering (hive self-provisions its dirs, shims, and git repo on
demand); configuration (plain JSON file); persistence (files + git, F4).

## 4. What minimal work is required to obtain a reusable headless engine?

| # | Work item | Location | Effort | Confidence |
| --- | --- | --- | --- | --- |
| 1 | Headless composition root: assemble PtyManager/HiveManager/HookServer/watchers behind a CLI or API entry (the slice is the skeleton) | new file(s), pattern proven in `headless/run.ts` | days | High |
| 2 | Port the autonomy-policy layer main-side: the wake/delivery loop (idle gate via `pty.idleFor` + hook status → `hive.inbox` scan → dedup-by-newest-id → paced `pty.write` with the write-chain discipline) is the essential kernel; god ensure-spawn, quiescence inference, revive-on-resume, and compact targeting follow the same shape. Re-home spawn recipes + message queues from renderer `localStorage` into the hive/db | re-implement the policy in `useHive.ts:213-301, 475-656, 754-849` beside the worker watcher | ~1 week for the full layer (the nudge kernel alone: 1–2 days) | High |
| 3 | Lift trapped glue out of `index.ts`: export/move `spawnAgentCore`, `teardownPty`, `finalizeWorkerWorktree`, the ephemeral-worker loop, `armAlwaysOnBeats` into modules both roots share | index.ts:244-430, 1805-2076, 3010-3393 | days (mechanical; the functions already take injected deps) | High |
| 4 | Path provider for `userData` (env/param instead of `app.getPath`) | config.ts:381, db.ts:81, knowledge.ts:12 | hours | High |
| 5 | Secret-store interface with a headless backend (or keyless mode) for BYOK | integrations.ts | ~1 day | Medium |
| 6 | Re-home Slack ingress main-side (reuse the worker file protocol the webhook path already uses) | index.ts:~1157-1233 + renderer handler | 1–2 days | Medium |
| 7 | Fix `projectDir` slug drift (leading dash) so resume-seeding/offline usage work against current Claude Code | transcript.ts:12-17 | hours | High (bug), Medium (blast radius) |
| 8 | Verify Windows named-pipe hook server + `ELECTRON_RUN_AS_NODE` sidecars under plain Node | hive.ts:306-314, :807 | ~1 day validation | Medium |

Order-of-magnitude total: **~2–3 weeks of focused work to a supported
headless engine**, of which the genuinely novel part is only item 2 —
everything else is moving code that already behaves.

## 5. If starting over today

**Keep unchanged** — they are already engine-grade:
`hive.ts` (coordination + git ledger), `pty.ts` (spawn/stream/resolve),
`git.ts` (worktrees + fail-safe gates), `hooks.ts` (hook lifecycle + autonomy
drain), `transcript.ts` (modulo the F10 one-liner), `breaker.ts`/`control.ts`
(policy/state, zero deps), `realtimeCompletionWatcher.ts`,
`shared/agentProvider.ts` (the multi-provider matrix is real IP), `config.ts`
logic (behind a path provider).

**Extract** (same code, new home): the ~1,000 LOC of orchestration trapped in
`index.ts` — spawnAgentCore, teardown/finalize/GC, the ephemeral-worker loop,
always-on beats, missions/heartbeat — into an `engine/` package with two
composition roots (Electron shell, headless CLI/daemon). The preload's 134
channels (112 invoke + 22 push) already enumerate the API surface a service
layer would expose; ~14 of them are the engine core.

**Replace**: the renderer-resident autonomy loops (`useHive.ts` nudge/
quiescence/flush) with the main-side equivalent (§4.2) — the UI keeps
rendering state but stops being a control-flow dependency; Slack ingress'
renderer handoff with the file protocol; `app.getPath`/`safeStorage` with
injected providers.

**Delete** (from the engine's perspective; they remain app features):
Pixi/avatars/office scene, voice/realtime stack, blog/landing/SEO assets,
window/menu/dialog chrome, desktop notifications, hire-links, tunnel
integrations — none are imported by anything in the engine closure (F8, F11).

## 6. The smallest practical engine API (Q5)

Two layers, both already present in embryo:

**Job level (exists today as files, F5):**
```
POST spawn-request {objective, cwd, [provider, model, command, isolate, tokenCap]}
  → events: spawned | output-bytes | hook-event | done{branch, transcript} | failed
  → guarantees: isolated agent/<id> branch; un-integrated work never auto-discarded
```

**Engine level (the class seams, F2/F11):**
```
createEngine({ home, secrets?, sinks? }) → {
  spawn(opts)  → { worktreePath?, resumed? }     // spawnAgentCore
  write(id, data); resize(id, c, r); kill(id)    // PtyManager
  send(msg); inbox(id); registry(); tasks()      // HiveManager
  onOutput / onHookEvent / onCompletion / onBreakerState   // injected sinks
  transcriptPath(id); usage(id)                  // HookServer + telemetry/transcript
  shutdown({ graceful })                          // closingTime / teardown
}
```

Everything in that sketch maps 1:1 to code that ran headless in this
investigation except `spawn` (trapped in index.ts, re-stated in the slice) and
the completion callback fan-out (exists as injected callbacks in
realtimeCompletionWatcher/closingTime).

---

*Supporting evidence for every claim: INVESTIGATION.md F1–F11 with file:line
references; ARCHITECTURE_MAP.md for the full inventory; headless/README.md
for the recorded runs.*
