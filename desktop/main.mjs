/**
 * Nightshift (夜班) desktop shell.
 *
 * The renderer is just the web UI; all the value sits in the Node server that
 * this shell starts as a child process. Keeping them separate means a crashed
 * turn cannot take the window down, and the same server binary is what a phone
 * talks to when you pair it.
 *
 * Layout, packaged:
 *   resources/server/src/*      <- the agent (read-only, ships with the app)
 *   resources/server/config/*   <- seed config, copied to userData on first run
 *   %APPDATA%/Desk/             <- ASSIST_HOME: config, skills, public, workspace, data
 */
import { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage, ipcMain, session } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const DEV_URL = process.env.ASSIST_DEV_URL || '';

// The product is Nightshift (夜班). Installs from when it was called Desk keep
// their data where it already is, %APPDATA%\Desk: set before anything reads it.
app.setName('Nightshift');
app.setPath('userData', path.join(app.getPath('appData'), 'Desk'));

/** Shell text follows the system language (the web UI has its own setting). */
const L = (zh, en) => (/^zh/i.test(app.getLocale?.() || process.env.LANG || '') ? zh : en);

let win = null;
let tray = null;
let child = null;
let quitting = false;
let serverPort = 0;
/** The machine the window shows: '' is this computer, otherwise a hub URL. */
let remoteHub = '';

// ---------------------------------------------------------------------------
// machines
//
// A machine is a Desk server: this computer's own (always running, the
// "本机" entry) or a hub on another box. Each one is its own world - own bots,
// memory and workspace - so switching machines is just pointing the window at
// another server. No relaunch: the local server keeps running underneath.
// ---------------------------------------------------------------------------

const HUB_FILE = path.join(app.getPath('userData'), 'hub.json');          // last machine used
const MACHINES_FILE = path.join(app.getPath('userData'), 'machines.json'); // every remote machine

// A packaged GUI app has nowhere to print. Anything that kills it before the
// window exists would otherwise be invisible, so keep a small boot log.
const BOOT_LOG = path.join(app.getPath('userData'), 'startup.log');
function bootLog(message) {
  try {
    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch { /* ignore */ }
}
process.on('uncaughtException', (err) => bootLog(`uncaught ${err?.stack || err}`));
process.on('unhandledRejection', (err) => bootLog(`rejected ${err?.stack || err}`));
bootLog(`boot packaged=${isPackaged} argv=${process.argv.slice(1).join(' ')}`);

function readHub() {
  try {
    const raw = JSON.parse(fs.readFileSync(HUB_FILE, 'utf8'));
    return typeof raw.url === 'string' && raw.url ? raw.url : '';
  } catch {
    return '';
  }
}

function writeHub(url) {
  try {
    if (!url) { fs.unlinkSync(HUB_FILE); return; }
    fs.mkdirSync(path.dirname(HUB_FILE), { recursive: true });
    fs.writeFileSync(HUB_FILE, `${JSON.stringify({ url, ts: new Date().toISOString() }, null, 2)}\n`);
  } catch { /* already gone / read-only profile */ }
}

function readMachines() {
  try {
    const raw = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw.filter((m) => m && typeof m.url === 'string');
  } catch { /* first run */ }
  return [];
}

function writeMachines(list) {
  try {
    fs.mkdirSync(path.dirname(MACHINES_FILE), { recursive: true });
    fs.writeFileSync(MACHINES_FILE, `${JSON.stringify(list, null, 2)}\n`);
  } catch { /* a read-only profile must not break switching */ }
}

/** Add or update one machine. A name the human gave is never overwritten. */
function rememberMachine(url, patch = {}) {
  const norm = normalizeHub(url);
  if (!norm) return null;
  const list = readMachines();
  const prev = list.find((m) => m.url === norm);
  let fallbackName = norm;
  try { fallbackName = new URL(norm).hostname; } catch { /* keep url */ }
  const row = { ...prev, ...patch, url: norm, name: patch.name || prev?.name || fallbackName };
  writeMachines([row, ...list.filter((m) => m.url !== norm)].slice(0, 30));
  return row;
}

function normalizeHub(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.port && u.protocol === 'http:') u.port = '4390';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** Cheap liveness probe. A hub that requires pairing answers 401 to
 *  /api/health, which still proves the server is alive — treating that as
 *  "unreachable" would make a perfectly good hub look dead. */
async function probeHub(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(3500) });
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

/**
 * Pair this client with a hub using the code its installer printed, and keep
 * the session cookie in Electron's store. The human never sees a pairing
 * screen for a machine Desk configured itself.
 */
