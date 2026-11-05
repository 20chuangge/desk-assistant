# The browser: how the bot drives a real Chrome

The product is "an assistant that lives on another machine". That machine is an
idle PC in the corner or a cloud VM; you talk to the bot from your laptop or
phone. For that to be more than a chat window, the bot needs to be able to *use*
that machine — and the most useful thing it can use is a browser: open a page,
sign in, fill a form, download the invoice.

`src/browser.mjs` implements that. It keeps **one Chromium process alive** with a
**persistent profile** and drives it over the **DevTools Protocol (CDP)**. No
Playwright, no Puppeteer, no npm packages: Node's global `WebSocket` is the whole
transport.

```
agent turn
   │
   ├── browser_open      → Page.navigate, wait for readyState + network idle
   ├── browser_snapshot  → Runtime.evaluate: text + interactive elements with @eN refs
   ├── browser_click     → Input.dispatchMouseEvent at the element centre
   ├── browser_type      → focus, clear, Input.insertText, optional Enter
   ├── browser_screenshot→ Page.captureScreenshot → workspace/artifacts/<ts>.png
   ├── browser_download  → Browser.setDownloadBehavior → workspace/downloads/<file>
   ├── browser_eval      → Runtime.evaluate (HIGH risk, always asks a human)
   ├── browser_close     → Browser.close
   └── browser_status    → running / pid / profile / cdp url / detected executable
```

---

## Requirements

| Platform | What you need |
| --- | --- |
| Windows | Google Chrome, or Microsoft Edge. Auto-detected. |
| macOS | Chrome or Edge in `/Applications`. Auto-detected. |
| Linux VM (headless) | `google-chrome` / `chromium` installed, **plus** `BROWSER_HEADLESS=1` (or `xvfb-run` if you want the windowed default). |
| Node | **>= 22** for the global `WebSocket`. On Node 20 the browser tools return `{code:"unsupported"}` and everything else keeps working. |

Nothing is installed by this project. If no browser exists, every browser tool
returns a structured `not_configured` error with an install hint — it never
crashes a turn.

### How the executable is found

1. `CHROME_PATH`, if set. **A set-but-missing `CHROME_PATH` is an error**, not a
   silent fallback — that catches typos instead of driving the wrong binary.
