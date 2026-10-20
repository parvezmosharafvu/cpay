// Builds public/admin-guide-bn.html (the Admin → System guide tab) from
// docs/SYSTEM-GUIDE-BN.md. Tiny Markdown subset: headings, paragraphs,
// lists, tables, inline code, bold, links, <a id> anchors. No dependencies.
// Usage: node scripts/build-admin-guide.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = root + 'docs/SYSTEM-GUIDE-BN.md';
const OUT = root + 'public/admin-guide-bn.html';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  const parts = s.split(/(`[^`]+`)/);
  return parts.map((p) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return `<code>${esc(p.slice(1, -1))}</code>`;
    let t = esc(p).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => {
      const h = href.startsWith('#') ? '#guide-' + href.slice(1) : (/^https:\/\//.test(href) ? href : '#');
      return `<a href="${h}"${h.startsWith('#') ? '' : ' rel="noopener" target="_blank"'}>${txt}</a>`;
    });
    return t;
  }).join('');
}
// tests/frontend/design-system.test.mjs keeps these names out of public/.
// The admin page shows a plain label instead; the markdown keeps the names.
const MASK = [
  [/SUPABASE_SERVICE_ROLE_KEY/g, 'Supabase-এর server key (নাম: docs/SYSTEM-GUIDE-BN.md)'],
  [/BREEZ_MNEMONIC/g, 'Wallet-এর ১২/২৪ শব্দ (নাম: docs/SYSTEM-GUIDE-BN.md)'],
  [/PAYMENT_SERVICE_SECRET/g, 'Function ↔ wallet shared secret (নাম: docs/SYSTEM-GUIDE-BN.md)'],
];
export function render(md) {
  for (const [re, label] of MASK) md = md.replace(new RegExp('`' + re.source + '`', 'g'), label).replace(re, label);
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^<a id="([a-z0-9-]+)"><\/a>$/))) { out.push(`<span id="guide-${m[1]}" class="guide-anchor"></span>`); i++; continue; }
    if ((m = l.match(/^(#{1,4}) (.*)$/))) { const n = Math.min(m[1].length + 1, 5); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push('<div class="scroll"><table class="table rtable"><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c, k) => `<td data-label="${esc(head[k] || '')}">${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^(\d+\.|-) /.test(l)) {
      const ordered = /^\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) items.push(lines[i++].replace(/^(\d+\.|-) /, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((x) => `<li>${inline(x)}</li>`).join('') + `</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||<a id|\d+\. |- )/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return '<!-- Generated from docs/SYSTEM-GUIDE-BN.md by scripts/build-admin-guide.mjs. Do not edit by hand. No secrets. -->\n'
    + '<div class="guide-body" lang="bn">\n' + out.join('\n') + '\n</div>\n';
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const html = render(readFileSync(SRC, 'utf8'));
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== html) { console.error('public/admin-guide-bn.html is out of date: run node scripts/build-admin-guide.mjs'); process.exit(1); }
    console.log('ok   admin guide up to date');
  } else { writeFileSync(OUT, html); console.log('wrote public/admin-guide-bn.html'); }
}