async function pairWith(url, code) {
  if (!code) return false;
  try {
    const res = await fetch(`${url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const match = /desk_session=([^;]+)/.exec(res.headers.get('set-cookie') || '');
    if (!match) return false;
    await session.defaultSession.cookies.set({
      url,
      name: 'desk_session',
      value: decodeURIComponent(match[1]),
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
    });
    return true;
  } catch (err) {
    bootLog(`pair ${url} failed: ${err?.message || err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

const RES = isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const SERVER_DIR = isPackaged ? path.join(RES, 'server') : path.resolve(__dirname, '..');
// Packaged: everything writable lives in %APPDATA%/Desk. Dev: use the repo as-is,
// so `npm run desktop` behaves exactly like `npm start`.
const HOME = isPackaged ? app.getPath('userData') : SERVER_DIR;

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function copyDir(from, to, { overwrite = true } = {}) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst, { overwrite });
    else if (overwrite || !(await exists(dst))) await fsp.copyFile(src, dst);
  }
}

/** Seed the writable home, refresh code assets (public/) on every launch.
 *
 * Only meaningful when packaged: in dev, HOME *is* the repo, so copying into it
 * would delete the very files we are reading from. */
async function prepareHome() {
  if (!isPackaged || path.resolve(HOME) === path.resolve(SERVER_DIR)) return;
  await fsp.mkdir(HOME, { recursive: true });
  for (const [dir, overwrite] of [['config', false], ['skills', false], ['workspace', false]]) {
    const src = path.join(SERVER_DIR, dir);
    if (await exists(src)) await copyDir(src, path.join(HOME, dir), { overwrite });
  }
  const pub = path.join(SERVER_DIR, 'public');
  if (await exists(pub)) {
    await fsp.rm(path.join(HOME, 'public'), { recursive: true, force: true });
    await copyDir(pub, path.join(HOME, 'public'));
  }
  await fsp.mkdir(path.join(HOME, 'data'), { recursive: true });
}

// ---------------------------------------------------------------------------
// hub mode: `Desk.exe --hub` turns this install into a headless hub (no window),
// reachable from other devices. Used on the idle PC / VM. Still uses the same
// bundled runtime, so the VM needs no separate Node install.
// ---------------------------------------------------------------------------

const HUB_MODE = process.argv.includes('--hub');
const HUB_HOST = '0.0.0.0';

function startServer({ host = '127.0.0.1', portAttempt = 'fixed' } = {}) {
  const entry = path.join(SERVER_DIR, 'src', 'server.mjs');
  if (!fs.existsSync(entry)) throw new Error(`server entry missing: ${entry}`);

  child = spawn(process.execPath, [entry], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ASSIST_HOME: HOME,
      // Fixed by default: localStorage (machine list, layout prefs) is keyed by
      // origin, and a random port made every restart a brand-new profile.
      PORT: process.env.PORT || (host === HUB_HOST || portAttempt === 'auto' ? '0' : '4390'),
      HOST: host,
      ...(host === HUB_HOST ? { ASSIST_ALLOW_REMOTE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not become ready in 20s')), 20000);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      // the server prints exactly one machine-readable ready line
      if (line.startsWith('{')) {
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'ready' && msg.port) {
            clearTimeout(timer);
            serverPort = msg.port;
            resolve(msg.port);
          }
        } catch { /* human log line, ignore */ }
      }
    });

    child.stderr.on('data', (buf) => {
      const text = buf.toString().trim();
      if (text) console.error('[server]', text);
    });

    child.on('exit', (code, signal) => {
      if (quitting) return;
      // Pinned port busy? Retry once on an ephemeral port.
      if (portAttempt === 'fixed' && code !== 0) {
        console.warn('[desk] pinned port unavailable; retrying on a free port');
        portAttempt = 'auto';
        startServer({ host, portAttempt: 'auto' }).then(resolve).catch(reject);
        return;
      }
      console.error(`[server] exited code=${code} signal=${signal}`);
      if (win && !win.isDestroyed()) {
        dialog.showErrorBox(
          L('夜班的后台进程退出了', 'The Nightshift server stopped'),
          L(`退出码 ${code ?? signal}。重新打开夜班即可恢复；数据在：\n${HOME}`, `Exit code ${code ?? signal}. Reopen Nightshift to recover; your data is in:\n${HOME}`),
        );
      }
      app.quit();
    });

    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// window / tray / menu
// ---------------------------------------------------------------------------

function createWindowFor(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Desk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    // No OS title bar: the web UI draws its own (Grok-Bot style). The thin
    // native frame on Windows also goes away with `frame: false`.
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // external links open in the real browser, never inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Frameless: the page draws the title bar and its own traffic buttons.
  // `?shell=desk` tells the web UI it is inside the desktop shell (it is also
  // opened in plain browsers, where the buttons must not appear).
  const target = new URL(url);
  target.searchParams.set('shell', 'desk');
  win.loadURL(target.toString());

  // Safety net for an older UI (e.g. a hub that has not been updated yet):
  // without traffic buttons a frameless window cannot be closed. The page's own
  // markup wins when present; this only fills the gap.
  win.webContents.on('did-finish-load', async () => {
    try {
      const hasBridge = await win.webContents.executeJavaScript('typeof window.deskShell');
      if (hasBridge !== 'object') {
        bootLog('shell preload missing — window controls unavailable');
        return;
      }
      bootLog('shell bridge ready (frameless title bar)');
    } catch {
      return;
    }
    win.webContents.executeJavaScript(`
      (() => {
        if (!window.deskShell || !document.body || document.getElementById('winbtns')) return;
        document.body.classList.add('shell');
        const style = document.createElement('style');
        style.textContent = \`
          body.shell .topbar { -webkit-app-region: drag; }
          body.shell .topbar button, body.shell .topbar .pill { -webkit-app-region: no-drag; }
          .winbtns { display: inline-flex; gap: 2px; margin-left: 6px; }
          .winbtns button { width: 36px; height: 28px; border: 0; border-radius: 7px;
            background: transparent; color: #98a1b2; font: 13px system-ui; cursor: default; }
          .winbtns button:hover { background: rgba(255,255,255,.07); color: #e6e8ee; }
          .winbtns .win-close:hover { background: #e11d48; color: #fff; }
        \`;
        document.head.appendChild(style);
        const box = document.createElement('div');
        box.className = 'winbtns';
        box.id = 'winbtns';
        box.innerHTML = '<button data-win="min">&#8211;</button>' +
          '<button data-win="max">&#9633;</button>' +
          '<button data-win="close" class="win-close">&#10005;</button>';
        box.addEventListener('click', (e) => {
          const act = e.target.closest('[data-win]')?.dataset.win;
          if (act === 'min') window.deskShell.minimize();
          else if (act === 'max') window.deskShell.toggleMaximize();
          else if (act === 'close') window.deskShell.close();
        });
        (document.querySelector('header.topbar') || document.body).appendChild(box);
      })();
    `).catch(() => { /* a page that blocks scripts just keeps Alt+F4 */ });
  });
  return win;
}

function localUrl() {
  return `http://127.0.0.1:${serverPort}/`;
}

function showWindow() {
  if (!win) {
    createWindowFor(remoteHub || localUrl());
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function machineLabel(url) {
  return readMachines().find((m) => m.url === url)?.name || url.replace(/^https?:\/\//, '');
}

/**
 * Point the window at another machine ('' = this computer). The bots, memory
 * and screen all come from that machine's server, so this IS the switch.
 */
async function switchTo(url) {
  const target = url ? normalizeHub(url) : '';
  if (url && !target) return { ok: false, error: '地址格式不对' };
  if (target && !(await probeHub(target))) {
    return { ok: false, error: L(`连不上 ${machineLabel(target)}（机器关机了，或网络不通）`, `Can't reach ${machineLabel(target)} (it's off, or the network is down)`) };
  }
  remoteHub = target;
  writeHub(target);
  if (target) rememberMachine(target, { lastUsed: new Date().toISOString() });
  bootLog(`switch → ${target || 'local'}`);
  refreshChrome();
  if (win && !win.isDestroyed()) {
    const next = new URL(target || localUrl());
    next.searchParams.set('shell', 'desk');
    win.loadURL(next.toString());
  } else {
    showWindow();
  }
  return { ok: true };
}

function machinesMenu() {
  return [
    { label: L('本机（这台电脑）', 'This computer'), type: 'radio', checked: !remoteHub, click: () => switchTo('') },
    ...readMachines().map((m) => ({
      label: m.name,
      type: 'radio',
      checked: m.url === remoteHub,
      click: () => switchTo(m.url).then((r) => { if (!r.ok) dialog.showErrorBox(L('切换失败', 'Switch failed'), r.error); }),
    })),
  ];
}

/** Tray and app menu both list the machines; rebuild them after any change. */
function refreshChrome() {
  if (win && !win.isDestroyed()) win.setTitle(remoteHub ? `${L('夜班', 'Nightshift')} — ${machineLabel(remoteHub)}` : L('夜班', 'Nightshift'));
  buildMenu();
  if (!tray) return;
  tray.setToolTip(remoteHub ? `${L('夜班', 'Nightshift')} → ${machineLabel(remoteHub)}` : L('夜班', 'Nightshift'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: L('打开夜班', 'Open Nightshift'), click: showWindow },
    { type: 'separator' },
    ...machinesMenu(),
    { type: 'separator' },
    { label: L('打开数据目录', 'Open data folder'), click: () => shell.openPath(HOME) },
    { label: L('退出', 'Quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  if (HUB_MODE) {
    // A headless hub has no window and no machine list, only its data folder.
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: L('打开数据目录', 'Open data folder'), click: () => shell.openPath(HOME) },
      { label: L('退出', 'Quit'), click: () => { quitting = true; app.quit(); } },
    ]));
    return;
  }
  tray.on('double-click', showWindow);
  refreshChrome();
}

function buildMenu() {
  if (HUB_MODE) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: L('夜班', 'Nightshift'),
      submenu: [
        { label: L('机器', 'Machines'), submenu: machinesMenu() },
        { type: 'separator' },
        { label: L('打开数据目录', 'Open data folder'), click: () => shell.openPath(HOME) },
        { label: L('重新加载界面', 'Reload'), accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
        { label: L('开发者工具', 'Developer tools'), accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: L('退出', 'Quit'), accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { label: L('编辑', 'Edit'), role: 'editMenu' },
    {
      label: L('视图', 'View'),
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
  ]));
}

// ---------------------------------------------------------------------------
// window controls (frameless window: the page asks, we act)
// ---------------------------------------------------------------------------

ipcMain.on('shell:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on('shell:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('shell:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// Machine list for the web UI (sidebar switcher, Settings → 机器).
ipcMain.handle('desk:list-machines', () => ({
  current: remoteHub || '',
  local: !remoteHub,
  machines: readMachines(),
}));

ipcMain.handle('desk:switch-hub', (_event, url) => switchTo(url));
ipcMain.handle('desk:use-local', () => switchTo(''));

// A machine Desk just provisioned: remember it under the human's name and pair
// with the code its installer printed, so switching to it is one click.
ipcMain.handle('desk:add-machine', async (_event, { url, name, pairCode } = {}) => {
  const target = normalizeHub(url);
  if (!target) return { ok: false, error: '地址格式不对' };
  const paired = await pairWith(target, pairCode);
  rememberMachine(target, { name: String(name || '').trim().slice(0, 40) || undefined, addedAt: new Date().toISOString() });
  refreshChrome();
  return { ok: true, url: target, paired };
});

ipcMain.handle('desk:rename-machine', (_event, { url, name } = {}) => {
  const target = normalizeHub(url);
  const clean = String(name || '').trim().slice(0, 40);
  if (!target || !clean) return { ok: false, error: '名字不能为空' };
  rememberMachine(target, { name: clean });
  refreshChrome();
  return { ok: true };
});

ipcMain.handle('desk:remove-machine', async (_event, url) => {
  const target = normalizeHub(url);
  writeMachines(readMachines().filter((m) => m.url !== target));
  if (target && target === remoteHub) await switchTo('');
  else refreshChrome();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    try {
      // Hub mode: no window, bind the network, stay in the tray. This is what
      // runs on the idle PC / VM; the other devices connect to it.
      if (HUB_MODE) {
        await prepareHome();
        const port = await startServer({ host: HUB_HOST });
        serverPort = port;
        console.log(`[desk] HUB MODE on http://${HUB_HOST}:${port}/ (home: ${HOME})`);
        createTray();
        tray?.setToolTip(`Nightshift Hub :${port}`);
        // Keep the process alive with no windows.
        app.dock?.hide?.();
        return;
      }

      // This computer's server always runs: it is the "本机" machine, and
      // switching back to it must be instant.
      if (DEV_URL) {
        console.log('[desk] dev mode, loading', DEV_URL);
      } else {
        await prepareHome();
        const port = await startServer();
        console.log(`[desk] server ready on http://127.0.0.1:${port}/ (home: ${HOME})`);
      }

      // Reopen the machine used last time. If it does not answer (the VM is
      // asleep), start on this computer; the machine list still has it.
      const candidate = normalizeHub(process.env.DESK_HUB_URL || '') || readHub();
      if (candidate && !DEV_URL && await probeHub(candidate)) {
        remoteHub = candidate;
        rememberMachine(candidate);
        bootLog(`remote → ${candidate}`);
      } else if (candidate) {
        bootLog(`hub unreachable → local (${candidate})`);
      }
      createWindowFor(DEV_URL || remoteHub || localUrl());
      createTray();
    } catch (err) {
      dialog.showErrorBox(L('夜班启动失败', 'Nightshift failed to start'), String(err?.stack || err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    // keep running in the tray on Windows/Linux; macOS hides anyway
    if (process.platform === 'darwin') return;
    if (!tray) app.quit();
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('will-quit', () => {
    if (child && !child.killed) {
      try { child.kill(); } catch { /* already gone */ }
    }
  });

  app.on('activate', showWindow);
}