2. `C:\Program Files\Google\Chrome\Application\chrome.exe`
3. `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
4. `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`
5. Linux/macOS locations (`/usr/bin/google-chrome`, `/usr/bin/chromium`,
   `/snap/bin/chromium`, `/Applications/Google Chrome.app/...`, …)

Edge is Chromium, so it speaks the same protocol.

---

## Launch flags and the profile

```
--remote-debugging-port=<free port>
--user-data-dir=<data>/browser-profile
--no-first-run --no-default-browser-check
--disable-blink-features=AutomationControlled
--disable-dev-shm-usage --no-service-autorun --disable-features=Translate,MediaRouter
about:blank
```

* **Windowed by default.** The point is that you can watch the bot work. Set
  `BROWSER_HEADLESS=1` to add `--headless=new --disable-gpu --hide-scrollbars`.
* **`--user-data-dir=<data>/browser-profile`** is the "signed-in browser". It
  survives restarts, so a session you logged into once is still there tomorrow.
  It is also the thing to delete to reset the browser.
* **`--disable-blink-features=AutomationControlled`** stops
  `navigator.webdriver === true`, which is the cheapest bot signal. It does not
  make the bot invisible — see *Honest limits*.
* The port is chosen from a free port, then written to `data/browser-state.json`.
  After a server restart the manager **reconnects to the browser that is still
  running** instead of launching a second Chrome onto a locked profile.

---

## Tool reference

| Tool | Risk | Arguments | Returns |
| --- | --- | --- | --- |
| `browser_open` | LOW | `{url}` | `{ok, title, url, browser:{executable,pid,headless,adopted,profile}}` |
| `browser_snapshot` | LOW | `{}` | `{ok, title, url, text, textLength, textTruncated, elements[{ref,tag,role,name,visible,disabled,type}], elementCount}` |
| `browser_click` | MEDIUM | `{ref}` or `{selector}` | `{ok, clicked:{tag,name,x,y}, url, title}` |
| `browser_type` | MEDIUM | `{ref\|selector, text, submit?}` | `{ok, typed, value, matched, submitted, url}` |
| `browser_screenshot` | LOW | `{path?}` | `{ok, path, absolutePath, bytes, format, viewport}` |
| `browser_download` | MEDIUM | `{url, path?}` | `{ok, path, absolutePath, filename, bytes, url, downloadsDir}` |
| `browser_eval` | HIGH | `{expression}` | `{ok, value, type}` |
| `browser_close` | LOW | `{}` | `{ok, closed, pid}` |
| `browser_status` | LOW | `{}` | `{running, pid, profileDir, cdpUrl, headless, adopted, executable, detectedBy, supported, pageUrl}` |

There is **one page for the whole process**, and it is reused across calls and
across turns. That is what lets a turn take a snapshot and then click a ref from
it.

### Grants

The browser is one capability, not nine. A bot granted `browser_open` also gets
`browser_snapshot`, `browser_click`, … (implemented in `registry.isGranted`).
Each action still carries its own risk, so MEDIUM/HIGH calls stop for a human
exactly as the approval boundary describes — a bot cannot escalate by using a
different browser tool.

Out of the box only **Researcher** is granted `browser_open`, so the other bots
answer `TOOL_NOT_GRANTED`. Add `browser_open` to a bot's `tools[]` in
`config/bots/<id>.json` to give it a browser too.

---

## The snapshot → act → snapshot loop

`browser_snapshot` is the model's eyes. It returns the page text (scripts,
styles, svg and iframes stripped; capped at 8000 characters) and every visible
interactive element with a short, stable ref:

```json
{
  "title": "Invoice portal",
  "url": "http://127.0.0.1:42874/",
  "text": "Invoice portal\n\nSign in to download this month's invoice.\n\nSign in\n\nsigned out\n\nDownload invoice",
  "elements": [
    { "ref": "@e1", "tag": "input",  "role": "textbox", "name": "Work email",     "visible": true, "disabled": false },
    { "ref": "@e2", "tag": "button", "role": "button",  "name": "Sign in",        "visible": true, "disabled": false },
    { "ref": "@e3", "tag": "a",      "role": "link",    "name": "Download invoice","visible": true, "disabled": false }
  ],
  "elementCount": 3
}
```

The model then calls `browser_type({ref:"@e1", text:"sam@example.com"})` and
`browser_click({ref:"@e2"})`, and takes another snapshot to see the result.

### Ref semantics

* Refs are indices into a registry (`window.__assistRefs`) that lives **in the
  page**.
* Within one document the registry survives across snapshots, so a ref taken
  earlier keeps working as long as its element is still attached.
* After a navigation the registry is gone, and every old ref fails with
  `STALE_REF` and the message *"run browser_snapshot again"*. A removed element
  fails the same way. The error is a normal tool result — the turn continues and
  the model can recover.
* Refs are deliberately opaque. `@e3` means "the third element this session
  registered", not "the third element on the page".

### Waiting after an action

Both `click` and `type` wait for `document.readyState === 'complete'` and then
for the network to go quiet (no in-flight requests for 250 ms), each capped
(12 s / 8 s for navigation, 6 s / 6 s after an action). SPA sites that long-poll
therefore cannot hang a turn; the cap just expires and the snapshot shows
whatever is on screen.

---

## Downloads

`browser_download({url})`:

1. points the browser's download directory at `<workspace>/downloads`
   (`Browser.setDownloadBehavior`, falling back to `Page.setDownloadBehavior`);
2. navigates to the URL — Chrome reports `ERR_ABORTED` for the navigation, which
   is the success signal for a download;
3. tracks the download through `Browser.downloadWillBegin` /
   `Browser.downloadProgress` so it knows the exact filename and the moment the
   file is complete;
4. locates the file (exact name → `name (1).ext` variant → overwritten-in-place →
   newest non-HTML file), waits for the size to stop changing, and optionally
   moves it to the `path` you asked for.

Chrome drops its own `downloads.htm` artefact into the folder while a download is
in flight; the name-first lookup exists precisely so that file is never mistaken
for the bot's download.

Everything lands inside the workspace (`downloads/`), and a `path` outside it is
refused with `DOWNLOAD_PATH_OUTSIDE`.

## Screenshots

`browser_screenshot` writes a PNG to `workspace/artifacts/<timestamp>.png` (or a
workspace-relative path you pass) and returns the relative path, byte count and
viewport. A path that escapes the workspace is refused with
`SCREENSHOT_PATH_OUTSIDE`. This is how the bot shows you what it is looking at
when you are on your phone.

---

## Security posture

* **URL policy**: `browser_open` and `browser_download` reject loopback and
  private ranges (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `::1`, `fc00::/7`, single-label hostnames) unless `ALLOW_PRIVATE=1`. The
  browser would otherwise be a way around the same guard `http_fetch` applies.
* **`browser_eval` is HIGH risk** and always stops for a human approval. It runs
  with the profile's session, so it is the sharpest tool in the box.
* **Artifacts are confined** to `workspace/artifacts` and `workspace/downloads`.
* The browser listens on `127.0.0.1` only.

---

## Running it on a headless VM (the "other machine" story)

```bash
# On the VM
export BROWSER_HEADLESS=1          # no X server needed
export ALLOW_PRIVATE=1             # only if the bot must reach LAN hostnames
node src/server.mjs                # the assistant, and its browser, live here
```

The windowed default needs a display. On a VM without one, Chrome fails to start
and `browser_open` returns `browser_launch_failed` with Chrome's own stderr tail
in the message. Two ways out:

* `BROWSER_HEADLESS=1` — screenshots via `browser_screenshot` become your view.
* `xvfb-run -a node src/server.mjs` — keeps the windowed code path alive on a
  virtual display (useful when a site behaves differently headless).

To watch a headless VM from your laptop, use the screenshot tool (the desktop
app renders it inline) or VNC into the VM.

---

## Honest limits

What still fails on real sites, in rough order of how often it bites:

1. **Bot detection.** `AutomationControlled` is disabled, but Cloudflare,
   hCaptcha and friends look at far more than `navigator.webdriver`: TLS
   fingerprint, mouse paths, timing, IP reputation. Expect challenges on
   aggressive sites. The approval boundary does not help here — it is a site
   policy problem.
2. **Shadow DOM and iframes.** The snapshot walks the light DOM of the main
   document only. Elements inside a `#shadow-root` or inside an `<iframe>` are
   invisible to it (you can still reach them with `browser_eval` +
   `querySelector` on the frame, but not by ref).
