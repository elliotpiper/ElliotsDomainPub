/* The conversation renderer.
 *
 * Draws a Claude Code transcript from the normalised event stream, and owns the
 * two interactions that matter: the permission prompt (nothing runs until you
 * click, and the buttons live in the same node as the evidence) and the gate
 * signal (Claude finishing a turn without a tool call means it is waiting on
 * you - easy to miss after a wall of document text). */

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const feed = $('#feed');
  const scroll = $('#scroll');
  const input = $('#ag-in');
  const sendBtn = $('#c-send');
  const jump = $('#jump');
  const sticky = $('#sticky');
  const nudge = $('#nudge');
  const queuedBox = $('#queued');
  const live = $('#live');
  const alertBox = $('#alert');

  let session = null;            // snapshot from main
  let shortcuts = [];
  let workspace = '';
  let lastSeq = 0;
  let stuck = true;              // pinned to the bottom?
  let newCount = 0;
  let queued = null;
  let openText = null;           // the in-flight assistant text block
  let openThink = null;
  let tools = new Map();         // toolUseId -> element
  let todoBlock = null;
  let pendingPerm = null;        // { requestId, el }
  let armAt = 0;                 // permission keys arm 400ms after render
  let tick = null;
  let workStartedAt = 0;

  /* ------------------------------------------------------------ helpers */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function blk(kind, gutter) {
    const a = el('article', 'blk blk-' + kind);
    const g = el('span', 'gut', gutter || '');
    g.setAttribute('aria-hidden', 'true');
    a.appendChild(g);
    a.appendChild(el('div', 'body'));
    return a;
  }

  function add(node) {
    feed.appendChild(node);
    afterAppend();
    return node;
  }

  function afterAppend() {
    if (stuck) scroll.scrollTop = scroll.scrollHeight;
    else { newCount++; $('#jump-n').textContent = newCount; jump.hidden = false; }
  }

  function say(msg) { live.textContent = msg; }

  function middleEllipsis(s, max) {
    const str = String(s || '');
    if (str.length <= max) return str;
    const keep = Math.floor((max - 1) / 2);
    return str.slice(0, keep) + '…' + str.slice(-keep);
  }

  scroll.addEventListener('scroll', () => {
    stuck = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    if (stuck) { jump.hidden = true; newCount = 0; }
  }, { passive: true });

  jump.addEventListener('click', () => {
    stuck = true; newCount = 0; jump.hidden = true;
    scroll.scrollTop = scroll.scrollHeight;
  });

  /* Markdown links never navigate this window. */
  feed.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    window.chat.openLink({ url: a.dataset.href });
  });

  /* ------------------------------------------------------- status chrome */

  function setStatus(kind, text) {
    const s = $('#s-status');
    if (!kind) { s.hidden = true; return; }
    s.hidden = false;
    s.dataset.s = kind;
    s.textContent = text;
  }

  function startWorking(verb) {
    workStartedAt = Date.now();
    sticky.hidden = false;
    sticky.textContent = '';
    const b = el('b', null, '✻');
    sticky.appendChild(b);
    sticky.appendChild(document.createTextNode(' ' + (verb || 'Working')));
    const t = el('span', 't', '0:00');
    sticky.appendChild(t);
    clearInterval(tick);
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - workStartedAt) / 1000);
      t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
    setStatus('working', 'Working');
    sendBtn.dataset.stop = '1';
    sendBtn.textContent = '■';
    sendBtn.setAttribute('aria-label', 'Stop');
  }

  function stopWorking() {
    clearInterval(tick); tick = null;
    sticky.hidden = true;
    sendBtn.dataset.stop = '';
    sendBtn.textContent = '↵';
    sendBtn.setAttribute('aria-label', 'Send');
  }

  /* --------------------------------------------------------- transcript */

  function userBlock(text) {
    const a = blk('user', '>');
    const body = a.querySelector('.body');
    const m = /^(\/[\w:-]+)(\s[\s\S]*)?$/.exec(text);
    if (m) {
      body.appendChild(el('span', 'slash', m[1]));
      if (m[2]) body.appendChild(document.createTextNode(m[2].trim()));
    } else {
      body.textContent = text;
    }
    return add(a);
  }

  function ensureText() {
    if (openText) return openText;
    const a = blk('text', '');
    const body = a.querySelector('.body');
    body.className = 'body md';
    const settled = el('div', 'settled');
    const tail = el('pre', 'tail');
    const caret = el('span', 'caret');
    body.appendChild(settled);
    body.appendChild(tail);
    body.appendChild(caret);
    add(a);
    openText = { node: a, settled, tail, caret, raw: '' };
    return openText;
  }

  /* Deltas land in a raw <pre> tail; the tail is promoted to parsed DOM at a
     safe boundary (a blank line while not inside a fence), so half-written
     markdown never flashes as formatted. */
  function pushText(text) {
    const t = ensureText();
    t.raw += text;
    const idx = t.raw.lastIndexOf('\n\n');
    if (idx > -1 && !window.MD.insideFence(t.raw.slice(0, idx))) {
      const settledPart = t.raw.slice(0, idx);
      t.settled.textContent = '';
      t.settled.appendChild(window.MD.render(settledPart));
      t.raw = t.raw.slice(idx + 2);
    }
    t.tail.textContent = t.raw;
    if (stuck) scroll.scrollTop = scroll.scrollHeight;
  }

  function finishText(authoritative) {
    if (!openText) {
      if (authoritative) {
        const a = blk('text', '');
        const body = a.querySelector('.body');
        body.className = 'body md';
        body.appendChild(window.MD.render(authoritative));
        add(a);
      }
      return;
    }
    const body = openText.node.querySelector('.body');
    body.textContent = '';
    body.appendChild(window.MD.render(authoritative != null ? authoritative : (openText.settled.textContent + openText.raw)));
    openText = null;
  }

  function pushThinking(text) {
    if (!openThink) {
      const a = blk('think', '✻');
      const body = a.querySelector('.body');
      const d = el('details');
      const s = el('summary', null, '✻ Thinking');
      const inner = el('div', 'inner');
      d.appendChild(s); d.appendChild(inner);
      body.appendChild(d);
      add(a);
      openThink = { node: a, summary: s, inner, raw: '' };
    }
    openThink.raw += text;
    openThink.inner.textContent = openThink.raw;
    const words = openThink.raw.trim().split(/\s+/).length;
    openThink.summary.textContent = `✻ Thinking · ${words} words`;
  }

  function toolBlock(ev) {
    const a = blk('tool', '●');
    a.dataset.state = 'running';
    const body = a.querySelector('.body');
    const head = el('div', 'thead');
    head.appendChild(el('b', null, ev.tool));
    if (ev.summary) {
      const arg = el('span', 'arg', middleEllipsis(ev.summary, 68));
      arg.title = ev.summary;
      head.appendChild(arg);
    }
    body.appendChild(head);

    if (ev.tool === 'Bash' && ev.input && ev.input.command) {
      body.appendChild(el('pre', 'cmdline', ev.input.command));
    }
    tools.set(ev.toolUseId, a);
    add(a);
    startWorking(verbFor(ev));
    say(`${ev.tool} ${ev.summary || ''}`);
    return a;
  }

  function verbFor(ev) {
    const map = { Read: 'Reading', Write: 'Writing', Edit: 'Editing', Bash: 'Running',
      Glob: 'Searching', Grep: 'Searching', Task: 'Delegating', WebFetch: 'Fetching' };
    return `${map[ev.tool] || ev.tool} ${ev.summary || ''}`.trim();
  }

  function toolResult(ev) {
    const a = tools.get(ev.toolUseId);
    if (!a) return;
    a.dataset.state = ev.isError ? 'err' : 'ok';
    a.querySelector('.gut').textContent = ev.isError ? '✗' : '●';
    const body = a.querySelector('.body');
    const d = el('details');
    if (ev.isError) d.open = true;                 // errors are never collapsed
    const lines = (ev.preview || '').split('\n').length;
    const label = ev.isError ? 'error' : `${lines} line${lines === 1 ? '' : 's'}`;
    d.appendChild(el('summary', null, `⎿ ${label}${ev.truncated ? ' (truncated)' : ''}`));
    d.appendChild(el('pre', null, ev.preview || '(no output)'));
    body.appendChild(d);
  }

  function renderTodos(items) {
    if (!todoBlock) {
      todoBlock = blk('todo', '☰');
      add(todoBlock);
    }
    const body = todoBlock.querySelector('.body');
    body.textContent = '';
    const ul = el('ul');
    const glyph = { completed: '☑', in_progress: '◐', pending: '☐' };
    for (const t of items) {
      const li = el('li');
      li.dataset.s = t.status;
      li.appendChild(el('span', 'box', glyph[t.status] || '☐'));
      li.appendChild(el('span', null, t.status === 'in_progress' ? t.activeForm : t.content));
      ul.appendChild(li);
    }
    body.appendChild(ul);
    const done = items.filter((t) => t.status === 'completed').length;
    say(`Task list updated, ${done} of ${items.length} done`);
  }

  /* ------------------------------------------------------- permissions */

  function describe(tool, input) {
    const i = input || {};
    switch (tool) {
      case 'Bash':  return { what: `Run a command in ${short(workspace)}`, pre: i.command, note: i.description };
      case 'Write': return { what: `Write ${i.file_path || ''}`, pre: clip(i.content, 20) };
      case 'Edit':  return { what: `Edit ${i.file_path || ''}`, pre: diff(i.old_string, i.new_string) };
      case 'Read':  return { what: `Read ${i.file_path || ''}` };
      case 'Glob':  return { what: `List files matching ${i.pattern || ''}` };
      case 'Grep':  return { what: `Search for ${i.pattern || ''}` };
      case 'WebFetch': return { what: `Fetch ${i.url || ''}` };
      case 'Task':  return { what: `Run a ${i.subagent_type || 'sub'} agent`, pre: clip(i.prompt, 12) };
      default:      return { what: `Use ${tool}`, pre: JSON.stringify(i, null, 2) };
    }
  }

  function short(p) { return String(p || '').split(/[\\/]/).pop(); }
  function clip(s, n) {
    const lines = String(s || '').split('\n');
    return lines.length > n ? lines.slice(0, n).join('\n') + `\n… ${lines.length - n} more lines` : lines.join('\n');
  }
  function diff(oldS, newS) {
    const a = String(oldS || '').split('\n').map((l) => '− ' + l);
    const b = String(newS || '').split('\n').map((l) => '+ ' + l);
    return clip([...a, ...b].join('\n'), 40);
  }

  function permCard(ev) {
    const card = el('section', 'perm flash');
    card.tabIndex = -1;
    card.dataset.req = ev.requestId;

    const head = el('header');
    head.appendChild(el('span', 'pi', '!'));
    head.appendChild(el('b', null, 'Permission required'));
    head.appendChild(el('span', 'tool', ev.tool));
    card.appendChild(head);

    const d = describe(ev.tool, ev.input);
    card.appendChild(el('p', 'what', d.what));
    if (ev.dangerous) {
      card.appendChild(el('p', 'danger', '⚠ This command deletes, redirects, chains or reaches the network. Read it carefully.'));
    }
    if (d.pre) card.appendChild(el('pre', ev.tool === 'Bash' ? 'cmdline' : null, d.pre));
    if (d.note) card.appendChild(el('p', 'what', d.note));

    const acts = el('div', 'acts');
    const yes = el('button', 'p-yes', 'Allow once');
    const ses = el('button', 'p-ses');
    ses.appendChild(document.createTextNode(
      ev.tool === 'Bash' ? 'Allow all ' + firstWord(ev.input) + ' commands' : 'Allow for this conversation'));
    ses.appendChild(el('span', 'sub', 'this conversation only — nothing is written to disk'));
    const no = el('button', 'p-no', 'Deny');
    [yes, ses, no].forEach((b) => { b.type = 'button'; b.disabled = true; });
    acts.appendChild(yes);
    if (ev.canRemember) acts.appendChild(ses);
    acts.appendChild(no);
    card.appendChild(acts);
    card.appendChild(el('p', 'keys', 'Enter allow · A this conversation · Esc deny'));

    yes.addEventListener('click', () => decide(ev.requestId, { behavior: 'allow' }));
    ses.addEventListener('click', () => decide(ev.requestId, { behavior: 'allow', always: true }));
    no.addEventListener('click', () => decide(ev.requestId, { behavior: 'deny' }));

    add(card);
    pendingPerm = { requestId: ev.requestId, el: card, tool: ev.tool, summary: d.pre || d.what };

    // Arm 400ms later: a prompt can appear exactly as the user presses Enter to
    // send a message, and that keystroke must not approve something unseen.
    armAt = Date.now() + 400;
    setTimeout(() => {
      if (pendingPerm && pendingPerm.requestId === ev.requestId) {
        [yes, ses, no].forEach((b) => { b.disabled = false; });
        if (document.activeElement === document.body) card.focus();
      }
    }, 400);

    setStatus('waiting', 'Needs you');
    stopWorking();
    alertBox.textContent = `Permission required: ${d.what}. ${d.pre || ''}`;
    showNudge('⚠ Permission needed — Review ↑', () => {
      card.scrollIntoView({ block: 'center' });
      card.focus();
    });
    return card;
  }

  function firstWord(input) {
    return String((input || {}).command || '').trim().split(/\s+/)[0] || 'these';
  }

  function decide(requestId, decision) {
    window.chat.decide({ localId: session && session.localId, requestId, ...decision });
  }

  function permResolved(ev) {
    if (!pendingPerm || pendingPerm.requestId !== ev.requestId) return;
    const { el: card, tool, summary } = pendingPerm;
    const line = el('div', 'permdone');
    line.dataset.b = ev.behavior;
    const verb = { allow: '✓ Allowed', 'allow-session': '✓ Allowed for this conversation',
      deny: '✗ Denied', withdrawn: '⊘ Withdrawn' }[ev.behavior] || ev.behavior;
    line.appendChild(document.createTextNode(verb + ' · ' + tool + ' · '));
    line.appendChild(el('code', null, middleEllipsis(String(summary || '').split('\n')[0], 60)));
    card.replaceWith(line);
    pendingPerm = null;
    hideNudge();
    setStatus(null);
    alertBox.textContent = '';
    if (ev.behavior !== 'withdrawn') startWorking('Working');
  }

  /* ---------------------------------------------------------- question */

  function questionCard(ev) {
    const card = el('section', 'qcard');
    card.dataset.req = ev.requestId;
    const questions = (ev.input && ev.input.questions) || [];
    const state = new Map();

    questions.forEach((q, qi) => {
      card.appendChild(el('div', 'qh', q.header || 'Question'));
      card.appendChild(el('p', 'qq', q.question || ''));
      const name = 'q' + qi;
      (q.options || []).forEach((opt) => {
        const lab = el('label');
        const inp = document.createElement('input');
        inp.type = q.multiSelect ? 'checkbox' : 'radio';
        inp.name = name;
        inp.value = opt.label;
        inp.addEventListener('change', () => {
          if (q.multiSelect) {
            const set = state.get(q.question) || new Set();
            if (inp.checked) set.add(opt.label); else set.delete(opt.label);
            state.set(q.question, set);
          } else {
            state.set(q.question, opt.label);
          }
        });
        const txt = el('div');
        txt.appendChild(el('b', null, opt.label));
        if (opt.description) txt.appendChild(el('span', null, opt.description));
        lab.appendChild(inp);
        lab.appendChild(txt);
        card.appendChild(lab);
      });
      const other = document.createElement('input');
      other.type = 'text';
      other.placeholder = 'Or type your own answer…';
      other.addEventListener('input', () => { if (other.value.trim()) state.set(q.question, other.value.trim()); });
      card.appendChild(other);
    });

    const acts = el('div', 'qacts');
    const go = el('button', 'qgo', 'Send answers');
    const skip = el('button', 'qskip', 'Reply in my own words');
    go.type = skip.type = 'button';
    go.addEventListener('click', () => {
      const answers = {};
      for (const q of questions) {
        const v = state.get(q.question);
        if (v == null) continue;
        answers[q.question] = v instanceof Set ? [...v] : v;
      }
      decide(ev.requestId, { behavior: 'allow', updatedInput: { questions, answers } });
    });
    skip.addEventListener('click', () => {
      const text = (input.value || '').trim();
      decide(ev.requestId, {
        behavior: 'allow',
        updatedInput: { questions, answers: {}, response: text || 'Let me answer in my own words.' },
      });
      input.value = '';
    });
    acts.appendChild(go); acts.appendChild(skip);
    card.appendChild(acts);

    add(card);
    pendingPerm = { requestId: ev.requestId, el: card, tool: 'AskUserQuestion', summary: questions[0] && questions[0].question };
    setStatus('waiting', 'Needs you');
    stopWorking();
    alertBox.textContent = 'Claude is asking you a question.';
    return card;
  }

  /* -------------------------------------------------------------- gates */

  function showNudge(text, onClick) {
    nudge.hidden = false;
    nudge.textContent = text;
    nudge.onclick = onClick || null;
  }
  function hideNudge() { nudge.hidden = true; nudge.onclick = null; }

  /* A turn that ends with no tool call means Claude is waiting on a reply. That
     is heuristic-free, and it is what makes a command's gates impossible to
     walk past. */
  function turnEnded() {
    stopWorking();
    if (pendingPerm) return;
    const a = blk('gate', '⏸');
    const body = a.querySelector('.body');
    body.appendChild(el('b', null, 'Claude is waiting for you'));
    const grow = el('div', 'grow');
    const go = el('button', null, 'Confirm');
    go.type = 'button';
    go.addEventListener('click', () => {
      input.value = 'Yes — confirmed, continue.';
      input.focus();
    });
    grow.appendChild(go);
    body.appendChild(grow);
    add(a);
    setStatus('waiting', 'Waiting for you');
    if (!input.value) input.placeholder = 'Claude is waiting on your answer ↑';
    say('Claude is waiting for your reply');
  }

  /* -------------------------------------------------------------- states */

  function stateView(build) {
    feed.textContent = '';
    const s = el('div', 'state');
    build(s);
    feed.appendChild(s);
  }

  function emptyState() {
    stateView((s) => {
      s.appendChild(el('h2', null, 'Agentic Workflow'));
      s.appendChild(el('p', null, 'A Claude Code conversation, in this panel. Pick a workflow or just type below.'));
      for (const sc of shortcuts) {
        const b = el('button', 'sc');
        b.type = 'button';
        b.appendChild(el('span', 'cmd', sc.command));
        b.appendChild(el('span', 'kick', sc.kicker));
        b.appendChild(el('span', 'out', sc.blurb));
        b.appendChild(el('span', 'gates',
          '●'.repeat(sc.gates) + '○'.repeat(3 - sc.gates) +
          `  stops for you ${sc.gates === 1 ? 'once' : sc.gates + ' times'}  ·  runs in ${short(sc.cwd)}`));
        b.addEventListener('click', () => useShortcut(sc.id));
        s.appendChild(b);
      }
    });
  }

  function errorState(code, message, detail) {
    stateView((s) => {
      s.appendChild(el('span', 'warnmark', '⚠'));
      if (code === 'AUTH_FAILED') {
        s.appendChild(el('h2', null, 'Claude Code is not signed in'));
        s.appendChild(el('p', null, 'The CLI that ships with the desktop app keeps its own login. Run this once in a terminal, then reopen this panel:'));
        s.appendChild(el('code', null, '"%APPDATA%\\Claude\\claude-code\\2.1.260\\claude.exe" setup-token'));
      } else if (code === 'CLI_NOT_FOUND') {
        s.appendChild(el('h2', null, 'Could not find the Claude Code CLI'));
        s.appendChild(el('p', null, detail || 'The Claude Code desktop app does not appear to be installed.'));
      } else {
        s.appendChild(el('h2', null, 'The session stopped'));
        s.appendChild(el('p', null, message || 'Something went wrong.'));
        if (detail) s.appendChild(el('code', null, detail));
      }
      const btns = el('div', 'btns');
      const retry = el('button', null, 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => newConversation());
      btns.appendChild(retry);
      s.appendChild(btns);
    });
    setStatus('error', 'Stopped');
    stopWorking();
  }

  /* ------------------------------------------------------------- events */

  function apply(ev) {
    if (ev.seq && ev.seq <= lastSeq) return;      // replayed during attach
    if (ev.seq) lastSeq = ev.seq;

    switch (ev.kind) {
      case 'ready':
        if (feed.querySelector('.state')) feed.textContent = '';
        setStatus(null);
        break;
      case 'user':        finishText(); openThink = null; userBlock(ev.text); startWorking('Thinking'); break;
      case 'text-delta':  pushText(ev.text); break;
      case 'thinking-delta': pushThinking(ev.text); break;
      case 'assistant':
        openThink = null;
        finishText(ev.text || '');
        break;
      case 'tool-start':  finishText(); toolBlock(ev); break;
      case 'tool-result': toolResult(ev); break;
      case 'todos':       renderTodos(ev.items); break;
      case 'permission-request': finishText(); permCard(ev); break;
      case 'question':    finishText(); questionCard(ev); break;
      case 'permission-resolved': permResolved(ev); break;
      case 'permission-auto': break;
      case 'result': {
        finishText();
        const a = blk('result', '');
        a.dataset.err = ev.isError ? '1' : '0';
        const secs = Math.round((ev.durationMs || 0) / 1000);
        const u = ev.usage || {};
        a.querySelector('.body').textContent =
          `${ev.isError ? 'ERROR' : 'DONE'} · ${secs}s` +
          (u.input_tokens != null ? ` · ${fmtK(u.input_tokens)} in / ${fmtK(u.output_tokens)} out` : '') +
          (typeof ev.totalCostUsd === 'number' ? ` · $${ev.totalCostUsd.toFixed(3)}` : '');
        add(a);
        if (!ev.isError) { turnEnded(); flushQueued(); }
        else { stopWorking(); setStatus('error', 'Stopped'); }
        break;
      }
      case 'aborted':
        finishText();
        add(blk('note', '⊘')).querySelector('.body').textContent = 'Interrupted.';
        stopWorking(); setStatus(null);
        break;
      case 'error':
        if (ev.code === 'AUTH_FAILED' || ev.code === 'CLI_NOT_FOUND'
            || !feed.children.length || feed.querySelector('.state')) {
          errorState(ev.code, ev.message, ev.detail);
        }
        else {
          const a = blk('crash', '✗');
          const body = a.querySelector('.body');
          body.appendChild(el('b', null, ev.code === 'AUTH_FAILED' ? 'Claude Code is not signed in' : 'The session stopped unexpectedly'));
          body.appendChild(el('p', null, ev.message || ''));
          add(a);
          setStatus('error', 'Stopped'); stopWorking();
        }
        break;
      case 'closed': stopWorking(); break;
      default: break;
    }
  }

  function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0); }

  /* -------------------------------------------------------- composer */

  function flushQueued() {
    if (!queued) return;
    const text = queued;
    queued = null;
    queuedBox.hidden = true;
    doSend(text);
  }

  function doSend(text) {
    hideNudge();
    input.placeholder = 'Ask Claude, or press / for a command';
    window.chat.send({ localId: session && session.localId, text }).then((r) => {
      if (r && !r.ok && r.code === 'NO_SESSION') newConversation(text);
    });
  }

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (sendBtn.dataset.stop === '1') {
      window.chat.interrupt({ localId: session && session.localId });
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (!session) { newConversation(text); return; }
    if (session.state === 'thinking' || sticky.hidden === false) {
      queued = text;
      queuedBox.hidden = false;
      queuedBox.textContent = '';
      queuedBox.appendChild(document.createTextNode('queued · ' + middleEllipsis(text, 48)));
      const x = el('button', null, '✕');
      x.type = 'button';
      x.addEventListener('click', () => { queued = null; queuedBox.hidden = true; });
      queuedBox.appendChild(x);
      return;
    }
    doSend(text);
  });

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').requestSubmit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!$('#slashmenu').hidden) { closeSlash(); return; }
      if (sendBtn.dataset.stop === '1') window.chat.interrupt({ localId: session && session.localId });
    }
  });

  input.addEventListener('input', () => {
    if (input.value === '/') openSlash();
    else if (!input.value.startsWith('/')) closeSlash();
  });

  /* Permission keys, live only while a prompt is pending and armed. */
  window.addEventListener('keydown', (e) => {
    if (!pendingPerm || Date.now() < armAt) return;
    const typing = document.activeElement === input && input.value.trim();
    if (typing) return;
    if (e.key === 'Enter') { e.preventDefault(); decide(pendingPerm.requestId, { behavior: 'allow' }); }
    else if (e.key.toLowerCase() === 'a') { e.preventDefault(); decide(pendingPerm.requestId, { behavior: 'allow', always: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); decide(pendingPerm.requestId, { behavior: 'deny' }); }
  });

  /* --------------------------------------------------------- shortcuts */

  function openSlash() {
    const m = $('#slashmenu');
    m.textContent = '';
    shortcuts.forEach((sc, idx) => {
      const b = el('button', 'row');
      b.type = 'button';
      b.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      b.appendChild(el('span', 'cmd', sc.command));
      b.appendChild(el('span', 'kick', sc.kicker));
      b.appendChild(el('span', 'out', sc.blurb));
      b.addEventListener('click', () => { closeSlash(); useShortcut(sc.id); });
      m.appendChild(b);
    });
    m.hidden = false;
  }
  function closeSlash() { $('#slashmenu').hidden = true; }

  async function useShortcut(id) {
    closeSlash();
    const r = await window.chat.slash({ localId: session && session.localId, shortcut: id });
    if (!r || !r.ok) return;
    if (r.needsNew) {
      const made = await window.chat.newChat({ shortcut: id });
      if (!made || !made.ok) { errorState('SDK_CRASH', made && made.error); return; }
      session = made.session;
      lastSeq = 0;
      feed.textContent = '';
    }
    // Pre-fill rather than send: each of these starts a long, costly run and
    // usually wants a sentence of context.
    input.value = r.command + ' ';
    input.placeholder = 'add your idea, notes, or a Jira ID…';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /* --------------------------------------------------------- sessions */

  async function newConversation(thenSend) {
    const r = await window.chat.newChat({});
    if (!r || !r.ok) { errorState('SDK_CRASH', (r && r.error) || 'Could not start a conversation.'); return; }
    session = r.session;
    lastSeq = 0;
    feed.textContent = '';
    tools = new Map(); todoBlock = null; openText = null; openThink = null;
    setTitle(session.title);
    if (thenSend) doSend(thenSend);
  }

  function setTitle(t) { $('#s-title-t').textContent = t || 'New conversation'; }

  async function openDrawer() {
    const d = $('#drawer');
    d.hidden = false;
    $('#s-title').setAttribute('aria-expanded', 'true');
    const list = $('#dr-list');
    list.textContent = '';
    const r = await window.chat.sessions();
    const rows = (r && r.sessions) || [];
    if (!rows.length) { list.appendChild(el('div', 'dr-empty', 'No past conversations yet.')); return; }
    for (const s of rows) {
      const b = el('button', 'dr-row');
      b.type = 'button';
      if (session && s.sdkSessionId === session.sdkSessionId) b.setAttribute('aria-current', 'true');
      b.appendChild(el('span', 't', s.title));
      b.appendChild(el('span', 'm', [short(s.cwd), s.messageCount != null ? s.messageCount + ' messages' : null,
        s.live ? 'open' : null].filter(Boolean).join(' · ')));
      b.addEventListener('click', async () => {
        closeDrawer();
        const res = await window.chat.resume({ sdkSessionId: s.sdkSessionId, fork: true });
        if (res && res.ok) {
          session = res.session; lastSeq = 0; feed.textContent = '';
          tools = new Map(); todoBlock = null;
          setTitle(session.title);
          const h = await window.chat.history({ sdkSessionId: s.sdkSessionId });
          for (const ev of (h && h.transcript) || []) apply({ ...ev, seq: 0 });
        }
      });
      list.appendChild(b);
    }
  }
  function closeDrawer() {
    $('#drawer').hidden = true;
    $('#s-title').setAttribute('aria-expanded', 'false');
  }

  $('#s-title').addEventListener('click', openDrawer);
  $('#dr-close').addEventListener('click', closeDrawer);
  $('#dr-scrim').addEventListener('click', closeDrawer);
  $('#dr-new').addEventListener('click', () => { closeDrawer(); newConversation(); });
  $('#s-new').addEventListener('click', () => newConversation());
  $('#c-slash').addEventListener('click', () => {
    if ($('#slashmenu').hidden) openSlash(); else closeSlash();
  });

  /* ------------------------------------------------------------- boot */

  window.chat.onEvent((payload) => {
    if (session && payload.localId && payload.localId !== session.localId) return;
    apply(payload);
  });
  window.chat.onSessionsChanged(() => {
    if (!$('#drawer').hidden) openDrawer();
  });

  (async function boot() {
    const r = await window.chat.attach();
    if (!r || !r.ok) { errorState('SDK_CRASH', 'Could not reach the session manager.'); return; }
    workspace = r.workspace;
    shortcuts = r.shortcuts || [];
    session = r.session;
    if (!session) { emptyState(); return; }
    setTitle(session.title);
    lastSeq = 0;
    for (const ev of session.transcript || []) apply(ev);
    lastSeq = session.lastSeq || 0;
    for (const p of session.pending || []) {
      if (p.tool === 'AskUserQuestion') questionCard({ ...p, input: p.input });
      else permCard(p);
    }
    if (session.state === 'error' && session.error) errorState(session.error.code, session.error.message);
  })();
})();
