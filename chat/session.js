/* One long-lived Claude Code query per conversation.
 *
 * The session lives here in the main process, not in the chat window. Closing
 * the panel detaches the view but leaves the run going - a long command takes
 * minutes and the user will wander off. Events buffer here and replay on
 * reattach. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ChatError, resolveClaudeExecutable, versionOf } = require('./cli');
const { createBridge } = require('./permissions');
const { normalize } = require('./events');

const HOME = require('os').homedir();
const WORKSPACE = path.join(HOME, 'agentic-workflow');

/* The slash menu, and the directory each command actually works from. These
   are placeholders in this public copy - replace them with your own commands.

   Each entry carries its own cwd because a slash command is only offered from
   the workspace it is defined in: one scoped to a sub-folder is not visible
   from the parent, so picking it has to start the conversation in that folder.

   `gates` is how many times the command is expected to stop and wait for an
   answer; it drives nothing but the label on the menu item. */
const SHORTCUTS = [
  {
    id: 'example', command: '/your-command', cwd: WORKSPACE,
    kicker: 'EXAMPLE', gates: 1,
    blurb: 'A command defined in the workspace root.',
  },
  {
    id: 'example-scoped', command: '/your-scoped-command', cwd: path.join(WORKSPACE, 'sub-workspace'),
    kicker: 'EXAMPLE', gates: 1,
    blurb: 'A command scoped to a sub-folder, started in that folder.',
  },
];

const MAX_BUFFER = 2000;      // events kept for replay; the full record is in the jsonl
const MAX_LIVE = 3;           // concurrent conversations, each its own claude.exe

let sdkPromise = null;
function sdk() {                                  // the SDK is ESM; main.js is CJS
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

/* ------------------------------------------------------- streaming input */

function makeInputStream() {
  const queue = [];
  let pending = null;
  let closed = false;

  const iterator = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { pending = resolve; });
    },
    return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
  };

  return {
    stream: iterator,
    push(text) {
      if (closed) return false;
      const msg = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
      };
      if (pending) { const r = pending; pending = null; r({ value: msg, done: false }); }
      else queue.push(msg);
      return true;
    },
    close() {
      closed = true;
      if (pending) { const r = pending; pending = null; r({ value: undefined, done: true }); }
    },
  };
}

/* --------------------------------------------------------------- session */

class ChatSession {
  constructor({ cwd, resume, fork, title, onEvent }) {
    this.localId = crypto.randomUUID();
    this.cwd = cwd || WORKSPACE;
    this.title = title || 'New conversation';
    this.sdkSessionId = null;
    this.state = 'starting';        // starting|idle|thinking|awaiting-permission|error|closed
    this.error = null;
    this.usage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    this.slashCommands = [];
    this.startedAt = Date.now();

    this._resume = resume || null;
    this._fork = fork !== false;
    this._onEvent = onEvent;
    this._buffer = [];
    this._seq = 0;
    this._truncated = false;
    this._input = makeInputStream();
    this._abort = new AbortController();
    this._perm = createBridge({ emit: (e) => this._emit(e) });
    this._done = null;
  }

  _emit(event) {
    const e = { ...event, seq: ++this._seq, at: Date.now() };
    if (e.kind === 'ready') {
      this.sdkSessionId = e.sdkSessionId || this.sdkSessionId;
      this.slashCommands = e.slashCommands || [];
      this.state = 'idle';
    } else if (e.kind === 'permission-request' || e.kind === 'question') {
      this.state = 'awaiting-permission';
    } else if (e.kind === 'permission-resolved') {
      this.state = 'thinking';
    } else if (e.kind === 'result') {
      this.state = 'idle';
      if (typeof e.totalCostUsd === 'number') this.usage.costUsd += e.totalCostUsd;
      if (e.usage) {
        this.usage.inputTokens += e.usage.input_tokens || 0;
        this.usage.outputTokens += e.usage.output_tokens || 0;
      }
    } else if (e.kind === 'error') {
      this.state = 'error';
      this.error = { code: e.code, message: e.message };
    } else if (e.kind === 'closed') {
      this.state = 'closed';
    }

    this._buffer.push(e);
    if (this._buffer.length > MAX_BUFFER) {
      this._buffer.splice(0, this._buffer.length - MAX_BUFFER);
      this._truncated = true;
    }
    if (this._onEvent) this._onEvent(this.localId, e);
  }

