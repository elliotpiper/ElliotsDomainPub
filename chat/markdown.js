/* A small markdown renderer that builds DOM directly.
 *
 * It never touches innerHTML, so there is no XSS surface to sanitise - which is
 * a smaller security story than a parser plus DOMPurify, and keeps this app at
 * zero runtime dependencies. It supports only the subset these workflows emit;
 * anything it does not recognise falls through as plain text rather than
 * breaking.
 *
 * The one rule that must be exactly right: a fence closes only on a run of the
 * SAME character, at least as long as the opening run, with nothing after it.
 * A command that prints an entire document - one which itself contains ```
 * fences - nests it inside a ```` fence. */

(function (global) {
  'use strict';

  const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+.-]*)\s*$/;
  const HEADING = /^(#{1,4})\s+(.*)$/;
  const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const UL = /^(\s*)[-*+]\s+(.*)$/;
  const OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

  const CLAMP_LINES = 24;

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /* ---------------------------------------------------------- inline */

  // Splits on the inline constructs we support, innermost handling by recursion.
  function inline(target, text) {
    let i = 0;
    const push = (s) => { if (s) target.appendChild(document.createTextNode(s)); };
    let buf = '';

    while (i < text.length) {
      const ch = text[i];

      if (ch === '\\' && i + 1 < text.length && /[\\`*_[\]()~#>+-.!]/.test(text[i + 1])) {
        buf += text[i + 1]; i += 2; continue;
      }

      if (ch === '`') {
        const run = /^`+/.exec(text.slice(i))[0];
        const close = text.indexOf(run, i + run.length);
        if (close > -1) {
          push(buf); buf = '';
          const code = el('code');
          code.textContent = text.slice(i + run.length, close);
          target.appendChild(code);
          i = close + run.length; continue;
        }
      }

      if (ch === '[') {
        const m = /^\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(i));
        if (m) {
          push(buf); buf = '';
          const a = el('a');
          a.textContent = m[1];
          a.dataset.href = m[2];              // resolved by the click handler, never navigated
          a.setAttribute('role', 'link');
          a.tabIndex = 0;
          target.appendChild(a);
          i += m[0].length; continue;
        }
      }

      if (ch === '*' || ch === '_') {
        const run = text[i + 1] === ch ? 2 : 1;
        const marker = ch.repeat(run);
        const close = text.indexOf(marker, i + run);
        if (close > -1 && close > i + run) {
          push(buf); buf = '';
          const node = el(run === 2 ? 'strong' : 'em');
          inline(node, text.slice(i + run, close));
          target.appendChild(node);
          i = close + run; continue;
        }
      }

      if (ch === '~' && text[i + 1] === '~') {
        const close = text.indexOf('~~', i + 2);
        if (close > -1) {
          push(buf); buf = '';
          const node = el('del');
          inline(node, text.slice(i + 2, close));
          target.appendChild(node);
          i = close + 2; continue;
        }
      }

      buf += ch; i++;
    }
    push(buf);
  }

  /* ----------------------------------------------------------- blocks */

  function codeBlock(lang, lines) {
    const wrap = el('div', 'md-code');
    const head = el('header');
    head.appendChild(document.createTextNode(lang || 'text'));
    const copy = el('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(lines.join('\n')).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      }, () => {});
    });
    head.appendChild(copy);
    wrap.appendChild(head);

    const pre = el('pre');
    const shown = lines.length > CLAMP_LINES ? lines.slice(0, CLAMP_LINES) : lines;
    pre.textContent = shown.join('\n');
    wrap.appendChild(pre);

    if (lines.length > CLAMP_LINES) {
      wrap.classList.add('clamped');
      const more = el('button', 'more');
      more.type = 'button';
      more.textContent = `Show all ${lines.length} lines`;
      more.addEventListener('click', () => {
        wrap.classList.remove('clamped');
        // fill in slices so a 1200-line document never blocks the frame
        let n = CLAMP_LINES;
        (function step() {
          if (n >= lines.length) { more.remove(); return; }
          const slice = lines.slice(n, n + 200);
          pre.appendChild(document.createTextNode('\n' + slice.join('\n')));
          n += slice.length;
          requestAnimationFrame(step);
        })();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function tableBlock(rows) {
    const wrap = el('div', 'md-tablewrap');
    const table = el('table');
    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((s) => s.trim());
    const thead = el('thead');
    const htr = el('tr');
    for (const c of cells(rows[0])) { const th = el('th'); inline(th, c); htr.appendChild(th); }
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (let r = 2; r < rows.length; r++) {
      const tr = el('tr');
      for (const c of cells(rows[r])) { const td = el('td'); inline(td, c); tr.appendChild(td); }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function listBlock(items, ordered) {
    const list = el(ordered ? 'ol' : 'ul');
    for (const it of items) {
      const li = el('li');
      inline(li, it);
      list.appendChild(li);
    }
    return list;
  }

  function render(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src == null ? '' : src).split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const fence = FENCE.exec(line);
      if (fence) {
        const marker = fence[2];
        const lang = fence[3];
        const body = [];
        i++;
        while (i < lines.length) {
          const m = FENCE.exec(lines[i]);
          // closes only on the same char, at least as long, nothing after it
          if (m && m[2][0] === marker[0] && m[2].length >= marker.length) { i++; break; }
          body.push(lines[i]); i++;
        }
        frag.appendChild(codeBlock(lang, body));
        continue;
      }

      if (!line.trim()) { i++; continue; }

      if (HR.test(line)) { frag.appendChild(el('hr')); i++; continue; }

      const h = HEADING.exec(line);
      if (h) {
        const node = el('h' + h[1].length);
        inline(node, h[2].trim());
        frag.appendChild(node); i++; continue;
      }

      if (QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && QUOTE.test(lines[i])) { buf.push(QUOTE.exec(lines[i])[1]); i++; }
        const bq = el('blockquote');
        bq.appendChild(render(buf.join('\n')));
        frag.appendChild(bq); continue;
      }

      if (lines[i + 1] && line.includes('|') && TABLE_SEP.test(lines[i + 1])) {
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(lines[i]); i++; }
        if (rows.length >= 2) { frag.appendChild(tableBlock(rows)); continue; }
      }

      if (UL.test(line) || OL.test(line)) {
        const ordered = OL.test(line);
        const items = [];
        while (i < lines.length && (ordered ? OL.test(lines[i]) : UL.test(lines[i]))) {
          const m = ordered ? OL.exec(lines[i]) : UL.exec(lines[i]);
          items.push(ordered ? m[3] : m[2]);
          i++;
        }
        frag.appendChild(listBlock(items, ordered)); continue;
      }

      // paragraph: consume until a blank line or the start of another block
      const para = [];
      while (i < lines.length && lines[i].trim() &&
             !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i]) &&
             !QUOTE.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) {
        const p = el('p');
        inline(p, para.join('\n'));
        frag.appendChild(p);
      } else { i++; }
    }

    return frag;
  }

  /* Is the text currently inside an unterminated fence? Used by the streaming
     tail so we never promote a half-written code block. */
  function insideFence(text) {
    let open = null;
    for (const line of String(text || '').split('\n')) {
      const m = FENCE.exec(line);
      if (!m) continue;
      if (!open) open = m[2];
      else if (m[2][0] === open[0] && m[2].length >= open.length) open = null;
    }
    return !!open;
  }

  global.MD = { render, insideFence };
})(window);
