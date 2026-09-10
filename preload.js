/* The entire surface the hub page is allowed to reach.
 *
 * Note what is NOT here: no way to pass a URL, a path or a command. The page
 * can only name one of the six node ids and describe slot geometry - main.js
 * owns the table that maps an id to something openable. */

const { contextBridge, ipcRenderer } = require('electron');

const rect = (r) => ({
  x: Number(r && r.x) || 0, y: Number(r && r.y) || 0,
  w: Number(r && r.w) || 0, h: Number(r && r.h) || 0,
});

contextBridge.exposeInMainWorld('domain', {
  // Show a node in a slot. Resolves { state: 'loading' | 'ready' | 'error', message? }
  preview: (arg) => ipcRenderer.invoke('domain:preview', {
    id: String(arg && arg.id), rect: arg && arg.rect ? rect(arg.rect) : null,
  }),

  // Ctrl+click - hand the node to the OS (default browser, desktop Excel, or
  // the Claude app). Never touches what is on screen here.
  external: (arg) => ipcRenderer.invoke('domain:external', { id: String(arg && arg.id) }),

  // Take one node out of its slot, keeping the page warm in the background.
  close: (arg) => ipcRenderer.invoke('domain:close', { id: String(arg && arg.id) }),

  reload: (arg) => ipcRenderer.invoke('domain:reload', { id: String(arg && arg.id) }),

  // Lift the views off (and put them back) while a column edge is dragged.
  freeze: (arg) => ipcRenderer.invoke('domain:freeze', { on: !!(arg && arg.on) }),

  // Live thumbnails of everything on screen, keyed by node id - the placement
  // menu draws these on its cards.
  thumbs: () => ipcRenderer.invoke('domain:thumbs'),

  // node id -> slot rect in CSS pixels, sent on every animation frame while the
  // columns move. A node missing from the map is no longer in a slot.
  rects: (map) => {
    const out = {};
    for (const id of Object.keys(map || {})) out[String(id)] = rect(map[id]);
    ipcRenderer.send('domain:rects', out);
  },

  // main -> page: a preview loaded, failed, or was closed from inside itself.
  onState: (fn) => ipcRenderer.on('preview:state', (_e, payload) => fn(payload)),

  // main -> page: the Agentic Workflow session wants attention.
  onChat: (fn) => ipcRenderer.on('chat:attention', (_e, payload) => fn(payload)),
});