  async start() {
    let exe;
    try {
      exe = resolveClaudeExecutable();
    } catch (err) {
      this._emit({ kind: 'error', code: err.code || 'CLI_NOT_FOUND', message: err.message, detail: err.detail });
      return this;
    }
    if (!fs.existsSync(this.cwd)) {
      this._emit({ kind: 'error', code: 'CWD_MISSING', message: `The folder ${this.cwd} does not exist.` });
      return this;
    }
    this.cliVersion = versionOf(exe);
    this._done = this.#run(exe);
    return this;
  }

  async #run(exe) {
    const { query } = await sdk();
    let iter;
    try {
      iter = query({
        prompt: this._input.stream,
        options: {
          cwd: this.cwd,
          pathToClaudeCodeExecutable: exe,
          includePartialMessages: true,
          canUseTool: this._perm.handler,
          abortController: this._abort,
          permissionMode: 'default',       // nothing auto-approves; everything prompts
          ...(this._resume ? { resume: this._resume, forkSession: this._fork } : {}),
        },
      });
      this._query = iter;

      for await (const msg of iter) {
        for (const e of normalize(msg)) this._emit(e);
      }
    } catch (err) {
      if (this._abort.signal.aborted) this._emit({ kind: 'aborted' });
      else this._emit({ kind: 'error', code: classify(err), message: String(err && err.message || err), detail: String(err && err.stderr || '').slice(0, 1200) });
    } finally {
      this._perm.denyAll('The conversation ended.');
      this._emit({ kind: 'closed' });
    }
  }

  send(text) {
    if (this.state === 'closed' || this.state === 'error') return { ok: false, code: 'CLOSED' };
    const body = String(text || '').trim();
    if (!body) return { ok: false, code: 'EMPTY' };
    this._emit({ kind: 'user', text: body });
    this.state = 'thinking';
    this._input.push(body);
    if (this.title === 'New conversation') this.title = body.slice(0, 60);
    return { ok: true };
  }

  decide(requestId, decision) { return this._perm.decide(requestId, decision); }

  async interrupt() {
    try { if (this._query && this._query.interrupt) { await this._query.interrupt(); return { ok: true }; } }
    catch { /* fall through to abort */ }
    this._abort.abort();
    return { ok: true };
  }

  async stop() {
    this._perm.denyAll('The conversation was closed.');
    this._input.close();
    this._abort.abort();
    try { await Promise.race([this._done, new Promise((r) => setTimeout(r, 3000))]); } catch { /* ignore */ }
    this.state = 'closed';
  }

  snapshot() {
    return {
      localId: this.localId,
      sdkSessionId: this.sdkSessionId,
      title: this.title,
      cwd: this.cwd,
      state: this.state,
      error: this.error,
      usage: this.usage,
      startedAt: this.startedAt,
      lastSeq: this._seq,
      truncated: this._truncated,
      transcript: this._buffer,
      pending: this._perm.outstanding(),
      rules: this._perm.rules(),
      pendingCount: this._perm.pendingCount,
      slashCommands: this.slashCommands,
    };
  }
}

function classify(err) {
  const s = `${(err && err.message) || ''} ${(err && err.stderr) || ''}`.toLowerCase();
  if (s.includes('not logged in') || s.includes('/login') || s.includes('unauthor')) return 'AUTH_FAILED';
  if (s.includes('enoent') || s.includes('not found')) return 'CLI_NOT_FOUND';
  return 'SDK_CRASH';
}

/* --------------------------------------------------------------- manager */

const sessions = new Map();       // localId -> ChatSession
let activeId = null;
let listener = null;

function emitToRenderer(localId, event) {
  if (listener) listener(localId, event);
}

