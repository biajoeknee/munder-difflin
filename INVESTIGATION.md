# INVESTIGATION — Can Munder serve as a headless orchestration engine?

Living findings document for the engine-extraction investigation
(2026-07-25, commit `7f5d09d`). Companion reference: `ARCHITECTURE_MAP.md`.
Working proof: `headless/`. Conclusions: `FINAL_REPORT.md`.

**Headline answer:** Munder is an orchestration engine wearing an Electron
shell — with one deliberate exception: the autonomy loop's *policy layer*
(when to wake an idle agent by typing into its terminal, god's auto-spawn,
silence-based turn inference, crash revival) currently runs on renderer
timers, with a small amount of durable state in renderer `localStorage`. The
mechanism layer (spawn, isolate, stream, hooks, route, complete, clean up) is
Electron-free, dependency-injected, and was executed headless in this
investigation without modifying a single engine module.

---

## Method

- Phase 1–2 (no code changes): full-source mapping by 13 parallel readers +
  firsthand verification of every load-bearing claim; mechanical Electron
  import census; dependency closure computed from a real bundle (esbuild
  metafile), not by hand.
- Phase 3–4: elimination by composition — a new entry point (`headless/run.ts`)
  that imports only the engine modules; peripherals fall away by not being
  imported (preferred over in-place surgery, which the composition root's
  structure makes unnecessary). One execution path was run twice: a
  deterministic stub agent and a real `claude` agent.
- Phase 5: blockers enumerated in `FINAL_REPORT.md` §4–5.

---

## Findings

### F1 — The orchestration mechanism is Electron-free

**Observation.** Every module on the spawn→monitor→cleanup path either imports
no Electron at all, or touches it only through erased type imports, injected
nullable callbacks, or one path lookup.

**Evidence.** Grep census of `from 'electron'` across `src/main` + `src/shared`
(ARCHITECTURE_MAP §5): `hive.ts` (2,130 LOC, the coordination heart) — zero;
`git.ts`, `transcript.ts`, `breaker.ts`, `control.ts`, `shellEnv.ts`,
`realtimeCompletionWatcher.ts`, all of `src/shared` — zero. `pty.ts:2` and
`closingTime.ts:26` — `import type { WebContents }`, erased at compile time.
`hooks.ts:16` — `Notification`, config-gated behind `notifications:false`
(hooks.ts:270-276). `config.ts:381`, `db.ts:81`, `knowledge.ts:12` —
`app.getPath('userData')` only.

**Inference.** The engine/shell seam already exists and is respected by the
modules; Electron is a host, not a dependency, for the mechanism layer. The
full mechanical census: 43 files across `src/main` + `src/shared`, exactly 10
import Electron, 33 are Electron-free — and 12+ of those carry explicit
"deliberately free of any electron import" design comments (control.ts:17,
freeflow.ts:16, telemetry.ts:27-28, slack.ts:18-19, webhook.ts:24-25,
integrationBroker.ts:15-16, hire.ts:5-6, …): the seam is intentional, not
accidental.

**Confidence.** High (mechanically verified + executed headless, F9).

---

### F2 — The seam is deliberate: dependencies point inward via injection

**Observation.** Engine classes receive their environment through constructor
parameters that are already optional or nullable; renderer emits are
fire-and-forget observability.

