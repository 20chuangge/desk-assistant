/* launcher.js — the Desk mobile shell (launchpad).
 *
 * Job: remember which Desk hub this phone talks to, check that it answers, and
 * then open the hub's own UI at the top level of the WebView.
 *
 * Two decisions worth knowing about:
 *
 * 1. Top-level navigation, not an iframe. The hub authenticates a phone with an
 *    HttpOnly SameSite=Lax cookie (`desk_session`, set by POST /api/pair). A
 *    cross-site iframe never sends that cookie (the top-level site would be
 *    `localhost`, the frame `192.168.x.x`), so the UI inside a frame would sit
 *    on its pairing screen forever. A top-level navigation is first-party: same
 *    cookie rules as the desktop browser, and the hub needs no CORS support.
 *
 * 2. No token in Preferences. The session token is HttpOnly — page script can
 *    never read it, and the hub sends no CORS headers, so this launchpad cannot
 *    hold it either. What it stores is the hub URL; the hub's own pairing screen
 *    owns the credential. Typing the pairing code here just deep-links to
 *    `/?pair=CODE`, which the hub's UI consumes first-party.
 *
 * No bundler, no imports: native Capacitor injects `window.Capacitor.Plugins`,
 * and a plain-browser preview of www/ falls back to localStorage.
 */
