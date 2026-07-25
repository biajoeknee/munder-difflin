/**
 * Bundle the headless vertical slice with esbuild.
 *
 * The only build-level intervention is an alias: 'electron' → electron-stub.ts.
 * Every engine module (pty.ts, git.ts, hive.ts, hooks.ts, transcript.ts,
 * config.ts, shared/*) is bundled UNMODIFIED from src/.
 * node-pty stays external (native addon, resolved from headless/node_modules).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'run.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(here, 'dist/run.cjs'),
  external: ['node-pty'],
  alias: { electron: join(here, 'electron-stub.ts') },
  define: { __APP_VERSION__: '"headless-slice"' },
  logLevel: 'info'
});
