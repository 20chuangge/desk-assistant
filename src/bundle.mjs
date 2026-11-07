/**
 * bundle.mjs - pack the running Desk into a tarball a blank machine can use.
 *
 * Provisioning has to work from either side: the Desk client (Windows/macOS) or
 * an existing hub (Linux). Both ship a `tar`, so the packer shells out instead
 * of carrying a tar writer; the file lands in the temp dir and is uploaded over
 * SFTP by remote.mjs.
 *
 * What goes in: the code, the seed config, skills, the hub scripts and the
 * package manifest. What must NOT go in: `data/` (secrets, sessions), the
 * workspace (user files), node_modules (there are none) or the desktop/mobile
 * shells (the target only runs the hub).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the app root (the directory that holds src/ and public/). */
export function appRoot() {
  return path.resolve(HERE, '..');
}

// docs/ is deliberately absent: it carries screenshots and is useless on a hub.
// node_modules is tiny here (ssh2 + its deps, ~2 MB) and makes the new machine
// able to provision further machines instead of being a dead end.
const INCLUDE = ['src', 'public', 'config', 'skills', 'hub', 'node_modules', 'package.json'];

/** Build <tmp>/desk-hub-<stamp>.tar.gz and return its path. */
export function packApp({ root = appRoot(), outDir = os.tmpdir() } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(outDir, `desk-hub-${stamp}.tar.gz`);
  const present = INCLUDE.filter((entry) => fs.existsSync(path.join(root, entry)));
  if (!present.includes('src') || !present.includes('public')) {
    throw new Error(`nothing to pack: ${root} has no src/ or public/`);
  }
  return new Promise((resolve, reject) => {
    // The archive name is relative (cwd = outDir): GNU tar reads "C:\..." in
    // -f as host:path and fails, which bites whenever Git's tar is on PATH.
    execFile('tar', ['-czf', path.basename(out), '-C', root, ...present], { cwd: outDir, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`pack failed: ${String(stderr || err.message).slice(0, 300)}`));
        return;
      }
      const size = fs.statSync(out).size;
      resolve({ file: out, bytes: size, entries: present });
    });
  });
}

export function cleanupPack(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