const manager = {
  WORKSPACE,
  SHORTCUTS,

  onEvent(fn) { listener = fn; },
  active() { return activeId ? sessions.get(activeId) || null : null; },
  get(localId) { return sessions.get(localId) || null; },

  async create({ cwd, title } = {}) {
    const live = [...sessions.values()].filter((s) => s.state !== 'closed' && s.state !== 'error');
    if (live.length >= MAX_LIVE) {
      return { ok: false, code: 'TOO_MANY', error: `Close one of the ${MAX_LIVE} open conversations first.` };
    }
    const s = new ChatSession({ cwd, title, onEvent: emitToRenderer });
    sessions.set(s.localId, s);
    activeId = s.localId;
    await s.start();
    return { ok: true, localId: s.localId };
  },

  async resume({ sdkSessionId, fork = true }) {
    for (const s of sessions.values()) {
      if (s.sdkSessionId === sdkSessionId && s.state !== 'closed') {
        activeId = s.localId;
        return { ok: true, localId: s.localId, reused: true };
      }
    }
    const info = await manager.info(sdkSessionId).catch(() => null);
    const s = new ChatSession({
      cwd: (info && info.cwd) || WORKSPACE,
      title: (info && info.title) || 'Resumed conversation',
      resume: sdkSessionId,
      fork,
      onEvent: emitToRenderer,
    });
    sessions.set(s.localId, s);
    activeId = s.localId;
    await s.start();
    return { ok: true, localId: s.localId };
  },

  setActive(localId) {
    if (!sessions.has(localId)) return { ok: false, code: 'GONE' };
    activeId = localId;
    return { ok: true };
  },

  /* The jsonl store under ~/.claude/projects is shared with the desktop app, so
     filter to this workspace or the sidebar shows every project on the machine. */
  async list() {
    try {
      const { listSessions } = await sdk();
      if (typeof listSessions !== 'function') return [];
      const all = await listSessions();
      const roots = [WORKSPACE, ...SHORTCUTS.map((s) => s.cwd)].map((p) => p.toLowerCase());
      return (all || [])
        .filter((s) => {
          const cwd = String(s.cwd || s.projectPath || s.project || '').toLowerCase();
          return !cwd || roots.some((r) => cwd === r || cwd.startsWith(r));
        })
        .map((s) => ({
          sdkSessionId: s.sessionId || s.id,
          title: s.title || s.summary || 'Untitled',
          cwd: s.cwd || s.projectPath || '',
          messageCount: s.messageCount ?? s.numMessages ?? null,
          updatedAt: s.updatedAt || s.lastActiveAt || s.modifiedAt || null,
          live: [...sessions.values()].some((x) => x.sdkSessionId === (s.sessionId || s.id) && x.state !== 'closed'),
        }));
    } catch {
      return [];
    }
  },

  async info(sdkSessionId) {
    const { getSessionInfo } = await sdk();
    if (typeof getSessionInfo !== 'function') return null;
    return getSessionInfo(sdkSessionId);
  },

  async history(sdkSessionId) {
    const { getSessionMessages } = await sdk();
    if (typeof getSessionMessages !== 'function') return [];
    const msgs = await getSessionMessages(sdkSessionId);
    const out = [];
    let seq = 0;
    for (const m of msgs || []) for (const e of normalize(m)) out.push({ ...e, seq: ++seq });
    return out;
  },

  async rename(sdkSessionId, title) {
    const { renameSession } = await sdk();
    for (const s of sessions.values()) if (s.sdkSessionId === sdkSessionId) s.title = title;
    if (typeof renameSession === 'function') await renameSession(sdkSessionId, title);
    return { ok: true };
  },

  async shutdownAll() {
    const all = [...sessions.values()];
    await Promise.all(all.map((s) => s.stop().catch(() => {})));
    sessions.clear();
    activeId = null;
  },

  pendingTotal() {
    let n = 0;
    for (const s of sessions.values()) n += s._perm.pendingCount;
    return n;
  },
};

module.exports = { manager, ChatSession, WORKSPACE, SHORTCUTS };
