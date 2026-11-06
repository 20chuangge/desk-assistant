/**
 * desktops.mjs - one desktop per bot.
 *
 * The product claim is "bots with their own computer", so a bot must not share
 * a screen with its siblings: whatever bot A opens, bot B must not see. This
 * module gives every bot its own X display, its own VNC server and its own
 * noVNC bridge, all as children of the hub process (no systemd juggling).
 *
 *   bot  ── display :120+N  ── x11vnc 127.0.0.1:59<N>  ── websockify :61<N>
 *
 * Linux only: this needs Xvfb. On macOS/Windows the manager reports
 * unavailable and callers fall back to the single shared desktop, which is what
 * earlier versions had.
 *
 * Ports are derived from a stable index so they do not move between restarts;
 * allocation happens lazily (first time a bot's desktop is asked for).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BASE_DISPLAY = 120;      // :120 .. :159
const BASE_VNC_PORT = 5900 + 20; // 5920 ..
const BASE_WEB_PORT = 6100;    // 6100 ..
const MAX_BOTS = 40;

/** @type {Map<string, {display:number, vncPort:number, webPort:number, procs:object[], startedAt:string}>} */
const desktops = new Map();
let indexByBot = new Map();
let vncPassword = '';
let dataDir = '';

function hasBinary(bin) {
  try {
    const res = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
    return res.status === 0 && Boolean(String(res.stdout || '').trim());
  } catch {
    return false;
  }
}

/** Whether per-bot desktops can work on this machine at all. */
export function desktopSupport() {
  if (process.platform !== 'linux') {
    return { available: false, reason: 'per-bot desktops need Linux (Xvfb + x11vnc)' };
  }
  const missing = ['Xvfb', 'x11vnc', 'websockify'].filter((b) => !hasBinary(b));
  if (missing.length) {
    return { available: false, reason: `missing ${missing.join(', ')} (apt install xvfb x11vnc novnc websockify)` };
  }
  return { available: true, reason: '' };
}

export function configure({ dataDir: dir, password } = {}) {
  if (dir) dataDir = dir;
  if (typeof password === 'string' && password) vncPassword = password;
}

/** Reuse the desktop password the installer already stored, if any. */
async function loadPassword() {
  if (vncPassword) return vncPassword;
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dataDir, 'vnc.json'), 'utf8'));
    vncPassword = String(raw.password || '');
  } catch { /* not configured: VNC stays passwordless on 127.0.0.1 only */ }
  return vncPassword;
}

async function passwordFile() {
  const pass = await loadPassword();
  if (!pass) return '';
  const file = path.join(dataDir, 'desktops.passwd');
  if (!fs.existsSync(file)) {
    await fsp.mkdir(dataDir, { recursive: true });
    const res = spawnSync('x11vnc', ['-storepasswd', pass, file], { encoding: 'utf8' });
    if (res.status !== 0) return '';
    try { await fsp.chmod(file, 0o600); } catch { /* best effort */ }
  }
  return file;
}

/** Best effort: pkill anything left over from a previous hub process. */
function childLog(botId, name) {
  try {
    const dir = path.join(dataDir || process.cwd(), 'desktop-logs');
    fs.mkdirSync(dir, { recursive: true });
    return fs.openSync(path.join(dir, `${botId}-${name}.log`), 'a');
  } catch {
    return 'ignore';
  }
}

function killByPattern(pattern) {
  try {
    spawnSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  } catch { /* pkill missing: the bind will fail loudly instead */ }
}

function stableIndex(botId) {
  if (indexByBot.has(botId)) return indexByBot.get(botId);
  const used = new Set(indexByBot.values());
  let index = 0;
  while (used.has(index) && index < MAX_BOTS) index += 1;
  if (index >= MAX_BOTS) index = MAX_BOTS - 1;
  indexByBot.set(botId, index);
  return index;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(800, () => { socket.destroy(); resolve(false); });
  });
}

/** Xvfb with -nolisten tcp is only visible as a unix socket. */
function displayReady(display) {
  return fs.existsSync(`/tmp/.X11-unix/X${display}`);
}

/**
 * Start (or reuse) the desktop for a bot. Returns the viewer URL.
 * Idempotent: calling it repeatedly is how the UI polls.
 */
