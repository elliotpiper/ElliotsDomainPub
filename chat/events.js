/* Turning SDK messages into the one event shape the renderer understands.
 *
 * Both the live stream and replayed history go through here, so the renderer
 * has a single code path for "draw a conversation". Anything unrecognised
 * becomes {kind:'unknown'} and is dropped by the renderer - never throw out of
 * the for-await loop, or a protocol change kills the session. */

const path = require('path');

const RESULT_PREVIEW_CHARS = 4000;   // keep huge Read results off the IPC hot path

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text || '')
    .join('');
}

function clip(s, n) {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '', null, 2) || '';
  return str.length > n ? { text: str.slice(0, n), truncated: str.length } : { text: str, truncated: 0 };
}

function base(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
}

/* A one-line description of a tool call, built here so the renderer is not
   re-implementing per-tool formatting. */
function summarise(tool, input) {
  const i = input || {};
  switch (tool) {
    case 'Read':          return base(i.file_path);
    case 'Write':         return base(i.file_path);
    case 'Edit':          return base(i.file_path);
    case 'NotebookEdit':  return base(i.notebook_path || i.file_path);
    case 'Bash':          return i.command || '';
    case 'Glob':          return i.pattern || '';
    case 'Grep':          return i.pattern ? `${i.pattern}${i.path ? ' in ' + base(i.path) : ''}` : '';
    case 'Task':          return i.subagent_type || i.description || '';
    case 'WebFetch':      return i.url || '';
    case 'WebSearch':     return i.query || '';
    case 'TodoWrite':     return 'updating the task list';
    case 'AskUserQuestion': return 'asking you a question';
    default:              return '';
  }
}

function todosFrom(input) {
  const list = input && Array.isArray(input.todos) ? input.todos : null;
  if (!list) return null;
  return list.map((t) => ({
    content: String(t.content ?? ''),
    activeForm: String(t.activeForm ?? t.content ?? ''),
    status: String(t.status ?? 'pending'),
  }));
}

/* Returns an array of events (often one, sometimes several). */
function normalize(msg) {
  if (!msg || typeof msg !== 'object') return [];
  const out = [];

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        out.push({
          kind: 'ready',
          sdkSessionId: msg.session_id,
          model: msg.model,
          cwd: msg.cwd,
          tools: msg.tools || [],
          slashCommands: msg.slash_commands || [],
          permissionMode: msg.permissionMode,
        });
      } else {
        out.push({ kind: 'unknown', raw: msg.subtype || 'system' });
      }
      break;

    case 'stream_event': {
      const ev = msg.event || {};
      if (ev.type === 'content_block_start') {
        const t = ev.content_block && ev.content_block.type;
        if (t === 'text') out.push({ kind: 'text-start', blockId: ev.index });
        else if (t === 'thinking') out.push({ kind: 'thinking-start', blockId: ev.index });
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta') out.push({ kind: 'text-delta', blockId: ev.index, text: d.text || '' });
        else if (d.type === 'thinking_delta') out.push({ kind: 'thinking-delta', blockId: ev.index, text: d.thinking || '' });
      } else if (ev.type === 'content_block_stop') {
        out.push({ kind: 'block-stop', blockId: ev.index });
      }
      break;
    }

    case 'assistant': {
      const blocks = (msg.message && msg.message.content) || [];
      const text = textOf(blocks);
      const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('');
      // Authoritative version of the turn's prose - the renderer replaces the
      // streamed tail with this, so streamed/settled never drift.
      if (text || thinking) {
        out.push({ kind: 'assistant', messageId: msg.message && msg.message.id, text, thinking });
      }
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        out.push({
          kind: 'tool-start',
          toolUseId: b.id,
          tool: b.name,
          input: b.input || {},
          summary: summarise(b.name, b.input),
        });
        const todos = b.name === 'TodoWrite' ? todosFrom(b.input) : null;
        if (todos) out.push({ kind: 'todos', items: todos });
      }
      break;
    }

    case 'user': {
      const blocks = (msg.message && msg.message.content) || [];
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        const { text, truncated } = clip(textOf(b.content) || b.content, RESULT_PREVIEW_CHARS);
        out.push({
          kind: 'tool-result',
          toolUseId: b.tool_use_id,
          isError: !!b.is_error,
          preview: text,
          truncated,
        });
      }
      // A user turn replayed from history (no tool_result blocks) is the human speaking.
      if (!blocks.some((b) => b.type === 'tool_result')) {
        const t = textOf(blocks);
        if (t) out.push({ kind: 'user', text: t });
      }
      break;
    }

    case 'result':
      // An auth failure or a crashed turn arrives here as an errored result,
      // NOT as a thrown exception - so classify it or it renders as an ordinary
      // reply followed by a "waiting for you" gate that is simply wrong.
      if (msg.is_error) {
        const t = String(msg.result || msg.subtype || '');
        out.push({ kind: 'error', code: classifyResult(t), message: t || 'The turn failed.' });
      }
      out.push({
        kind: 'result',
        subtype: msg.subtype,
        isError: !!msg.is_error,
        durationMs: msg.duration_ms,
        numTurns: msg.num_turns,
        totalCostUsd: msg.total_cost_usd,
        usage: msg.usage || null,
        text: typeof msg.result === 'string' ? msg.result : '',
      });
      break;

    default:
      out.push({ kind: 'unknown', raw: String(msg.type || 'message') });
  }

  return out;
}

function classifyResult(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('not logged in') || t.includes('/login') || t.includes('unauthor')) return 'AUTH_FAILED';
  if (t.includes('enoent') || t.includes('not found')) return 'CLI_NOT_FOUND';
  return 'TURN_FAILED';
}

module.exports = { normalize, summarise, classifyResult, RESULT_PREVIEW_CHARS };
