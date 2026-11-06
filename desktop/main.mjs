/**
 * Desk desktop shell.
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
import { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const DEV_URL = process.env.ASSIST_DEV_URL || '';

let win = null;
let tray = null;
let child = null;
let quitting = false;
let serverPort = 0;
/** When set, this window is a client of a remote hub instead of a local server. */
let remoteHub = '';

// ---------------------------------------------------------------------------
// hub config
// ---------------------------------------------------------------------------

const HUB_FILE = path.join(app.getPath('userData'), 'hub.json');

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
  fs.mkdirSync(path.dirname(HUB_FILE), { recursive: true });
  fs.writeFileSync(HUB_FILE, `${JSON.stringify({ url, ts: new Date().toISOString() }, null, 2)}\n`);
}

function clearHub() {
  try { fs.unlinkSync(HUB_FILE); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// machines: every hub is its own world (own bots, memory, workspace). This
// list is just a shortcut so switching does not mean typing an address again.
// ---------------------------------------------------------------------------

const MACHINES_FILE = path.join(app.getPath('userData'), 'machines.json');

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

/** Remember a hub we successfully talked to, newest first. */
function rememberMachine(url) {
  const norm = normalizeHub(url);
  if (!norm) return;
  const list = readMachines().filter((m) => m.url !== norm);
  let name = norm;
  try { name = new URL(norm).hostname; } catch { /* keep url */ }
  list.unshift({ url: norm, name, lastUsed: new Date().toISOString() });
  writeMachines(list.slice(0, 20));
  return list;
}

/** Native picker: each machine keeps its own bots, so this is the switcher. */
async function pickMachine() {
  const list = readMachines();
  const buttons = [
    ...list.map((m) => `${m.name === remoteHub ? '● ' : ''}${m.name}`),
    '添加新机器…',
    '取消',
  ];
  const { response } = await dialog.showMessageBox(win || undefined, {
    type: 'question',
    title: '切换机器',
    message: '选择要连接的机器',
    detail: '每台机器有自己的一套 Bot、记忆和工作区。切换后窗口会重新加载为该机器的界面，不会混在一起。',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (response === buttons.length - 1) return;
  if (response === buttons.length - 2) {
    await switchHub();
    return;
  }
  const target = list[response];
  if (!target || target.url === remoteHub) return;
  writeHub(target.url);
  rememberMachine(target.url);
  app.relaunch();
  app.exit(0);
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

function askForHub(current) {
  return new Promise((resolve) => {
    const modal = new BrowserWindow({
      width: 460,
      height: 268,
      resizable: false,
      minimizable: false,
      maximizable: false,
      parent: win || undefined,
      modal: Boolean(win),
      show: false,
      title: '连接到 Desk Hub',
      backgroundColor: '#0b0d12',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('desk:set-hub');
      ipcMain.removeHandler('desk:current-hub');
      ipcMain.removeHandler('desk:use-local');
      if (!modal.isDestroyed()) modal.destroy();
      resolve(value);
    };

    ipcMain.handle('desk:current-hub', () => current || '');
    ipcMain.handle('desk:use-local', () => { finish({ mode: 'local' }); return { ok: true }; });
    ipcMain.handle('desk:set-hub', async (_e, url) => {
      const normalized = normalizeHub(url);
      if (!normalized) return { ok: false, error: '地址格式不对，例如 http://192.168.1.20:4390' };
      const alive = await probeHub(normalized);
      if (!alive) return { ok: false, error: `连不上 ${normalized}（检查地址、防火墙、ASSIST_ALLOW_REMOTE=1）` };
      writeHub(normalized);
      finish({ mode: 'remote', url: normalized });
      return { ok: true };
    });

    modal.once('ready-to-show', () => modal.show());
    modal.loadFile(path.join(__dirname, 'connect.html'));
    modal.on('closed', () => finish({ mode: 'local' }));
  });
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

function startServer({ host = '127.0.0.1' } = {}) {
  const entry = path.join(SERVER_DIR, 'src', 'server.mjs');
  if (!fs.existsSync(entry)) throw new Error(`server entry missing: ${entry}`);

  child = spawn(process.execPath, [entry], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ASSIST_HOME: HOME,
      PORT: process.env.PORT || '0',
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
      console.error(`[server] exited code=${code} signal=${signal}`);
      if (win && !win.isDestroyed()) {
        dialog.showErrorBox('Desk 的后台进程退出了', `退出码 ${code ?? signal}。重新打开 Desk 即可恢复；数据在：\n${HOME}`);
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
    title: remoteHub ? `Desk — ${remoteHub.replace(/^https?:\/\//, '')}` : 'Desk',
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

function createWindow(port) {
  return createWindowFor(`http://127.0.0.1:${port}/`);
}

function showWindow() {
  if (!win) {
    if (remoteHub) createWindowFor(remoteHub);
    else if (serverPort) createWindow(serverPort);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Menu action: pick a hub, or come back to this machine. Relaunches cleanly so
 *  the child process / window lifecycle stays simple. */
async function switchHub() {
  const choice = await askForHub(remoteHub || readHub());
  if (!choice || choice.mode === 'remote' && choice.url === remoteHub) return;
  if (choice.mode === 'local') {
    if (!remoteHub) return;
    clearHub();
    app.relaunch();
    app.exit(0);
    return;
  }
  app.relaunch();
  app.exit(0);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(remoteHub ? `Desk → ${remoteHub}` : 'Desk');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Desk', click: showWindow },
    { label: remoteHub ? `已连接：${remoteHub}` : '本机模式', enabled: false },
    { type: 'separator' },
    { label: '切换到别的 Hub…', click: switchHub },
    { label: '打开数据目录', click: () => shell.openPath(HOME) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showWindow);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Desk',
      submenu: [
        { label: '机器…', click: pickMachine },
        { label: '切换到别的 Hub…', click: switchHub },
        ...(remoteHub ? [{ label: '回到本机模式', click: async () => { clearHub(); app.relaunch(); app.exit(0); } }] : []),
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(HOME) },
        { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { label: '编辑', role: 'editMenu' },
    {
      label: '视图',
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

// The UI asks for the machine picker so "切换机器" is one click from the panel.
ipcMain.handle('desk:pick-machine', async () => {
  await pickMachine();
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
        tray?.setToolTip(`Desk Hub :${port}`);
        // Keep the process alive with no windows.
        app.dock?.hide?.();
        return;
      }

      // A hub is either explicitly requested (env) or remembered from last time.
      // If it does not answer we ASK. Silently falling back to a local instance
      // is how a bot ends up opening the laptop's Chrome while the human thinks
      // they are driving the VM — the two machines are not interchangeable.
      const candidate = normalizeHub(process.env.DESK_HUB_URL || '') || readHub();
      if (candidate && !DEV_URL) {
        let reachable = await probeHub(candidate);
        for (let attempt = 0; !reachable && attempt < 2; attempt += 1) {
          await new Promise((r) => setTimeout(r, 1500));
          reachable = await probeHub(candidate);
        }
        if (reachable) {
          remoteHub = candidate;
          rememberMachine(candidate);
          bootLog(`remote mode → ${candidate}`);
          console.log(`[desk] remote mode → ${candidate}`);
          buildMenu();
          createWindowFor(candidate);
          createTray();
          return;
        }
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          title: '连不上这台机器',
          message: `连不上 ${candidate}`,
          detail:
            'Desk 不会自动改成本机模式——那样 Bot 会跑到这台电脑上运行，而不是你选的那台机器。\n\n'
            + '· 重试：再试一次连接（建议先确认那台机器开着、Hub 服务在跑）\n'
            + '· 用本机模式：明确使用这台电脑上的 Bot 和浏览器\n'
            + '· 退出：先不管',
          buttons: ['重试', '用本机模式', '退出'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (response === 2) {
          app.quit();
          return;
        }
        if (response === 0) {
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt += 1) ok = await probeHub(candidate);
          if (ok) {
            remoteHub = candidate;
            rememberMachine(candidate);
            bootLog(`remote mode → ${candidate} (after retry)`);
            console.log(`[desk] remote mode → ${candidate} (after retry)`);
            buildMenu();
            createWindowFor(candidate);
            createTray();
            return;
          }
          dialog.showErrorBox('还是连不上', `连不上 ${candidate}。\n\n先启动那台机器上的 Hub（desk-hub 服务），再重新打开 Desk。`);
          app.quit();
          return;
        }
        // Explicit "use this machine": drop the hub for this run only.
        console.warn(`[desk] user chose local mode; hub ${candidate} will be retried next launch`);
      }

      let port;
      if (DEV_URL) {
        port = 0;
        console.log('[desk] dev mode, loading', DEV_URL);
      } else {
        bootLog(`local mode (no hub configured)`);
        await prepareHome();
        port = await startServer();
        console.log(`[desk] server ready on http://127.0.0.1:${port}/ (home: ${HOME})`);
      }
      buildMenu();
      createWindow(port);
      createTray();
      if (DEV_URL) win.loadURL(DEV_URL);
    } catch (err) {
      dialog.showErrorBox('Desk 启动失败', String(err?.stack || err));
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