export async function ensureDesktop(botId) {
  const support = desktopSupport();
  if (!support.available) throw new Error(support.reason);
  if (!botId) throw new Error('botId is required');

  const existing = desktops.get(botId);
  if (existing) {
    // The map is only a cache: the processes can be gone (killed by hand, OOM,
    // a host restart). A stale entry would hand the UI a dead viewer URL.
    const alive = existing.procs.every((proc) => !proc.killed && proc.exitCode === null)
      && (await portOpen(existing.vncPort))
      && (await portOpen(existing.webPort));
    if (alive) return { ...publicInfo(botId, existing), started: false };
    for (const proc of existing.procs) {
      try { proc.kill(); } catch { /* already gone */ }
    }
    desktops.delete(botId);
  }

  for (const pattern of ['Xvfb :' + (BASE_DISPLAY + stableIndex(botId)), 'x11vnc -display :' + (BASE_DISPLAY + stableIndex(botId))]) {
    killByPattern(pattern);
  }
  const index = stableIndex(botId);
  killByPattern(`websockify --web=/usr/share/novnc ${BASE_WEB_PORT + index}`);
  const display = BASE_DISPLAY + index;
  const vncPort = BASE_VNC_PORT + index;
  const webPort = BASE_WEB_PORT + index;
  const procs = [];

  // A killed Xvfb leaves /tmp/.X<N>-lock behind and the next one refuses to
  // start ("server is already active"), which shows up as a black viewer.
  try { fs.rmSync(`/tmp/.X${display}-lock`, { force: true }); } catch { /* fine */ }
  try { fs.rmSync(`/tmp/.X11-unix/X${display}`, { force: true }); } catch { /* fine */ }

  // 1) the virtual display
  procs.push(spawn('Xvfb', [`:${display}`, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', childLog(botId, 'xvfb'), childLog(botId, 'xvfb')],
    detached: false,
  }));
  for (let i = 0; i < 40 && !displayReady(display); i += 1) await sleep(100);

  // A bare Xvfb is a black rectangle. Run a real session: XFCE when it is
  // installed (looks like a desktop), otherwise a window manager + terminal.
  const sessionEnv = {
    ...process.env,
    DISPLAY: `:${display}`,
    XDG_SESSION_TYPE: 'x11',
    XDG_CURRENT_DESKTOP: 'XFCE',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
  };
  const have = (bin) => {
    try { return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0; }
    catch { return false; }
  };
  if (fs.existsSync('/usr/local/bin/desk-bot-session')) {
    procs.push(spawn('/usr/local/bin/desk-bot-session', [String(display)], {
      stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')],
      env: sessionEnv,
    }));
    await sleep(1500);
  } else if (have('xfce4-session') && have('dbus-launch')) {
    procs.push(spawn('dbus-launch', ['--exit-with-session', 'xfce4-session'], {
      stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')],
      env: sessionEnv,
    }));
    await sleep(1200);
  } else {
    for (const [bin, argv] of [['openbox', []], ['xterm', ['-fa', 'Monospace', '-fs', '11']]]) {
      if (!have(bin)) continue;
      procs.push(spawn(bin, argv, {
        stdio: ['ignore', childLog(botId, 'session'), childLog(botId, 'session')],
        env: sessionEnv,
      }));
      await sleep(300);
    }
  }

  // 2) VNC server on that display, localhost only
  // No VNC password on purpose: the display is bound to 127.0.0.1 and each bot
  // has its own websockify bridge, so "type a password to see your own bot"
  // would be friction with no real protection.
  const args = ['-display', `:${display}`, '-localhost', '-nopw', '-forever', '-shared', '-noxdamage', '-repeat', '-noshm', '-rfbport', String(vncPort)];
  procs.push(spawn('x11vnc', args, { stdio: ['ignore', childLog(botId, 'vnc'), childLog(botId, 'vnc')] }));
  for (let i = 0; i < 50 && !(await portOpen(vncPort)); i += 1) await sleep(100);

  // 3) noVNC bridge for that one display
  procs.push(spawn('websockify', ['--web=/usr/share/novnc', String(webPort), `127.0.0.1:${vncPort}`], {
    stdio: ['ignore', childLog(botId, 'web'), childLog(botId, 'web')],
  }));
  for (let i = 0; i < 50 && !(await portOpen(webPort)); i += 1) await sleep(100);

  const entry = { display, vncPort, webPort, procs, startedAt: new Date().toISOString() };
  desktops.set(botId, entry);
  return { ...publicInfo(botId, entry), started: true };
}

function publicInfo(botId, entry) {
  return {
    botId,
    display: `:${entry.display}`,
    vncPort: entry.vncPort,
    webPort: entry.webPort,
    running: entry.procs.every((p) => !p.killed && p.exitCode === null),
    startedAt: entry.startedAt,
    url: `http://${lanAddress()}:${entry.webPort}/vnc.html?autoconnect=1&resize=scale`,
  };
}

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/** Info for a bot's desktop without starting one. */
export function desktopInfo(botId) {
  const entry = desktops.get(botId);
  if (!entry) return { botId, running: false, display: null, url: null };
  return publicInfo(botId, entry);
}

/** What the browser/shell tools should put in the environment for this bot. */
export function desktopEnv(botId) {
  const entry = desktops.get(botId);
  return entry ? { DISPLAY: `:${entry.display}` } : {};
}

export function stopDesktop(botId) {
  const entry = desktops.get(botId);
  if (!entry) return false;
  for (const proc of entry.procs) {
    try { proc.kill(); } catch { /* already gone */ }
  }
  desktops.delete(botId);
  indexByBot.delete(botId);
  return true;
}

export function stopAllDesktops() {
  for (const botId of [...desktops.keys()]) stopDesktop(botId);
}

export function listDesktops() {
  return [...desktops.keys()].map((botId) => desktopInfo(botId));
}