(() => {
  'use strict';

  const KEYS = { hub: 'desk.hubUrl' };
  const PROBE_TIMEOUT_MS = 4500;

  const $ = (id) => document.getElementById(id);
  const dom = {
    screens: {
      connect: $('connect'),
      connected: $('connected'),
      booting: $('booting'),
      offline: $('offline'),
    },
    connectForm: $('connect-form'),
    connectError: $('connect-error'),
    connectBtn: $('connect-btn'),
    hubUrl: $('hub-url'),
    hubCode: $('hub-code'),
    pasteBtn: $('paste-btn'),
    previewBtn: $('preview-btn'),
    currentHub: $('current-hub'),
    currentStatus: $('current-status'),
    shellVersion: $('shell-version'),
    openBtn: $('open-btn'),
    changeBtn: $('change-btn'),
    forgetBtn: $('forget-btn'),
    bootingText: $('booting-text'),
    bootingUrl: $('booting-url'),
    bootingCancel: $('booting-cancel'),
    offlineDetail: $('offline-detail'),
    offlineUrl: $('offline-url'),
    offlineRetry: $('offline-retry'),
    offlineChange: $('offline-change'),
    foot: $('foot'),
  };

  // ---------------------------------------------------------------- platform
  const cap = window.Capacitor || null;
  const plugins = (cap && cap.Plugins) || {};
  const prefs = plugins.Preferences || null;
  const app = plugins.App || null;
  const isNative = Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

  /** @capacitor/preferences on device, localStorage when previewing in a browser. */
  const store = {
    async get(key) {
      if (prefs) {
        try {
          const res = await prefs.get({ key });
          if (res && typeof res.value === 'string') return res.value;
        } catch (err) {
          console.warn('[desk] Preferences.get failed, falling back', err);
        }
      }
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (prefs) {
        try {
          await prefs.set({ key, value });
          return;
        } catch (err) {
          console.warn('[desk] Preferences.set failed, falling back', err);
        }
      }
      try {
        window.localStorage.setItem(key, value);
      } catch (err) {
        console.warn('[desk] localStorage unavailable', err);
      }
    },
    async remove(key) {
      if (prefs) {
        try {
          await prefs.remove({ key });
        } catch (err) {
          console.warn('[desk] Preferences.remove failed', err);
        }
      }
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  // ------------------------------------------------------------------- state
  const state = {
    view: 'connect',
    hub: '',
    info: null,
    probeId: 0,
  };

  function show(view) {
    state.view = view;
    for (const [name, node] of Object.entries(dom.screens)) node.hidden = name !== view;
  }

  function setError(message) {
    if (!message) {
      dom.connectError.textContent = '';
      dom.connectError.classList.remove('show');
      return;
    }
    dom.connectError.textContent = message;
    dom.connectError.classList.add('show');
  }

  // ------------------------------------------------------------------- utils
  /** "192.168.1.23:4390" -> "http://192.168.1.23:4390"; validates scheme + path. */
  function normalizeHub(raw) {
    let text = String(raw || '').trim();
    if (!text) throw new Error('先填 Hub 地址。');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`"${raw}" 不是合法地址。示例：http://192.168.1.23:4390`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('只支持 http:// 或 https:// 的 Hub。');
    }
    if (!url.hostname) throw new Error('这个地址里没有主机名。');

    // The Desk UI calls absolute paths (`/api/health`, `/api/stream`, ...), so a
    // hub behind a path prefix cannot work. Fail loudly rather than half-work.
    if (url.pathname.replace(/\/+$/, '')) {
      throw new Error('请填 Hub 根地址、不要带路径，例如 http://192.168.1.23:4390');
    }
    return url.origin;
  }

  function hubUrlFor(hub, code) {
    if (!code) return `${hub}/`;
    return `${hub}/?pair=${encodeURIComponent(String(code).replace(/\s+/g, ''))}`;
  }

  /**
   * Reachability probe. `no-cors` is deliberate: the hub sends no CORS headers,
   * so a normal fetch could never read a response. An opaque fetch still proves
   * a live HTTP listener, which is all "is it up?" needs. /api/auth is used
   * because it is the one API path that answers without a credential.
   */
  async function probe(hub) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(`${hub}/api/auth`, {
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadInfo() {
    try {
      const res = await fetch('shell-info.json', { cache: 'no-store' });
      if (res.ok) state.info = await res.json();
    } catch {
      state.info = null;
    }
    return state.info;
  }

  function shellLabel() {
    const info = state.info;
    if (!info) return '未知';
    const when = String(info.builtAt || '').replace('T', ' ').replace(/\..*$/, '');
    return `v${info.shellVersion} · ${when} UTC`;
  }

  function setStatus(text, tone) {
    dom.currentStatus.textContent = text;
    dom.currentStatus.className = `pill${tone === 'warn' ? ' warn' : ''}`;
  }

  // ---------------------------------------------------------------- screens
  function showConnect(prefill) {
    setError('');
    dom.hubUrl.value = prefill !== undefined ? prefill : state.hub || '';
    dom.hubCode.value = '';
    show('connect');
    if (!prefill && !state.hub) dom.hubUrl.focus();
  }

  function showConnected() {
    dom.currentHub.textContent = state.hub || '—';
    dom.shellVersion.textContent = shellLabel();
    setStatus('检测中…', 'warn');
    show('connected');
    void refreshStatus();
  }

  function showOffline(reason) {
    dom.offlineDetail.textContent =
      reason || 'Hub 没有响应。App 本身没问题，只是看不见你那台电脑。';
    dom.offlineUrl.textContent = state.hub || '—';
    show('offline');
  }

  /** Ask the hub whether it is there, and update the pill without blocking the UI. */
  async function refreshStatus() {
    const id = ++state.probeId;
    const hub = state.hub;
    if (!hub) return;
    const up = await probe(hub);
    if (id !== state.probeId || state.view !== 'connected') return;
    setStatus(up ? '在线' : '连不上', up ? 'ok' : 'warn');
  }

  // ------------------------------------------------------------------ actions
  /** Leave the shell and show the hub's own UI (first-party, cookie-friendly). */
  async function openHub(hub, code) {
    show('booting');
    dom.bootingText.textContent = code ? '正在配对并打开…' : '正在打开 Desk…';
    dom.bootingUrl.textContent = hub;
    state.hub = hub;
    const up = await probe(hub);
    if (state.view !== 'booting') return; // user cancelled
    if (!up) {
      showOffline(`${hub} 没有响应。`);
      return;
    }
    // location.assign keeps this launchpad in history for the Android back patch.
    window.location.assign(hubUrlFor(hub, code));
  }

  async function connectFromForm() {
    setError('');
    let hub;
    try {
      hub = normalizeHub(dom.hubUrl.value);
    } catch (err) {
      setError(err.message);
      return;
    }
    const code = dom.hubCode.value.trim();
    dom.connectBtn.disabled = true;
    dom.connectBtn.textContent = '连接中…';
    try {
      const up = await probe(hub);
      if (!up) {
        state.hub = hub;
        showOffline(
          `${hub} 没有响应。\n确认那边 Desk 是用 ASSIST_ALLOW_REMOTE=1 HOST=0.0.0.0 起的，` +
            '手机和电脑在同一个网络，防火墙放行了这个端口。',
        );
        return;
      }
      await store.set(KEYS.hub, hub);
      dom.hubCode.value = '';
      await openHub(hub, code);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      dom.connectBtn.disabled = false;
      dom.connectBtn.textContent = '连接并打开';
    }
  }

  // ------------------------------------------------------------------- wiring
  dom.connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void connectFromForm();
  });

  dom.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        dom.hubUrl.value = text.trim();
        setError('');
      }
    } catch {
      dom.hubUrl.focus();
    }
  });

  dom.previewBtn.addEventListener('click', () => {
    // The bundled copy of public/ (www/ui). No hub, so no data — it is there to
    // prove what the shell packaged, not to be useful.
    window.location.assign('ui/index.html');
  });

  dom.openBtn.addEventListener('click', () => {
    if (state.hub) void openHub(state.hub, '');
  });

  dom.changeBtn.addEventListener('click', () => showConnect(state.hub));
  dom.forgetBtn.addEventListener('click', async () => {
    await store.remove(KEYS.hub);
    state.hub = '';
    dom.connectForm.reset();
    showConnect('');
  });

  dom.bootingCancel.addEventListener('click', () => {
    if (state.hub) showConnected();
    else showConnect('');
  });

  dom.offlineRetry.addEventListener('click', () => {
    if (state.hub) void openHub(state.hub, '');
    else showConnect('');
  });
  dom.offlineChange.addEventListener('click', () => showConnect(state.hub));

  // -------------------------------------------------------------------- boot
  async function boot() {
    await loadInfo();
    dom.foot.textContent = `Desk mobile shell · ${shellLabel()}${isNative ? '' : ' · web preview'}`;

    const hub = await store.get(KEYS.hub);
    if (hub) {
      try {
        state.hub = normalizeHub(hub);
      } catch {
        state.hub = '';
      }
    }
    if (state.hub) {
      showConnected();
      return;
    }
    showConnect('');
  }

  // The app came back to the foreground and the launchpad is showing: re-check.
  if (app && typeof app.addListener === 'function') {
    app.addListener('appStateChange', ({ isActive }) => {
      if (isActive && state.view === 'connected') void refreshStatus();
    });
  }

  boot().catch((err) => {
    console.error('[desk] boot failed', err);
    showConnect('');
    setError(`外壳启动失败：${err && err.message ? err.message : err}`);
  });

  // Exposed for `npm run check:shell` and for `chrome://inspect` on a device.
  window.__deskShell = {
    isNative,
    plugins: Object.keys(plugins),
    normalizeHub,
    state: () => ({ view: state.view, hub: state.hub, info: state.info }),
  };
})();
