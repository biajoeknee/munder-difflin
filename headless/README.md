# Headless vertical slice — investigation artifact (Phase 4)

This directory is an **investigation artifact**, not a product feature. It exists
to answer one question from the Munder engine investigation charter:

> Can the orchestration layer execute without a renderer?

**Answer: yes.** This slice runs exactly one execution path —

```
CLI → create isolated worktree → spawn agent → stream output
    → detect completion → collect transcript → clean up → exit
```

— using Munder's main-process engine modules **imported unmodified from
`src/main` and `src/shared`**, with no Electron binary, no BrowserWindow, no
renderer, and no IPC.

## What is substituted (the entire list)

| Substitution | Size | Why it is honest |
| --- | --- | --- |
| `electron` module → `electron-stub.ts` | ~30 lines | The runtime Electron surface of the imported engine modules is exactly `app.getPath('userData')` (config.ts:381) and `Notification` (hooks.ts:274, already gated off by config). Everything else (`WebContents` in pty.ts/hooks.ts) is a type-only import, erased at compile time. |
| renderer output sink → duck-typed object | ~10 lines | `PtyManager.safeSend` (pty.ts:118) only calls `wc.send(channel, payload)` behind `wc.isDestroyed()` — the de-facto sink interface is `{send, isDestroyed}` and is already nullable. |
| `HiveManager` emit callback → log line | 1 line | The constructor's second parameter is already `emit?:` — optional by design (hive.ts:268). |

Logic that exists only inside the unexported body of `src/main/index.ts` is
re-stated here in a few lines each, with line references:
worktree placement (index.ts:1864–1891), the ephemeral-worker done-signal scan
(index.ts:3048 `workerSignaledDone`), and post-completion teardown gating
(index.ts:306 `finalizeWorkerWorktree`).

## Exact module closure

Produced by esbuild's metafile — this is the complete list of first-party code
bundled into the slice:

```
src/main/config.ts      src/main/pty.ts          src/shared/agentProvider.ts
src/main/fs.ts          src/main/transcript.ts   src/shared/claudeCommands.ts
src/main/git.ts         src/main/pricing.ts      src/shared/codexCommands.ts
src/main/hive.ts        src/main/hooks.ts        src/shared/mcpCatalog.ts
```

12 files, ~242 KB of source. Nothing else from the application is required —
not `index.ts` (190 KB), not the renderer, not Slack/webhook/telemetry/memory/
knowledge/voice/db.

## Running it

```sh
cd headless
npm install         # node-pty (native) + esbuild
npm run build       # → dist/run.cjs

MUNDER_HEADLESS_HOME=/tmp/mh node dist/run.cjs \
  --cwd /path/to/some/git/repo \
  --prompt "Create a file named SLICE_PROOF.md ... then stop." \
  --model claude-haiku-4-5-20251001 --pmode acceptEdits --timeout 240
```

Flags: `--command` (default `claude` — any executable works, see the Tier-1 stub
run below), `--agent-id`, `--keep-worktree`.

## Recorded evidence (2026-07-25, Linux sandbox, Node 22)

**Tier 1 — deterministic stub agent** (a shell script; proves the mechanics with
zero tokens). Completion arrived via the ephemeral-worker outbox contract
(`act:"done"`), the same signal `index.ts` workers use:

```json
{ "slice": "ok", "agentId": "tier1-stub", "completion": "outbox-done",
  "streamedBytes": 549,
  "worktree": { "outcome": "removed (no un-integrated work)" } }
```

**Tier 2 — real `claude` CLI** (haiku, print mode). The agent ran inside the
Munder-provisioned worktree, its Claude Code hooks fired through the
hive-injected `--settings` shim into `HookServer` over the Unix socket
(`registry.json` gained its `sessionId`; the hive git log shows
`hive: session tier2-claude`), the transcript was collected via
`HookServer.transcriptPath`, and the dirty worktree was preserved by
`worktreeHasUnintegratedWork`:

```json
{ "slice": "ok", "agentId": "tier2-claude", "completion": "pty-exit",
  "transcript": { "records": 17 },
  "worktree": { "outcome": "preserved (dirty=true, commitsAheadOf(master)=0)" } }
```

The target file (`SLICE_PROOF.md`) existed in the worktree with the requested
content.

## Incidental bug found while verifying

`transcript.ts:projectDir()` builds the Claude project-dir slug as
`cwd.replace(/^\//, '').replaceAll('/', '-')` — dropping the leading slash.
Current Claude Code keeps it as a leading dash (`/home/user/x` →
`-home-user-x`). Verified against a live `~/.claude/projects` layout: the
directory Munder computes does not exist. Consequence: the *offline* fallbacks
(`readAgentUsage`, `seedSessionTranscript`) silently miss on this Claude Code
version; the app still works because hook payloads carry the authoritative
`transcript_path`. Not fixed here — the investigation charter is
behavior-preserving.
