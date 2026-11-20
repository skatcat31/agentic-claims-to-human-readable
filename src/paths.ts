/**
 * Project-root resolution.
 *
 * Modules run from `dist/src/*.js` after compilation (or from `src/*.ts`
 * in the future if a TS runner is used), so directory-relative lookups
 * like `path.join(__dirname, '..', 'vendor')` would break. Instead, walk
 * up from the current file until `package.json` is found — that is the
 * project root — and anchor all filesystem paths there.
 */

import * as fs from 'fs';
import * as path from 'path';

export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate project root (package.json) starting from ' + startDir);
}

export const ROOT = findProjectRoot(__dirname);
export const DATA_FILE = path.join(ROOT, 'data', 'vectorstore.json');
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const VENDOR_DIR = path.join(ROOT, 'vendor');
export const SAMPLES_DIR = path.join(ROOT, 'samples');
export const OPENAPI_FILE = path.join(ROOT, 'openapi.json');
