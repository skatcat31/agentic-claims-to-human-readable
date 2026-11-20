/**
 * Downloads the React 18 UMD bundles into ./vendor on first run so the
 * exported HTML files can be fully self-contained (complete React
 * bundle baked in, no CDN dependency at view time).
 */

import * as fs from 'fs';
import * as path from 'path';
import { VENDOR_DIR } from './paths';

export const REACT_VERSION = '18.3.1';

const SOURCES: Record<string, string[]> = {
  'react.production.min.js': [
    'https://unpkg.com/react@' + REACT_VERSION + '/umd/react.production.min.js',
    'https://cdn.jsdelivr.net/npm/react@' + REACT_VERSION + '/umd/react.production.min.js',
  ],
  'react-dom.production.min.js': [
    'https://unpkg.com/react-dom@' + REACT_VERSION + '/umd/react-dom.production.min.js',
    'https://cdn.jsdelivr.net/npm/react-dom@' + REACT_VERSION + '/umd/react-dom.production.min.js',
  ],
};

/**
 * Ensure both vendor files exist on disk, downloading if necessary.
 * @param dir vendor directory (defaults to the project `vendor/` dir)
 */
export async function ensureVendor(dir: string = VENDOR_DIR): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  for (const name of Object.keys(SOURCES)) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) continue;
    let ok = false;
    for (const url of SOURCES[name]) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const text = await res.text();
        if (text.length < 5000) continue;
        await fs.promises.writeFile(dest, text);
        ok = true;
        break;
      } catch {
        // try the next mirror
      }
    }
    if (!ok) {
      throw new Error(
        'Could not download ' + name + ' from any CDN. Check network access or pre-place the file in ' + dir
      );
    }
  }
}
