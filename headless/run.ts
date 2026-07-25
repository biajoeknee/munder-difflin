/**
 * Phase 4 — headless vertical slice.
 *
 * Exactly one execution path, per the investigation charter:
 *
 *   CLI → create isolated worktree → spawn agent → stream output
 *       → detect completion → collect transcript → clean up → exit
 *
 * Every orchestration step below is performed by Munder's own main-process
 * modules, imported UNMODIFIED from src/main and src/shared:
 *
 *   - PtyManager            (src/main/pty.ts)        spawn + stream + exit
 *   - git worktree helpers  (src/main/git.ts)        isolation + safety gates
 *   - HiveManager           (src/main/hive.ts)       agent workspace, identity,
 *                                                    hook-shim injection, outbox
 *   - HookServer            (src/main/hooks.ts)      Claude Code hook lifecycle,
 *                                                    transcript-path discovery
 *   - transcript helpers    (src/main/transcript.ts) usage + transcript location
 *   - readConfig            (src/main/config.ts)     harness config
 *
 * The ONLY substitutions are:
 *   1. 'electron' is aliased to electron-stub.ts (app.getPath + a no-op
 *      Notification — see that file for why this is the whole surface), and
 *   2. the renderer output sink is a ~5-line duck-typed object with the same
 *      structural contract PtyManager already null-checks ({send, isDestroyed}).
 *
 * This mirrors the app's own ephemeral-worker path (index.ts processSpawnRequest
 * → spawnAgentCore), which the source itself describes as "headless-by-design".
 * Logic that lives trapped inside index.ts (worktree placement, done-signal
 * scan) is re-stated here in a few lines each, with the index.ts line refs.
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PtyManager } from '../src/main/pty';
import {
  addWorktree, getBranch, isRepo, removeWorktree, worktreeHasUnintegratedWork
} from '../src/main/git';
import { HiveManager } from '../src/main/hive';
import { HookServer } from '../src/main/hooks';
import { projectDir, readAgentUsage } from '../src/main/transcript';
import { readConfig, writeConfig } from '../src/main/config';

// ── tiny argv parser (the slice takes five flags; no framework) ─────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const log = (msg: string): void => console.log(`[slice] ${msg}`);

async function main(): Promise<void> {
  const targetRepo = flag('cwd');
  const prompt = flag('prompt');
  const command = flag('command') ?? 'claude';
  const model = flag('model');
  const timeoutSec = Number(flag('timeout') ?? '300');
  const agentId = flag('agent-id') ?? `slice-${Date.now().toString(36)}`;
  if (!targetRepo || !prompt) {
    console.error(
      'usage: node dist/run.cjs --cwd <git-repo> --prompt "<objective>" ' +
      '[--command claude] [--model <id>] [--timeout <sec>] [--agent-id <id>] [--keep-worktree]'
    );
    process.exit(2);
  }
  const cwd = resolve(targetRepo);

  // ── harness home (the stub's app.getPath roots everything here) ───────────
  const home = process.env.MUNDER_HEADLESS_HOME || join(tmpdir(), 'munder-headless');
  process.env.MUNDER_HEADLESS_HOME = home;
  mkdirSync(home, { recursive: true });
  // Persist harnessHome the same way the app's onboarding does, so readConfig()
  // (used by the engine modules) resolves the identical value.
  writeConfig({ harnessHome: home, notifications: false });
  log(`harness home: ${home}`);

  // ── engine assembly — the constructors index.ts runs at import time,
  //    minus every Electron argument (all of them are already optional) ──────
  const hive = new HiveManager(
    () => readConfig().harnessHome ?? null,
    (channel, payload) => {
      // The renderer mirror is an OPTIONAL callback in HiveManager's
      // constructor. Here it becomes a log line — proof it is observability,
      // not control flow.
      log(`hive emit ${channel} ${JSON.stringify(payload).slice(0, 120)}`);
    }
  );
  const hookServer = new HookServer(hive, () => null, () => readConfig());
  hookServer.start();
  log(`hook server listening on ${hive.sockPath()}`);

  const ptyManager = new PtyManager();

  // ── 1. isolated worktree (mirrors index.ts spawnAgentCore L1864–1891) ─────
  let agentCwd = cwd;
  let worktreePath: string | null = null;
  let baseBranch = 'main';
  if (await isRepo(cwd)) {
    const br = await getBranch(cwd);
    if ('current' in br && br.current) baseBranch = br.current;
    const wtRoot = join(home, 'worktrees');
    mkdirSync(wtRoot, { recursive: true });
    const wt = join(wtRoot, agentId.replace(/[^A-Za-z0-9._-]/g, '-'));
    const res = await addWorktree(cwd, wt, baseBranch);
    if (res.ok) {
      agentCwd = wt;
      worktreePath = wt;
      log(`worktree created: ${wt} (branch agent/${agentId}, base ${baseBranch})`);
    } else {
      log(`worktree creation failed (${res.error}) — falling back to shared cwd`);
    }
  } else {
    log(`--cwd is not a git repo — spawning without isolation`);
  }

  // ── 2. hive provisioning (identity, memory, inbox/outbox, hook shim) ──────
  const meta = {
    id: agentId,
    name: `Slice ${agentId}`,
    role: 'worker',
    provider: 'claude' as const,
    cwd: agentCwd
  };
  const inj = await hive.ensureAgent(meta, { theme: 'light' });
  log(`hive injection: ${inj.args.length} args, env keys [${Object.keys(inj.env).join(', ')}]`);

  // ── 3. spawn — print mode (-p) is this slice's single completion contract:
  //    the CLI exits when the objective is done. The hive hook settings
  //    (--settings from ensureAgent) still attach, so Stop/PostToolUse hooks
  //    stream to HookServer over the UDS exactly as in the app. ────────────
  const args = [...inj.args];
  if (model) args.push('--model', model);
  // Mirrors the app's autoMode flag injection (config.ts commandForAutoMode →
  // '--permission-mode bypassPermissions'); the slice defaults to no flag and
  // accepts an explicit mode for runs that must edit files unattended.
  const pmode = flag('pmode');
  if (pmode) args.push('--permission-mode', pmode);
  args.push('-p', prompt);

  // The renderer sink, duck-typed. PtyManager.safeSend needs exactly this
  // structural surface; 'WebContents' in pty.ts is a type-only import.
  let bytes = 0;
  const sink = {
    isDestroyed: (): boolean => false,
    send: (channel: string, payload: unknown): void => {
      if (channel.startsWith('pty:data:')) {
        bytes += String(payload).length;
        process.stdout.write(String(payload));
      } else if (channel.startsWith('pty:exit:')) {
        log(`sink saw ${channel} ${JSON.stringify(payload)}`);
      }
    }
  } as never;

  let doneTick: ReturnType<typeof setInterval> | null = null;
  const exited = new Promise<{ how: string; code?: number }>((resolveExit) => {
    ptyManager.setExitHandler((id, exitCode) => {
      if (id === agentId) resolveExit({ how: 'pty-exit', code: exitCode });
    });
    // Belt-and-braces: the worker done-signal scan (index.ts L3048
    // workerSignaledDone) — an outbox message with act:"done" also completes
    // the run. Ephemeral workers use this as their primary completion signal.
    const spawnedAt = Date.now();
    doneTick = setInterval(() => {
      const root = hive.root();
      if (!root) return;
      const base = join(root, 'agents', agentId, 'outbox');
      for (const dir of [base, join(base, '.sent')]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const msg = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            const ts = Date.parse(msg.created_at ?? '') || statSync(join(dir, f)).mtimeMs;
            if (msg.act === 'done' && ts > spawnedAt) {
              resolveExit({ how: 'outbox-done' });
              return;
            }
          } catch { /* partial write — next tick */ }
        }
      }
    }, 1500);
  });

  log(`spawning: ${command} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + '…' : a)).join(' ')}`);
  const spawnRes = ptyManager.spawn(
    { id: agentId, cwd: agentCwd, command, args, cols: 120, rows: 32, env: inj.env },
    sink
  );
  if (!spawnRes.ok) {
    console.error(`[slice] spawn failed: ${spawnRes.error}`);
    hookServer.stop();
    process.exit(1);
  }
  log(`agent spawned (pid ${ptyManager.list()[0]?.pid})`);

  // ── 4. wait for completion (or timeout) ───────────────────────────────────
  const outcome = await Promise.race([
    exited,
    new Promise<{ how: string }>((r) => setTimeout(() => r({ how: 'timeout' }), timeoutSec * 1000))
  ]);
  if (doneTick) clearInterval(doneTick);
  log(`completion detected via: ${outcome.how}${'code' in outcome ? ` (exit code ${outcome.code})` : ''}`);
  // On an outbox-done (the ephemeral-worker completion contract) or a timeout
  // the process is still alive — tear it down, as ephemeralWorkerTick does.
  if (outcome.how !== 'pty-exit') ptyManager.kill(agentId);

  // ── 5. collect the transcript ─────────────────────────────────────────────
  // Primary source: the hook payloads told HookServer where the live session's
  // transcript is (the same mechanism the app uses). Fallback: newest .jsonl
  // in the Claude project dir for the agent's cwd (transcript.ts projectDir).
  let transcript = hookServer.transcriptPath(agentId);
  if (!transcript || !existsSync(transcript)) {
    const dir = projectDir(agentCwd);
    if (existsSync(dir)) {
      const jsonl = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      transcript = jsonl[0]?.f;
    }
  }
  let transcriptCopy: string | null = null;
  let transcriptLines = 0;
  if (transcript && existsSync(transcript)) {
    const outDir = join(home, 'transcripts');
    mkdirSync(outDir, { recursive: true });
    transcriptCopy = join(outDir, `${agentId}.jsonl`);
    copyFileSync(transcript, transcriptCopy);
    transcriptLines = readFileSync(transcriptCopy, 'utf8').split('\n').filter(Boolean).length;
    log(`transcript collected: ${transcriptCopy} (${transcriptLines} records, from ${transcript})`);
  } else {
    log('no transcript found (expected for a non-Claude stub agent)');
  }
  const usage = readAgentUsage(agentCwd);

  // ── 6. clean up: teardown mirrors index.ts finalizeWorkerWorktree — never
  //    discard un-integrated work (git.ts worktreeHasUnintegratedWork). ─────
  let worktreeOutcome = 'none';
  if (worktreePath) {
    const gate = await worktreeHasUnintegratedWork(worktreePath, baseBranch);
    if (has('keep-worktree') || gate.keep) {
      worktreeOutcome = `preserved (${gate.detail})`;
    } else {
      const rm = await removeWorktree(cwd, worktreePath);
      worktreeOutcome = rm.ok ? 'removed (no un-integrated work)' : `remove failed: ${rm.error}`;
    }
    log(`worktree: ${worktreeOutcome}`);
  }
  hookServer.stop();

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log(JSON.stringify({
    slice: 'ok',
    agentId,
    completion: outcome.how,
    streamedBytes: bytes,
    worktree: { path: worktreePath, outcome: worktreeOutcome },
    transcript: { path: transcriptCopy, records: transcriptLines },
    usage
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('[slice] fatal:', e);
  process.exit(1);
});
