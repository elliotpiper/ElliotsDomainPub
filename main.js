/* Elliot's Domain - Electron shell.
 *
 * Why Electron: every target refuses to be framed in a page (claude.ai and
 * Atlassian send frame-ancestors without localhost, Confluence and SharePoint
 * send X-Frame-Options: DENY, Figma sends SAMEORIGIN), and Chromium dropped
 * --load-extension at 137 so the headers cannot be stripped either. A
 * WebContentsView loads its page as a top-level WebContents, which those
 * headers do not apply to - so the preview really is inside this window,
 * clipped and composited with it, with no second OS window involved.
 *
 * The renderer may only ever send a NODE ID from the table below, plus panel
 * geometry. It can never pass a URL, path or command.
 */

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const chatIpc = require('./chat/ipc');
const { manager } = require('./chat/session');

const ROOT = __dirname;
const PARTITION = 'persist:domain';
const WARM_LIMIT = 6;              // four slots can be full at once; evict LRU beyond that

/* The six targets are placeholders in this public copy. Point each `preview`
 * at your own page; `external` is what Ctrl+click opens instead. Both must be
 * absolute URLs on a host the allowlist in `isSignIn` and `openExternal`
 * accepts, or a custom scheme the OS knows (see `excel` below). */

const EXCEL_SHEET = 'https://example.com/your-spreadsheet';

const NODES = {
  'jira-board': {
    preview: 'https://example.com/your-board',
    external: 'https://example.com/your-board',
  },
  'jira-wd': {
    preview: 'https://example.atlassian.net/jira/dashboards/00000',
    external: 'https://example.atlassian.net/jira/dashboards/00000',
  },
  confluence: {
    preview: 'https://example.atlassian.net/wiki/spaces/SPEC/overview',
    external: 'https://example.atlassian.net/wiki/spaces/SPEC/overview',
  },
  excel: {
    preview: EXCEL_SHEET,                       // Excel for the web, in the panel
    external: 'ms-excel:ofe|u|' + EXCEL_SHEET,  // Ctrl+click -> desktop Excel
  },
  figma: {
    preview: 'https://www.figma.com/files/team/000000000000000000/drafts',
    external: 'https://www.figma.com/files/team/000000000000000000/drafts',
  },
  // Not a web page: a real Claude Code conversation, rendered by chat/chat.html
  // and driven by the SDK in chat/session.js. Ctrl+click still opens the app.
  terminal: { chat: true },
};

let win = null;
const views = new Map();       // node id -> { view, ready, error }
const order = [];              // node ids, most recently shown last
const shown = new Set();       // node ids currently occupying a slot
const bounds = new Map();      // node id -> its slot rect, in CSS px

/* ------------------------------------------------------------------ helpers */

