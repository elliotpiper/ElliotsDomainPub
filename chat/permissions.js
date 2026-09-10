/* The canUseTool bridge.
 *
 * The SDK calls us and waits on the Promise we return; the UI resolves it. The
 * docs are explicit that this may stay pending indefinitely - execution simply
 * pauses - so there is deliberately no timeout here. A gate in a long command
 * can sit unanswered while the user goes to lunch. */

const crypto = require('crypto');

/* What "allow for the rest of this conversation" is keyed on. Deliberately
   conservative: broad for reads, path-scoped for writes, verb-scoped for shell,
   and withheld entirely for anything we cannot summarise. */
function ruleKey(tool, input) {
  const i = input || {};
  switch (tool) {
    case 'Read': case 'Glob': case 'Grep': case 'TodoWrite': case 'WebSearch':
      return tool;
    case 'Write': case 'Edit': case 'NotebookEdit': {
      const p = String(i.file_path || i.notebook_path || '');
      const dir = p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      return dir ? `Edit::${dir}` : null;
    }
    case 'Bash': {
      const verb = String(i.command || '').trim().split(/\s+/)[0] || '';
      return verb ? `Bash::${verb}` : null;
    }
    case 'WebFetch': {
      try { return `WebFetch::${new URL(i.url).host}`; } catch { return null; }
    }
    default:
      return null;                 // no session-allow button for unknown tools
  }
}

/* Shell commands that should never be session-allowed on one sighting. */
const DANGEROUS = /(^|\s)(rm|rmdir|del|Remove-Item|format)(\s|$)|>>?\s|\|\s*sh\b|curl\b|iwr\b|Invoke-WebRequest\b|git\s+push\b|&&|;\s*\S/i;

function isDangerous(tool, input) {
  return tool === 'Bash' && DANGEROUS.test(String((input || {}).command || ''));
}

function createBridge({ emit }) {
  const pending = new Map();          // requestId -> { resolve, key, tool }
  const allowed = new Set();          // in-memory, per conversation, never written to disk

  /* Matches the SDK's canUseTool signature. */
  function handler(toolName, input, options) {
    const suggestions = (options && options.suggestions) || [];
    const signal = options && options.signal;
    const key = ruleKey(toolName, input);

    if (key && allowed.has(key)) {
      emit({ kind: 'permission-auto', tool: toolName, rule: key });
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const entry = { resolve, key, tool: toolName, input };
      pending.set(requestId, entry);

      if (signal) {
        signal.addEventListener('abort', () => {
          if (pending.delete(requestId)) {
            emit({ kind: 'permission-resolved', requestId, behavior: 'withdrawn' });
            resolve({ behavior: 'deny', message: 'Cancelled before you answered.' });
          }
        }, { once: true });
      }

      emit({
        kind: toolName === 'AskUserQuestion' ? 'question' : 'permission-request',
        requestId,
        tool: toolName,
        input,
        suggestions,
        canRemember: !!key && !isDangerous(toolName, input),
        dangerous: isDangerous(toolName, input),
        ruleKey: key,
      });
    });
  }

  /* Called from IPC when the user clicks. `decision` is the renderer's simple
     shape; the SDK's ElicitationResult is built here. */
  function decide(requestId, decision) {
    const entry = pending.get(requestId);
    if (!entry) return { ok: false, code: 'GONE' };
    pending.delete(requestId);

    const d = decision || {};
    if (d.behavior === 'allow') {
      if (d.always && entry.key) allowed.add(entry.key);
      // AskUserQuestion answers ride back as updatedInput.
      const updatedInput = d.updatedInput && typeof d.updatedInput === 'object'
        ? d.updatedInput
        : entry.input;
      entry.resolve({ behavior: 'allow', updatedInput });
      emit({
        kind: 'permission-resolved', requestId,
        behavior: d.always ? 'allow-session' : 'allow',
        rule: d.always ? entry.key : null,
      });
    } else {
      const message = (typeof d.message === 'string' && d.message.trim())
        ? d.message.trim()
        : 'The user denied this action.';
      entry.resolve({ behavior: 'deny', message });
      emit({ kind: 'permission-resolved', requestId, behavior: 'deny', message });
    }
    return { ok: true };
  }

  function outstanding() {
    return [...pending.entries()].map(([requestId, e]) => ({
      requestId, tool: e.tool, input: e.input,
      canRemember: !!e.key && !isDangerous(e.tool, e.input),
      dangerous: isDangerous(e.tool, e.input),
    }));
  }

  /* Deny everything still waiting. Used on quit and when a session ends - the
     CLI is blocked on an answer that will never come, and leaving it blocked is
     how you end up with an orphaned claude.exe. */
  function denyAll(reason) {
    for (const [requestId, entry] of pending) {
      entry.resolve({ behavior: 'deny', message: reason });
      emit({ kind: 'permission-resolved', requestId, behavior: 'withdrawn' });
    }
    pending.clear();
  }

  return {
    handler, decide, outstanding, denyAll,
    rules: () => [...allowed],
    revoke: (key) => allowed.delete(key),
    get pendingCount() { return pending.size; },
  };
}

module.exports = { createBridge, ruleKey, isDangerous };