3. **New tabs.** A `target="_blank"` link opens a *new* page target; this build
   stays on the page it is driving and does not adopt the popup. Navigate
   directly to the URL instead.
4. **Native dialogs.** `alert`/`confirm`/`beforeunload` are not auto-dismissed.
   An open dialog blocks page JS, so a subsequent click may appear to do
   nothing. `browser_eval` still works; close the dialog and carry on.
5. **File uploads.** There is no `Input.setFileInputFiles` tool yet, so a form
   with `<input type="file">` cannot be completed. (Only visible interactables
   are clickable; the picker is a native dialog.)
6. **Downloads triggered by a click.** `browser_download` tracks the first
   download that starts after *it* navigates. A download triggered by an earlier
   click still lands in `workspace/downloads`, but the tool does not wait for it
   or report its path.
7. **Auth walls.** Nothing here solves a login you cannot do: no OTP reader, no
   password manager integration. Log in once by hand (windowed mode, or VNC) and
   the profile remembers it.
8. **One page.** No multi-tab orchestration, no parallel page contexts, no
   per-turn isolation. Two bots share the same page; a turn that navigates
   changes what the next turn sees (that is intentional — it is one shared
   computer — but it is also a source of surprises).
9. **`browser_eval` returns JSON only.** DOM nodes, functions and circular
   structures come back as `{}` or `null`; stringify them in the expression.
10. **Local-only today.** The CDP port is bound to `127.0.0.1`, so the browser
    must be on the same machine as the server. Driving a *remote* browser would
    need the port exposed over an SSH tunnel or a small relay — out of scope for
    this task.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `not_configured` | No Chromium found. Install Chrome/Edge or set `CHROME_PATH`. The error lists the paths it checked. |
| `unsupported` | Node < 22 (no global `WebSocket`). Use Node 22+, or the desktop app's bundled runtime. |
| `browser_launch_failed` | Chrome started but never opened a debugging port — usually the profile is locked by another Chrome window, or a headless VM has no display. Close the stray window, delete `data/browser-profile`, or set `BROWSER_HEADLESS=1`. |
| `CDP_TIMEOUT` | The page is stuck (heavy JS, blocked network). Retry; `browser_snapshot` shows the current state. |
| `STALE_REF` | The page changed or navigated. Take a new snapshot. |
| `ELEMENT_NOT_VISIBLE` | The element has no layout box (`display:none`, zero size). It is not in the snapshot for the same reason. |
| `PRIVATE_HOST_BLOCKED` | Loopback/LAN URL. Set `ALLOW_PRIVATE=1` for LAN use. |
| `DOWNLOAD_TIMEOUT` | The response was not an attachment, or the site streamed it through JS. Check `workspace/downloads`. |

---

## Tests

`npm run smoke` starts a local HTTP page, launches a real (headless) Chrome and
asserts 40 browser-specific things: tool registration + risk levels, launch flags
(windowed default, `BROWSER_HEADLESS`, profile path), executable auto-detection,
`browser_open` title/url/pid, snapshot text/elements/hidden-element filtering,
script-content stripping, `click` changing the DOM, `type` landing in the DOM by
ref and by selector, screenshot PNG magic bytes and path confinement, download
bytes matching the served payload plus an explicit destination path, `STALE_REF`
after navigation, status/close, the `unsupported` path, and `not_configured` when
no browser is installed.

The browser stage runs headless so it does not throw windows over your desktop.