// Identity providers reject "embedded browsers" by sniffing the UA. Electron's
// default carries both the app name and Electron/<version>; strip them so the
// Microsoft and Atlassian sign-in pages treat this as ordinary Chrome.
function chromeUA(ua) {
  return ua.replace(/ElliotsDomain\/[\d.]+ /i, '').replace(/Electron\/[\d.]+ /i, '');
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* Panel geometry. The renderer measures .pbody in CSS pixels; Electron view
   bounds are in the window's DIP coordinate space, which is the same thing. */
// Clamp to the content area: a rect from a mid-animation frame, or from a
// window being resized smaller, can otherwise ask for a view outside the window.
function sanitize(b) {
  const c = win.getContentBounds();
  const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const x = Math.min(n(b.x), Math.max(c.width - 1, 0));
  const y = Math.min(n(b.y), Math.max(c.height - 1, 0));
  return {
    x, y,
    width: Math.max(1, Math.min(n(b.w), c.width - x)),
    height: Math.max(1, Math.min(n(b.h), c.height - y)),
  };
}

function applyBounds() {
  if (!win || win.isDestroyed()) return;
  for (const id of shown) {
    const entry = views.get(id);
    const rect = bounds.get(id);
    if (!entry || !entry.attached || !rect) continue;
    entry.view.setBounds(sanitize(rect));
  }
}

function detach(id) {
  const entry = views.get(id);
  if (!entry || !win || win.isDestroyed()) return;
  try { win.contentView.removeChildView(entry.view); } catch (_) {}
  entry.attached = false;
}

function destroyView(id) {
  const entry = views.get(id);
  if (!entry) return;
  detach(id);
  try { entry.view.webContents.close(); } catch (_) {}
  views.delete(id);
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
}

function touch(id) {
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  order.push(id);
  while (order.length > WARM_LIMIT) {
    const victim = order[0];
    if (shown.has(victim) || (NODES[victim] && NODES[victim].chat)) break;
    destroyView(victim);
  }
}

// Sign-in bounces across these hosts and often needs a popup; anything else
// that tries to open a window is an ordinary link and belongs in the browser.
const AUTH_HOSTS =
  /^https:\/\/([a-z0-9-]+\.)*(microsoftonline\.com|login\.live\.com|atlassian\.(com|net)|okta\.com|accounts\.google\.com|figma\.com|claude\.ai|anthropic\.com|sharepoint\.com|office\.com)\//i;

function makeView(id, url) {
  const ses = session.fromPartition(PARTITION);
  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, backgroundThrottling: false },
  });
  view.setBackgroundColor('#02202e');   // panel-coloured, so no white flash
  const wc = view.webContents;
  const entry = { view, ready: false, error: null, attached: false };
  views.set(id, entry);

  wc.setWindowOpenHandler(({ url: target }) => {
    if (!AUTH_HOSTS.test(target)) {
      shell.openExternal(target);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 980, height: 800, parent: win, autoHideMenuBar: true,
        webPreferences: { session: ses, sandbox: true },
      },
    };
  });

  // Once focus is inside the view the hub's own key handling never sees a
  // thing, so Escape has to be caught here. Only Escape and Ctrl+W - stealing
  // anything else would break typing in Jira.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const esc = input.key === 'Escape';
    const closeKey = input.control && String(input.key).toLowerCase() === 'w';
    if (esc || closeKey) {
      event.preventDefault();
      hidePreview(id, { keepWarm: true });
      send('preview:state', { id, state: 'closed' });
    }
  });

  // Attach only once there is something to show, so the spinner stays visible
  // underneath instead of being covered by an empty view.
  const attachWhenPainted = () => {
    if (shown.has(id) && !entry.attached && win && !win.isDestroyed()) {
      win.contentView.addChildView(entry.view);
      entry.attached = true;
      applyBounds();
    }
  };
  wc.once('dom-ready', attachWhenPainted);
  setTimeout(attachWhenPainted, 3000);   // fallback: a page that never fires it

  wc.on('did-finish-load', () => {
    entry.ready = true;
    entry.error = null;
    attachWhenPainted();
    if (shown.has(id)) send('preview:state', { id, state: 'ready' });
  });
  wc.on('did-fail-load', (_e, code, desc, _u, isMainFrame) => {
    if (!isMainFrame || code === -3) return;      // -3 = aborted by a redirect
    entry.error = `${desc} (${code})`;
    if (shown.has(id)) send('preview:state', { id, state: 'error', message: entry.error });
  });
  wc.on('render-process-gone', () => {
    entry.error = 'the preview process stopped';
    if (shown.has(id)) send('preview:state', { id, state: 'error', message: entry.error });
  });

  wc.loadURL(url);
  return entry;
}

const CHAT_PARTITION = 'persist:chatui';

/* Local content we author, so it gets a preload - unlike the five web previews,
   which get none. Its own partition, never the web one. */
function makeChatView(id) {
  const ses = session.fromPartition(CHAT_PARTITION);
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: path.join(ROOT, 'chat', 'chat-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor('#02202e');
  const wc = view.webContents;
  const entry = { view, ready: false, error: null, attached: false, chat: true };
  views.set(id, entry);

  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e) => e.preventDefault());   // pinned to chat.html

  const attachWhenPainted = () => {
    if (shown.has(id) && !entry.attached && win && !win.isDestroyed()) {
      win.contentView.addChildView(entry.view);
      entry.attached = true;
      applyBounds();
    }
  };
  wc.once('dom-ready', attachWhenPainted);
  wc.on('did-finish-load', () => {
    entry.ready = true;
    attachWhenPainted();
    if (shown.has(id)) send('preview:state', { id, state: 'ready' });
  });

  wc.loadFile(path.join(ROOT, 'chat', 'chat.html'));
  return entry;
}

/* Several previews can be on screen at once - up to two per column - so the
   renderer sends a rect per node id rather than one panel rect, and every
   attached view is positioned from that map. */
async function showPreview(id) {
  const node = NODES[id];
  let entry = views.get(id);
  if (!entry) entry = node.chat ? makeChatView(id) : makeView(id, node.preview);

  shown.add(id);
  touch(id);
  // A view that has already painted goes up immediately; a fresh one waits for
  // dom-ready so the spinner is not hidden behind an empty rectangle.
  if (!entry.attached && entry.ready) {
    win.contentView.addChildView(entry.view);
    entry.attached = true;
  }
  applyBounds();

  if (entry.error) return { state: 'error', message: entry.error };
  return { state: entry.ready ? 'ready' : 'loading' };
}

async function hidePreview(id, { keepWarm = true } = {}) {
  if (!id || !shown.has(id)) return { ok: true };
  shown.delete(id);
  bounds.delete(id);
  // Detaching the chat view does NOT stop its session - a long run keeps
  // going in the main process and replays when it is shown again.
  if (keepWarm || (NODES[id] && NODES[id].chat)) detach(id);
  else destroyView(id);
  return { ok: true };
}

/* --------------------------------------------------------------------- IPC */

