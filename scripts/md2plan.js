/* docs/项目计划书.md → frontend/plan.html
   生成品牌阅读页（目录 / 正文 / 可打印），保持 IV 字体与工作台嵌入。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'docs', '项目计划书.md'), 'utf8');
const out = path.join(ROOT, 'frontend', 'plan.html');

/* ── 行内标记 ── */
function inline(s) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => /^(https?:)?\/\//.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : `<a href="${u}">${t}</a>`);
}

/* ── 分块解析 ── */
const lines = src.split(/\r?\n/);
const body = [];
const toc = [];
let i = 0;
const slug = t => 's-' + t.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

while (i < lines.length) {
  const ln = lines[i];

  // 代码围栏
  if (/^```/.test(ln)) {
    const lang = ln.slice(3).trim();
    const buf = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
    i++;
    body.push(`<pre class="code"><code>${inline(buf.join('\n'))}</code></pre>`);
    continue;
  }
  // 标题
  const h = ln.match(/^(#{1,4})\s+(.*)$/);
  if (h) {
    const lv = h[1].length, t = h[2].trim(), id = slug(t);
    if (lv <= 2) toc.push([lv, t, id]);
    body.push(`<h${lv} id="${id}" class="h${lv}">${inline(t)}</h${lv}>`);
    i++; continue;
  }
  // 分隔线
  if (/^-{3,}$/.test(ln)) { body.push('<hr>'); i++; continue; }
  // 表格
  if (/^\|/.test(ln)) {
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
    const cells = r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const head = cells(rows[0]);
    const data = rows.slice(2).map(cells);
    body.push(`<div class="tw"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
      data.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
      `</tbody></table></div>`);
    continue;
  }
  // 引用
  if (/^>\s?/.test(ln)) {
    const buf = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
    body.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    continue;
  }
  // 列表
  if (/^\s*([-*]|\d+\.)\s+/.test(ln)) {
    const ordered = /^\s*\d+\./.test(ln);
    const buf = [];
    while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++; }
    body.push(`<${ordered ? 'ol' : 'ul'}>${buf.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    continue;
  }
  // 空行
  if (!ln.trim()) { i++; continue; }
  // 段落
  const buf = [];
  while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||>|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
  if (buf.length) body.push(`<p>${inline(buf.join(' '))}</p>`);
}

const tocHtml = toc.map(([lv, t, id]) =>
  `<a class="t${lv === 1 ? ' t1' : ''}" href="#${id}">${esc(t)}</a>`).join('');
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aegis 神盾 · ComputeShield 项目计划书</title>
<link rel="stylesheet" href="insurer.css">
<link rel="stylesheet" href="motion.css">
<style>
.doc-wrap { display: grid; grid-template-columns: 268px 1fr; gap: 34px; max-width: 1240px; margin: 0 auto; padding: 34px 24px 90px; align-items: start; }
.toc { position: sticky; top: 74px; max-height: calc(100vh - 96px); overflow-y: auto; border-left: 1px solid var(--line); padding-left: 14px; }
.toc .tl { font-family: var(--mono); font-size: 9.5px; letter-spacing: .2em; color: var(--muted); margin-bottom: 10px; }
.toc a { display: block; font-size: 12px; color: var(--muted); padding: 4px 0; line-height: 1.45; border: 0; }
.toc a:hover { color: var(--ink); }
.toc a.t1 { font-weight: 700; color: var(--ink); margin-top: 10px; font-size: 12.5px; }
.doc { min-width: 0; }
.doc h1 { font-size: clamp(28px, 4vw, 42px); font-weight: 900; letter-spacing: -.035em; line-height: 1.08; margin-bottom: 6px; }
.doc h1 + p { color: var(--muted); font-family: var(--mono); font-size: 11px; letter-spacing: .05em; }
.doc h2 { font-size: 21px; font-weight: 800; letter-spacing: -.02em; margin: 44px 0 14px; padding-top: 18px; border-top: 1px solid var(--line); }
.doc h3 { font-size: 15.5px; font-weight: 700; margin: 26px 0 10px; }
.doc h4 { font-family: var(--mono); font-size: 10.5px; letter-spacing: .18em; color: var(--muted); font-weight: 400; margin: 20px 0 8px; }
.doc p { font-size: 13.5px; line-height: 1.95; margin: 10px 0; }
.doc ul, .doc ol { font-size: 13.5px; line-height: 1.9; margin: 10px 0 10px 20px; }
.doc li { margin: 3px 0; }
.doc hr { border: 0; border-top: 1px solid var(--line); margin: 34px 0; }
.doc blockquote { border-left: 3px solid var(--ink); padding: 2px 0 2px 14px; color: var(--muted); font-size: 12.5px; line-height: 1.8; margin: 14px 0; }
.doc code { font-family: var(--mono); font-size: .88em; background: #f1f1ef; padding: 1px 5px; }
.doc pre.code { background: #fbfbfa; border: 1px solid var(--line); padding: 14px 16px; overflow-x: auto; margin: 14px 0; }
.doc pre.code code { background: none; padding: 0; font-size: 11.5px; line-height: 1.75; }
.tw { overflow-x: auto; margin: 16px 0; border: 1px solid var(--line); }
.doc table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.doc th { background: #f6f6f4; font-family: var(--mono); font-size: 10px; letter-spacing: .12em; color: var(--muted); font-weight: 400; text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.doc td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; line-height: 1.7; }
.doc tr:last-child td { border-bottom: 0; }
.doc strong { font-weight: 700; }
.doc a { text-decoration: underline; text-underline-offset: 2px; }
@media (max-width: 900px) {
  .doc-wrap { grid-template-columns: 1fr; gap: 20px; padding: 22px 16px 70px; }
  .toc { position: static; max-height: none; border-left: 0; border-top: 1px solid var(--line); padding: 14px 0 0; }
  .toc a { display: inline-block; margin-right: 14px; }
}
@media print {
  .hd, .toc, .pg-hd { display: none !important; }
  .doc-wrap { display: block; padding: 0; max-width: none; }
  .doc h2 { page-break-after: avoid; }
  .tw, .doc pre.code { page-break-inside: avoid; }
}
</style>
<link rel="stylesheet" href="assets/fonts/MiSans-Regular.min.css">
<link rel="stylesheet" href="assets/fonts/MiSans-Medium.min.css">
<link rel="stylesheet" href="assets/fonts/MiSans-Semibold.min.css">
<link rel="stylesheet" href="assets/fonts/MiSans-Bold.min.css">
<link rel="stylesheet" href="suite-theme.css">
<script>if(parent!==window&&new URLSearchParams(location.search).has('embed'))document.documentElement.classList.add('workbench-embedded');</script>
<link rel="stylesheet" href="embedded.css">
</head>
<body data-suite="plan">

<header class="hd">
  <div class="hd-in">
    <a class="lg" href="insurer.html">Aegis 神盾<span class="lg-tag">PROJECT PLAN</span></a>
    <nav class="nv">
      <a href="insurer.html"><span class="idx">01</span>保险核心</a>
      <a href="lab.html"><span class="idx">02</span>智能体实验室</a>
      <a href="index.html"><span class="idx">03</span>协议演示</a>
      <a href="market.html"><span class="idx">04</span>行情终端</a>
      <span class="vsep"></span>
      <a class="on">项目计划书</a>
      <a href="evidence.html">项目验证</a>
    </nav>
    <div class="hd-r">
      <button class="btn" onclick="window.print()">打印 / 导出 PDF</button>
    </div>
  </div>
</header>

<div class="doc-wrap">
  <aside class="toc"><div class="tl">— CONTENTS</div>${tocHtml}</aside>
  <main class="doc">${body.join('\n')}</main>
</div>

<script>
// 滚动高亮当前章节
const links = [...document.querySelectorAll('.toc a')];
const io = new IntersectionObserver(es => {
  es.forEach(e => {
    if (!e.isIntersecting) return;
    links.forEach(a => a.style.color = (a.getAttribute('href') === '#' + e.target.id ? 'var(--ink)' : ''));
  });
}, { rootMargin: '-80px 0px -70% 0px' });
document.querySelectorAll('.doc h2, .doc h3').forEach(h => io.observe(h));
</script>
<script src="suite-ui.js"></script>
<script src="embedded.js"></script>
</body>
</html>
`;

fs.writeFileSync(out, html, 'utf8');
console.log('生成 ' + out);
console.log('正文块 ' + body.length + ' 个 · 目录项 ' + toc.length + ' 条 · ' + (html.length / 1024).toFixed(1) + ' KB');
