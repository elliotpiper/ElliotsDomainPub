/* The chat window's IPC surface.
 *
 * Wider than the hub's four calls, because a chat inherently carries free-form
 * prompt text. Still enumerated: no channel accepts a path, a URL, or a command
 * line. The working directory and the executable are decided in main; the
 * renderer can only name one of three shortcut ids. */

const { ipcMain, shell } = require('electron');
const { manager, SHORTCUTS } = require('./session');

let getChatWebContents = () => null;
let onAttention = () => {};

function fromChat(event) {
  const wc = getChatWebContents();
  return !!wc && !wc.isDestroyed() &&
         event.sender === wc &&
         event.senderFrame === wc.mainFrame;
}

function push(channel, payload) {
  const wc = getChatWebContents();
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}

function guard(handler) {
  return async (event, arg) => {
    if (!fromChat(event)) return { ok: false, code: 'REFUSED' };
    try {
      return await handler(arg || {});
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: String(err && err.message || err) };
    }
  };
}

function snapshotOf(session) {
  return session ? session.snapshot() : null;
}

function register({ chatWebContents, attention }) {
  getChatWebContents = chatWebContents;
  onAttention = attention || (() => {});

  manager.onEvent((localId, event) => {
    push('chat:event', { localId, ...event });
    if (event.kind === 'permission-request' || event.kind === 'question' ||
        event.kind === 'permission-resolved' || event.kind === 'result' ||
        event.kind === 'closed' || event.kind === 'error') {
      onAttention({ pending: manager.pendingTotal() });
    }
    if (event.kind === 'ready' || event.kind === 'closed') push('chat:sessions-changed', {});
  });

  ipcMain.handle('chat:attach', guard(async () => ({
    ok: true,
    workspace: manager.WORKSPACE,
    shortcuts: SHORTCUTS.map((s) => ({
      id: s.id, command: s.command, cwd: s.cwd,
      kicker: s.kicker, gates: s.gates, blurb: s.blurb,
    })),
    session: snapshotOf(manager.active()),
    sessions: await manager.list(),
  })));

  ipcMain.handle('chat:new', guard(async ({ cwd, title, shortcut }) => {
    // cwd never comes from the renderer as a path - only as a shortcut id
    let dir = manager.WORKSPACE;
    if (shortcut) {
      const s = SHORTCUTS.find((x) => x.id === shortcut);
      if (!s) return { ok: false, code: 'UNKNOWN_SHORTCUT' };
      dir = s.cwd;
    }
    const res = await manager.create({ cwd: dir, title });
    if (!res.ok) return res;
    return { ok: true, localId: res.localId, session: snapshotOf(manager.get(res.localId)) };
  }));

  ipcMain.handle('chat:send', guard(async ({ localId, text }) => {
    const s = manager.get(localId) || manager.active();
    if (!s) return { ok: false, code: 'NO_SESSION' };
    return s.send(text);
  }));

  ipcMain.handle('chat:interrupt', guard(async ({ localId }) => {
    const s = manager.get(localId) || manager.active();
    return s ? s.interrupt() : { ok: false, code: 'NO_SESSION' };
  }));

  ipcMain.handle('chat:stop', guard(async ({ localId }) => {
    const s = manager.get(localId);
    if (s) await s.stop();
    return { ok: true };
  }));

  ipcMain.handle('chat:permission-decide', guard(async ({ localId, requestId, behavior, always, message, updatedInput }) => {
    const s = manager.get(localId) || manager.active();
    if (!s) return { ok: false, code: 'NO_SESSION' };
    if (behavior !== 'allow' && behavior !== 'deny') return { ok: false, code: 'BAD_DECISION' };
    const res = s.decide(requestId, { behavior, always: !!always, message, updatedInput });
    onAttention({ pending: manager.pendingTotal() });
    return res;
  }));

  ipcMain.handle('chat:sessions', guard(async () => ({ ok: true, sessions: await manager.list() })));

  ipcMain.handle('chat:history', guard(async ({ sdkSessionId }) => ({
    ok: true, transcript: await manager.history(String(sdkSessionId || '')),
  })));

  ipcMain.handle('chat:resume', guard(async ({ sdkSessionId, fork }) => {
    const res = await manager.resume({ sdkSessionId: String(sdkSessionId || ''), fork: fork !== false });
    if (!res.ok) return res;
    return { ok: true, localId: res.localId, session: snapshotOf(manager.get(res.localId)) };
  }));

  ipcMain.handle('chat:switch', guard(async ({ localId }) => {
    const res = manager.setActive(localId);
    if (!res.ok) return res;
    return { ok: true, session: snapshotOf(manager.get(localId)) };
  }));

  ipcMain.handle('chat:rename', guard(async ({ sdkSessionId, title }) => {
    await manager.rename(String(sdkSessionId || ''), String(title || '').slice(0, 120));
    push('chat:sessions-changed', {});
    return { ok: true };
  }));

  /* Enumerated: the renderer sends a shortcut id, main owns the command string
     AND the directory it has to run from. Verified: no single cwd exposes all
     three commands, so each one carries its own. */
  ipcMain.handle('chat:slash', guard(async ({ localId, shortcut }) => {
    const s = SHORTCUTS.find((x) => x.id === shortcut);
    if (!s) return { ok: false, code: 'UNKNOWN_SHORTCUT' };
    const session = manager.get(localId) || manager.active();
    const needsNew = !session || session.cwd.toLowerCase() !== s.cwd.toLowerCase() || session.state === 'closed';
    return { ok: true, command: s.command, cwd: s.cwd, needsNew };
  }));

  /* Markdown links must not navigate this window. */
  ipcMain.handle('chat:open-link', guard(async ({ url }) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, code: 'BAD_SCHEME' };
    await shell.openExternal(u);
    return { ok: true };
  }));
}

module.exports = { register, fromChat };