**Evidence.** `HiveManager(getHome: () => string | null, emit?: (channel,
payload) => …)` (hive.ts:268-271). `HookServer(hive, getWebContents: () =>
WebContents | null, getConfig, control?, breaker?)` (hooks.ts:63-72) with
`?.send` at every emit (:144, :281, :285). `PtyManager.safeSend` null-checks
its sink (pty.ts:118-124) and the de-facto sink interface is `{send,
isDestroyed}`. `spawnAgentCore(opts, owner: Electron.WebContents | null)`
(index.ts:1805) — extracted from the IPC handler precisely so the worker
watcher can call it rendererlessly (comment :1799-1804).
`realtimeCompletionWatcher.ts:9-16` documents "electron-free + reader-injected"
as a ruled decision; `breaker.ts` is policy-only ("reads signals, returns
decisions") with all enforcement in the caller.

**Inference.** This is conventional dependency inversion toward the composition
root — the codebase was *written* to keep the engine testable/portable, which
makes extraction a re-hosting problem rather than a refactoring problem.

**Confidence.** High.

---

### F3 — The composition root is the trap, not the modules

**Observation.** `index.ts` (3,592 LOC) constructs every singleton at import
time, registers 107 `ipcMain` handlers at module top level, takes the
single-instance lock, and privately owns real orchestration logic that is
exported nowhere: `spawnAgentCore` (:1805), `teardownPty` (:244),
`finalizeWorkerWorktree` (:306), `workerSignaledDone` (:3048), the ephemeral
worker loop (:3010-3393), missions/heartbeat (:435-847), breaker enforcement
(:723-770).

**Evidence.** Section map in ARCHITECTURE_MAP §3.4. Importing `index.ts`
outside Electron throws immediately (`ipcMain`, `app.requestSingleInstanceLock`
:1458 at module scope).

**Inference.** "Can the engine be extracted?" reduces to "can index.ts's glue
be re-hosted?" — the headless slice re-stated the three trapped functions it
needed in ~40 lines total, which bounds the size of the problem.

**Confidence.** High.

---

### F4 — The coordination layer is filesystem + git, not process or IPC state

**Observation.** Everything agents coordinate through is plain files under
`<harnessHome>/hive/`, committed by a single writer (main). Agent transport is
inbox/outbox JSON moved by a 1.5 s polling router; the event log is
append-only JSONL; the cost ledger is a file; there is no database in the
hive (better-sqlite3 serves only UI history in `userData/harness.db`).

**Evidence.** hive.ts (routing, registry, ledger — all file reads per call);
git single-committer with inlined identity and stale-lock recovery
(hive.ts:1575-1602); HIVE.md locked decisions 1–2. Note two doc drifts: the
router polls rather than watches, and the "SQLite FTS index" remains
unimplemented.

**Inference.** The engine's state layer is host-agnostic by construction — a
headless host inherits persistence, audit, and crash recovery for free.

**Confidence.** High.

---

### F5 — An almost-headless execution path already ships: ephemeral workers

**Observation.** The app already runs agents with no watching human: JSON
spawn-requests dropped into `hive/spawn-requests/` are validated, spawned via
`spawnAgentCore` (with a possibly-null renderer), given their objective as a
hive inbox message, completed via an outbox `act:"done"` scan, idle-reaped,
and their worktrees preserved/GC'd behind fail-safe git gates.

**Evidence.** index.ts:3010-3393; "Workers are headless-by-design" (:3143-3145);
done-scan with stale-done guard (:3036-3071); `worktreeHasUnintegratedWork` /
`worktreeIsGcSafe` (git.ts:250, :291).

**Inference.** The engine API a platform would need (submit objective →
isolated run → done signal → integrable branch) already exists as a file
protocol; a headless host mainly needs to re-home the poller.

**Confidence.** High.

---

### F6 — The one genuine renderer dependency: the typing plane (and its state)

**Observation.** The main process never writes into an agent PTY. The single
`ptyManager.write` call site is the `pty:write` IPC handler (index.ts:2079).
A substantial slice of autonomy *policy* runs on renderer timers: (1) god's
very existence — the renderer decides to spawn `pty-god` and types
`/remote-control` + the orientation prompt (useHive.ts:213-301); (2) the
4 s idle inbox-wake nudge that delivers mail to idle agents and starts a
fresh interactive worker's first turn (:502-533); (3) turn-completion
inference, twice — 12 s PTY-quiescence drift (:475-498) and usePtyParser's
4 s idle drift + approval-prompt regex answered with generated y/n keystrokes
(usePtyParser.ts:57-71, :149-178); (4) delivery scheduling — idle gating,
4.5 s cooldowns, boot-grace, per-pty write chains (useHive.ts:564-656,
:62-96); (5) crash recovery — auto-revive after sleep with kill→respawn
`--resume` and worktree re-entry, and `restoreTeam`
(useHive.ts:778-849, AgentStrip.tsx:48-129); (6) auto-compact target
selection (:754-768) and dispatch-through-god routing
(CommandCenterPanel.tsx:293-314). Moreover the renderer **owns durable
orchestration state main does not hold**: spawn recipes (model, command,
goal, worktreePath), per-agent message queues, and restore recipes persist in
`localStorage` (store.ts:231-390).

**Evidence.** File:line refs above; reengageGod's comment "delivered by the
renderer's busy-aware inbox-wake" (index.ts:701-705);
`backgroundThrottling: false` — "the renderer runs the hive's heartbeat
loops" (index.ts:1529-1533); Slack handoff at
`liveWebContents().send('slack:incomingMessage')` — dropped when no window.
Mitigating: the renderer imports zero Electron (all via the typed IPC
bridge), so the *logic* is mechanically portable; and the codebase's own
voice path states the target architecture — "the renderer is the untrusted
side, so it holds NO policy" (renderer realtime/actions.ts:10-11).

**Inference.** Without a renderer, spawn/stream/complete/cleanup all work
(proven, F9), and Stop-hook draining still works for agents that stop while
holding mail — but an *idle* agent that receives mail later stays asleep,
interactive workers never take their first turn, god never auto-spawns, and
queued messages / restore recipes are unreachable. This is the closed-loop
gap, and it is policy + a little state, not mechanism: every primitive it
needs (`hive.inbox`, `pty.idleFor`, `pty.write`, registry, config) already
exists main-side.

**Confidence.** High (each link verified in source; the main-side port was
not executed in this investigation).

---

### F7 — Completion detection is layered and engine-side

**Observation.** Four mechanisms, none renderer-owned: PTY exit; Stop-hook +
empty inbox; outbox `act:'done'`; task-card flip / done-reply
(realtimeCompletionWatcher) — plus idle-reap as backstop.

**Evidence.** pty.ts:306-315; hooks.ts:203-219; index.ts:3048;
realtimeCompletionWatcher.ts:18-21; idle reap in ephemeralWorkerTick.
(The renderer's 12 s quiescence drift, F6, adds a *fifth*, display-oriented
inference used to gate the nudge.)

**Confidence.** High.

---

### F8 — Peripherals sit on top of the core, never underneath

**Observation.** Slack, webhook, voice/realtime, integrations broker, GitHub,
Groq, freeflow, hire, memory/knowledge/reflection are all constructed and wired
only by `index.ts`; nothing in the minimal closure imports them. They feed the
core through the same public interfaces available headless (spawn-request
files, hive messages, env injection).

**Evidence.** esbuild metafile closure (F11) excludes all of them while the
slice still spawns/monitors/cleans up; webhook ingress *writes spawn-request
files* (webhook.ts → the F5 protocol); Slack ingress terminates in a renderer
handoff (F6). Voice modules register their own `ipcMain` handlers
(realtime.ts:114-116, realtimeActions.ts:576/592/616) — the only Electron
imports outside the root and the path/notification cases. Reverse-dependency
sweep: the core reaches into this crust through exactly three narrow, optional
edges — `git.ts` imports `fs.ts`'s `safeJoin` but only for the UI diff feature
(git.ts:3, :173), the worker spawn grants a broker token *only when the broker
is running* (index.ts:3129-3134, revoked in teardown :245-247), and
`integrations.getSecret` is read only on the non-Claude BYOK branch
(index.ts:2022+). Ten of thirteen peripheral modules import no Electron at
all, several with explicit "deliberately free of any electron import" header
comments (slack.ts:18-19, webhook.ts:24-25, integrationBroker.ts:15-16,
freeflow.ts:16-17, hire.ts:5-6); none starts a server or touches Electron at
import time — every HTTP server is a class started explicitly by `index.ts`.

**Confidence.** High.

---

### F9 — The engine runs headless: executed proof

**Observation.** A CLI (`headless/run.ts`) assembled the engine from
unmodified modules and ran the charter's Phase-4 path twice under plain
Node 22 — no Electron binary installed in the closure.

**Evidence.** `headless/README.md` (recorded verdicts). Tier 1 (stub agent):
worktree created → env injection observed by the child → 549 bytes streamed →
completion via outbox `act:'done'` → PTY reaped → worktree removed after the
un-integrated-work gate passed. Tier 2 (real `claude -p`, haiku): hive-injected
`--settings` hooks fired through `cth-hook.cjs` over the UDS into `HookServer`
(session id landed in `registry.json` via `recordSession`; hive git log shows
the commit), 17-record transcript collected via `HookServer.transcriptPath`,
agent-created file present in the worktree, dirty worktree preserved by the
gate. Total substitution: a 30-line electron stub (`app.getPath` + no-op
`Notification`) and a 10-line duck-typed output sink.

**Inference.** Q3 is answered affirmatively for the mechanism layer by
execution, not argument.

**Confidence.** High.

---

### F10 — Incidental bug: transcript project-dir slug drops the leading dash

**Observation.** `transcript.ts:projectDir()` maps `/a/b` → `a-b`, but current
Claude Code creates `-a-b`. The offline fallbacks (`readAgentUsage`,
`seedSessionTranscript`, `resolveSessionCwd`) therefore miss silently on this
Claude Code version; the app survives because hook payloads carry
`transcript_path` (F9 observed exactly this: hook path worked, usage summed 0).

**Evidence.** transcript.ts:12-17 vs. a live `~/.claude/projects` listing
(`-home-user-munder-difflin`, `-tmp-…`); reproduced in the Tier-2 run.

**Inference.** Resume seeding (`--resume` after moving cwds) and offline cost
reconciliation are likely broken against current Claude Code. Not fixed here
(charter: preserve behavior); flagged for follow-up.

**Confidence.** High on this machine's Claude Code version; Medium as a
general claim (version-dependent).

---

### F11 — The minimal module set (Q1), mechanically derived

**Observation.** The complete first-party closure of the working slice is 12
files, 4,944 LOC — 8 of 36 `src/main` modules + 4 of 8 `src/shared` modules:
`pty, git, hive, hooks, transcript, config, pricing, fs` +
`agentProvider, claudeCommands, codexCommands, mcpCatalog`.

**Evidence.** esbuild metafile of `headless/dist/run.cjs` (headless/README.md
§"Exact module closure").

**Inference.** Roughly one third of main-process code is the engine; the
support tier (closingTime, completionWatcher, breaker, control, telemetry,
usage, db, memory, knowledge, reflect — 2,904 LOC) is optional and equally
portable; the rest is shell and feature edges.

**Confidence.** High.

---

## Charter questions — status

| Q | Answer | Confidence |
| --- | --- | --- |
| Q1 minimal subset | F11's 12 files; per-capability mapping in FINAL_REPORT §2 | High |
| Q2 Electron classification | ARCHITECTURE_MAP §5 census: 1 composition root (fundamental-to-shell), 4 filesystem-path, 1 notifications, 2 ipc (peripheral voice), 1 secret-store interface, rest type-only/none | High |
| Q3 executes without renderer? | Yes for the mechanism (executed, F9); renderer-resident autonomy policy excepted (F6) | High |
| Q4 headless-blocking assumptions | Composition-root import-time effects (F3); renderer typing plane (F6); `app.getPath` (F1); `safeStorage` for BYOK secrets; single-instance lock; renderer-hosted Slack dispatch | High |
| Q5 reusable engine API | Yes — the file protocol (F5) + the class seams (F2); sketch in FINAL_REPORT §6 | High |

## Open questions / not yet verified

- ~~Renderer-side state inventory~~ — resolved, and the provisional answer
  was wrong: spawn recipes, per-agent message queues, and restore recipes are
  renderer-`localStorage`-durable and *not* rebuildable from main (F6).
- ~~Slack ingress split~~ — resolved: socket-mode server + done-poller are
  main-side and Electron-free; card creation + god-PTY injection are renderer
  (F6, F8).
- Windows named-pipe behavior of the hook server headless (POSIX verified
  only).
- Whether `ELECTRON_RUN_AS_NODE` sidecar spawns (hive.ts:807) behave under a
  plain-Node host (inert per source read; not executed).
- The main-side wake/delivery loop port (FINAL_REPORT §4.2) was scoped, not
  built — the slice used `-p` print mode, which is also a legitimate
  engine-mode answer for one-shot jobs.
