/**
 * Electron stand-in for the headless vertical slice (Phase 3: "prefer deletion
 * over abstraction" — this is not an abstraction layer, it is the smallest
 * possible witness of what the engine modules actually consume from Electron).
 *
 * The entire runtime Electron surface the imported engine modules touch:
 *   - config.ts  → app.getPath('userData')   (one filesystem path)
 *   - hooks.ts   → Notification              (desktop toast; gated off by config)
 * Everything else ('WebContents' in pty.ts / hooks.ts / closingTime.ts) is a
 * type-only import, erased at compile time.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const base = (): string =>
  process.env.MUNDER_HEADLESS_HOME || join(tmpdir(), 'munder-headless');

export const app = {
  getPath: (_name: string): string => join(base(), 'userData')
};

export class Notification {
  static isSupported(): boolean {
    return false;
  }
  constructor(_opts?: unknown) {}
  show(): void {}
}
