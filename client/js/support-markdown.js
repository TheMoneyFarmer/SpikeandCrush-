'use strict';

// Tiny, safe markdown for support messages and KB previews. Everything is
// HTML-escaped first; only a fixed set of constructs is then turned back into
// markup: **bold**, *italic*, `code`, [text](https://... | mailto:...), "- "
// and "1. " lists, "#" headings (rendered as bold lines) and paragraphs.
// Raw HTML in a message is shown as text, never rendered. Links open in a new
// tab with rel="noopener noreferrer nofollow".
(function (root) {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function inline(text) {
    let s = esc(text);
    const codes = [];
    s = s.replace(/`([^`\n]{1,200})`/g, (m, c) => {
      codes.push(`<code>${c}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    // Links: the URL was escaped above, so quotes can't break out of href.
    s = s.replace(/\[([^\]\n]{1,200})\]\(((?:https?:\/\/|mailto:)[^\s)]{1,500})\)/g, (m, label, url) => {
      if (!/^(https?:\/\/|mailto:)/i.test(url.replace(/&amp;/g, '&'))) return m;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
    });
    s = s.replace(/\*\*([^*\n]{1,300})\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]{1,300})\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
    return s;
  }

  function render(md) {
    const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const type = ul ? 'ul' : 'ol';
        if (list !== type) {
          closeList();
          out.push(`<${type}>`);
          list = type;
        }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
      } else if (h) {
        flushPara();
        closeList();
        out.push(`<p><strong>${inline(h[1])}</strong></p>`);
      } else if (!line.trim()) {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
    return out.join('');
  }

  const api = { render, escape: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.TW = root.TW || {};
    root.TW.supportMarkdown = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