// Only the hub page may drive this. The previewed sites get no preload and no
// ipcRenderer, but checking the sender means a compromised one still cannot
// reach these handlers.
function fromHub(event) {
  return win && !win.isDestroyed() &&
         event.sender === win.webContents &&
         event.senderFrame === win.webContents.mainFrame;
}

const known = (id) => Object.prototype.hasOwnProperty.call(NODES, id);

ipcMain.handle('domain:preview', async (event, arg) => {
  if (!fromHub(event)) return { state: 'error', message: 'refused' };
  const id = arg && arg.id;
  if (!known(id)) return { state: 'error', message: 'unknown node' };
  if (arg && arg.rect) bounds.set(id, arg.rect);
  try { return await showPreview(id); }
  catch (err) { return { state: 'error', message: err.message }; }
});

ipcMain.handle('domain:close', async (event, arg) => {
  if (!fromHub(event)) return { ok: false };
  const id = arg && arg.id;
  if (!known(id)) return { ok: false };
  return hidePreview(id, { keepWarm: true });
});

/* A map of node id -> rect. Anything shown but missing from the map has just
   been removed from its slot, so it comes down. */
ipcMain.on('domain:rects', (event, rects) => {
  if (!fromHub(event) || !rects || typeof rects !== 'object') return;
  for (const id of Object.keys(rects)) {
    if (known(id)) bounds.set(id, rects[id]);
  }
  for (const id of [...shown]) {
    if (!Object.prototype.hasOwnProperty.call(rects, id)) hidePreview(id, { keepWarm: true });
  }
  applyBounds();
});

/* Live thumbnails for the placement menu, in the spirit of Task View. */
ipcMain.handle('domain:thumbs', async (event) => {
  if (!fromHub(event)) return {};
  const out = {};
  await Promise.all([...shown].map(async (id) => {
    const entry = views.get(id);
    if (!entry || !entry.ready || entry.view.webContents.isDestroyed()) return;
    try {
      const img = await entry.view.webContents.capturePage();
      if (!img.isEmpty()) out[id] = img.resize({ width: 360 }).toDataURL();
    } catch (_) { /* a view mid-navigation simply has no thumbnail */ }
  }));
  return out;
});

/* Lift every view off while the user drags a column edge. Input over a
   WebContentsView goes to that view, not to the hub page, so a drag that
   strayed onto one would simply stop receiving pointermove. */
ipcMain.handle('domain:freeze', async (event, arg) => {
  if (!fromHub(event)) return { ok: false };
  const on = !!(arg && arg.on);
  for (const id of shown) {
    const entry = views.get(id);
    if (!entry) continue;
    if (on) {
      detach(id);
    } else if (!entry.attached && entry.ready && win && !win.isDestroyed()) {
      win.contentView.addChildView(entry.view);
      entry.attached = true;
    }
  }
  if (!on) applyBounds();
  return { ok: true };
});

ipcMain.handle('domain:external', async (event, arg) => {
  if (!fromHub(event)) return { ok: false, error: 'refused' };
  const id = arg && arg.id;
  if (!known(id)) return { ok: false, error: 'unknown node' };
  const node = NODES[id];
  // The chat node is the exception: an in-app session and the desktop app can
  // coexist, and closing it here would abandon a running conversation.
  if (node.chat) {
    execFile('explorer.exe', ['shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude']);
    return { ok: true };
  }
  await shell.openExternal(node.external);
  return { ok: true };
});

ipcMain.handle('domain:reload', async (event, arg) => {
  if (!fromHub(event)) return { ok: false };
  const id = arg && arg.id;
  const entry = id && views.get(id);
  if (!entry) return { ok: false };
  entry.ready = false;
  entry.error = null;
  entry.view.webContents.reload();
  return { ok: true };
});

/* --------------------------------------------------------------------- boot */

app.setAppUserModelId('com.elliot.domain');

// One instance only - a second launch focuses the window we already have.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(chromeUA(ses.getUserAgent()));

    win = new BrowserWindow({
      width: 1600, height: 1000, minWidth: 900, minHeight: 620,
      backgroundColor: '#02141f',
      icon: path.join(ROOT, 'domain.ico'),
      title: "Elliot's Domain",
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#02141f', symbolColor: '#7fa6b8', height: 46 },
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(1);
      win.webContents.setVisualZoomLevelLimits(1, 1);
    });

    chatIpc.register({
      chatWebContents: () => {
        const e = views.get('terminal');
        return e && !e.view.webContents.isDestroyed() ? e.view.webContents : null;
      },
      attention: (info) => send('chat:attention', info),
    });

    win.loadFile(path.join(ROOT, 'index.html'));
    win.on('closed', () => { win = null; });
  });

  let draining = false;
  app.on('before-quit', (e) => {
    if (draining) return;
    draining = true;
    e.preventDefault();
    Promise.race([
      manager.shutdownAll(),
      new Promise((r) => setTimeout(r, 3500)),
    ]).finally(() => app.quit());
  });

  app.on('window-all-closed', () => app.quit());
}
