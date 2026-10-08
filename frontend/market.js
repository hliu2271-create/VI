/* ============================================================
   Aegis 神盾 · 算力保险行情终端
   标的 = 保单合约 / 节点信用 / LP 份额，报价 = 年化保费率 %
   行情由链下风控Agent驱动，并可与真实算力节点服务联动
   ============================================================ */

const M = { tab: 'ts', active: 'CS-A01', min: 0, tick: 0 };
const SRV_DEFAULT = 'http://127.0.0.1:8787';
let srvUrl = SRV_DEFAULT, srvUp = false, srvFails = 0, srvRisk = 12, srvLat = 0, srvUptime = 0;

const $ = (id) => document.getElementById(id);
const r2 = (n) => Math.round(n * 100) / 100;
const fmtV = (n) => n >= 10000 ? (n / 10000).toFixed(2) + '万' : Math.round(n).toLocaleString('en-US');
const cls = (n) => n > 0 ? 'up' : (n < 0 ? 'down' : 'flat');
const sign = (n) => (n > 0 ? '+' : '') + n.toFixed(2);
const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function fmtMin(m) {
  const t = 9 * 60 + 30 + m;
  const h = Math.floor(t / 60) % 24, mm = t % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
function toast(msg, kind) {
  $('toast').insertAdjacentHTML('beforeend',
    `<div class="toast" style="padding:9px 14px;border-radius:8px;background:#fff;border:1px solid #d8dee8;
      border-left:3px solid ${kind === 'danger' ? '#e0393e' : (kind === 'warn' ? '#f59e0b' : '#15803d')};
      font-size:12.5px;box-shadow:0 8px 24px -12px rgba(15,23,42,.3);max-width:320px">${msg}</div>`);
  setTimeout(() => { const t = $('toast').firstChild; if (t) t.remove(); }, 4000);
}

/* ---------------- 标的 ---------------- */
const SYMS = [
  { code: 'CS-A01', name: 'Aegis 主网算力保单', base: 6.2, risk: 12, real: true },
  { code: 'CS-B07', name: 'GPU 集群保单 · 7日', base: 7.8, risk: 26 },
  { code: 'CS-C12', name: '边缘节点保单 · 30日', base: 9.4, risk: 38 },
  { code: 'CS-D03', name: '存储算力保单 · 24h', base: 5.4, risk: 8 },
  { code: 'ND-A01', name: '节点信用 aegis-node-01', base: 5.0, risk: 12, real: true },
  { code: 'ND-B02', name: '节点信用 GPU-07', base: 6.6, risk: 28 },
  { code: 'RP-001', name: '风险池份额 LP', base: 1.08, risk: 0 },
];
function genK(base, n) {
  let p = base; const arr = [];
  const d = new Date(Date.now() - n * 86400000);
  for (let i = 0; i < n; i++) {
    const o = p, c = o * (1 + (Math.random() - 0.5) * 0.05);
    arr.push({
      d: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      o: r2(o), c: r2(c),
      h: r2(Math.max(o, c) * (1 + Math.random() * 0.015)),
      l: r2(Math.min(o, c) * (1 - Math.random() * 0.015)),
      v: Math.floor(Math.random() * 8000 + 2000),
    });
    d.setDate(d.getDate() + 1); p = c;
  }
  return arr;
}
function step(p) { return Math.max(0.2, p * (1 + (Math.random() - 0.48) * 0.006)); }
function initSym(s) {
  s.prev = r2(s.base * (1 + (Math.random() - 0.5) * 0.03));
  s.price = s.prev; s.open = s.prev; s.high = s.prev; s.low = s.prev;
  s.vol = Math.floor(Math.random() * 6000 + 1500);
  s.k = genK(s.base, 60);
  s.pts = []; s.ev = ''; s.pull = 0;
  let p = s.prev;
  for (let i = 0; i < 40; i++) { p = step(p); s.pts.push({ p: r2(p), v: Math.random() }); }
  s.price = s.pts[s.pts.length - 1].p;
  s.avg = r2(s.pts.reduce((a, b) => a + b.p, 0) / s.pts.length);
}
SYMS.forEach(initSym);
const POS = [
  { code: 'CS-A01', cost: 5.90, qty: 1200 },
  { code: 'CS-B07', cost: 8.10, qty: 600 },
  { code: 'RP-001', cost: 1.02, qty: 5000 },
];
let TRADES = [], NOTICES = [], PAYOUT = 0;
const sym = (c) => SYMS.find(s => s.code === c);

/* ---------------- 行情引擎 ---------------- */
function tick() {
  M.min++; M.tick++;
  SYMS.forEach(s => {
    let p = step(s.price);
    if (s.pull) p += (s.pull - p) * 0.05;               // 真实风险分牵引
    if (Math.random() < 0.012) p *= 1 + (Math.random() - 0.5) * 0.02; // 偶发跳价
    s.price = r2(p);
    s.high = Math.max(s.high, s.price); s.low = Math.min(s.low, s.price);
    const dv = Math.floor(Math.random() * 260 + 40);
    s.vol += dv;
    s.pts.push({ p: s.price, v: dv * (Math.random() * 0.8 + 0.2) });
    if (s.pts.length > 240) s.pts.shift();
    s.avg = r2(s.pts.reduce((a, b) => a + b.p, 0) / s.pts.length);
    const last = s.k[s.k.length - 1];
    last.c = s.price; last.h = Math.max(last.h, s.price); last.l = Math.min(last.l, s.price); last.v += dv;
    // 成交
    if (Math.random() < 0.75) {
      const dir = s.price >= s.prev ? 'B' : 'S';
      TRADES.unshift({ t: fmtMin(M.min), c: s.code, p: s.price, v: dv, d: dir });
      if (TRADES.length > 24) TRADES.pop();
    }
  });
  render();
}
setInterval(tick, 800);
setInterval(() => { $('clock').textContent = now(); }, 1000);

/* ---------------- 渲染 ---------------- */
function render() {
  renderIdx(); renderWatch(); renderHead(); renderBook();
  renderTrades(); renderPos(); renderNotice(); draw();
}
function renderIdx() {
  const avg = SYMS.reduce((a, s) => a + s.price / s.base, 0) / SYMS.length;
  const idx = r2(2400 * avg);
  const idxChg = r2((avg - 1) * 100);
  const nav = r2(1.06 + (avg - 1) * 0.4);
  const risk = Math.round(SYMS.reduce((a, s) => a + s.risk, 0) / SYMS.length);
  const items = [
    { n: 'Aegis 算力保险指数', v: idx.toFixed(2), c: idxChg },
    { n: '风险池净值 RP-NAV', v: nav.toFixed(3), c: r2((nav - 1.06) * 100) },
    { n: '今日自动赔付 (BOT)', v: fmtV(PAYOUT), c: 0 },
    { n: '平均风险分', v: risk, c: risk - 20 },
    { n: '在线节点 / 总数', v: `${srvUp ? 2 : 1}/2`, c: 0 },
  ];
  $('idxBar').innerHTML = items.map(i => `
    <div class="idx"><div class="n">${i.n}</div>
      <div class="v num ${cls(i.c)}">${i.v}</div>
      <div class="c ${cls(i.c)}">${i.c ? pct(i.c) : '—'}</div></div>`).join('');
}
function sparkSVG(s) {
  const pts = s.pts.slice(-30);
  const mn = Math.min(...pts.map(p => p.p)), mx = Math.max(...pts.map(p => p.p));
  const w = 58, h = 16, sp = (mx - mn) || 1;
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * w},${h - ((p.p - mn) / sp) * (h - 2) - 1}`).join(' ');
  const c = s.price >= s.prev ? '#e0393e' : '#17a34a';
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${d}" fill="none" stroke="${c}" stroke-width="1.2"/></svg>`;
}
function renderWatch() {
  $('watchN').textContent = SYMS.length + ' 个标的';
  $('watch').innerHTML = SYMS.map(s => {
    const ch = r2(s.price - s.prev), pc = r2(ch / s.prev * 100);
    return `<div class="w-row ${s.code === M.active ? 'on' : ''}" onclick="select('${s.code}')">
      <div><div class="nm">${s.name}${s.ev ? `<span class="tag-ev">${s.ev}</span>` : ''}</div>
        <div class="cd">${s.code}${s.real ? ' · 真实节点' : ''}</div>${sparkSVG(s)}</div>
      <div class="pv ${cls(ch)}">${s.price.toFixed(2)}</div>
      <div class="pc ${cls(ch)}">${pct(pc)}</div></div>`;
  }).join('');
}
function renderHead() {
  const s = sym(M.active);
  const ch = r2(s.price - s.prev), pc = r2(ch / s.prev * 100);
  $('symTitle').textContent = `${s.name} · ${s.code === 'RP-001' ? '份额净值' : '年化保费率 %'}`;
  $('sName').textContent = s.name; $('sCode').textContent = s.code;
  $('sEv').innerHTML = s.ev ? `<span class="tag-ev">${s.ev}</span>` : '';
  $('sPrice').textContent = s.price.toFixed(2);
  $('sPrice').className = 'px num ' + cls(ch);
  $('sChg').textContent = `${sign(ch)}  ${pct(pc)}`;
  $('sChg').className = 'ch num ' + cls(ch);
  $('sOpen').textContent = s.open.toFixed(2);
  $('sHigh').textContent = s.high.toFixed(2);
  $('sLow').textContent = s.low.toFixed(2);
  $('sPrev').textContent = s.prev.toFixed(2);
  $('sVol').textContent = fmtV(s.vol);
  $('sRisk').textContent = s.risk;
}
function renderBook() {
  const s = sym(M.active), mid = s.price;
  let h = '';
  for (let i = 5; i >= 1; i--) {
    const p = r2(mid * (1 + i * 0.0016));
    h += `<div class="bk-row"><span class="lb">卖${i}</span>
      <span class="p up">${p.toFixed(2)}</span>
      <span class="q">${Math.floor(Math.random() * 900 + 120)}</span>
      <span class="q">${Math.floor(Math.random() * 60 + 10)}</span></div>`;
  }
  h += `<div class="bk-sep"></div><div class="bk-mid"><span>现价</span><span class="${cls(r2(mid - s.prev))}">${mid.toFixed(2)}</span></div><div class="bk-sep"></div>`;
  for (let i = 1; i <= 5; i++) {
    const p = r2(mid * (1 - i * 0.0016));
    h += `<div class="bk-row"><span class="lb">买${i}</span>
      <span class="p down">${p.toFixed(2)}</span>
      <span class="q">${Math.floor(Math.random() * 900 + 120)}</span>
      <span class="q">${Math.floor(Math.random() * 60 + 10)}</span></div>`;
  }
  $('book').innerHTML = h;
}
function renderTrades() {
  $('trades').innerHTML = TRADES.slice(0, 16).map(t => `
    <div class="t-row ${t.c2 ? 'pay' : ''}">
      <span class="tm">${t.t}</span>
      <span class="pr ${t.d === 'B' ? 'up' : 'down'}">${t.p.toFixed(2)}</span>
      <span class="vo">${t.v}</span>
      <span class="dr ${t.d === 'B' ? 'up' : 'down'}">${t.d === 'B' ? '买' : '卖'}</span>
    </div>`).join('');
}
function renderPos() {
  let pl = 0;
  const rows = POS.map(p => {
    const s = sym(p.code), v = r2((s.price - p.cost) * p.qty);
    pl += v;
    return `<div class="p-row">
      <div><div class="nm">${s.name}</div><div class="cd">${p.code} · ${p.qty} 手</div></div>
      <div class="v">成本 ${p.cost.toFixed(2)}</div>
      <div class="v ${cls(r2(s.price - p.cost))}">${s.price.toFixed(2)}</div>
      <div class="pl ${cls(v)}">${v > 0 ? '+' : ''}${fmtV(Math.abs(v))}</div></div>`;
  }).join('');
  $('pos').innerHTML = rows;
  $('posSum').innerHTML = `浮动盈亏 <span class="${cls(pl)}">${pl > 0 ? '+' : ''}${fmtV(Math.abs(pl))}</span> BOT`;
}
function renderNotice() {
  $('nN').textContent = NOTICES.length + ' 条';
  $('notice').innerHTML = NOTICES.slice(0, 20).map(n =>
    `<div class="n-row ${n.k}"><span class="tm">${n.t}</span><span>${n.m}</span></div>`).join('');
}
function notice(msg, k) {
  NOTICES.unshift({ t: now().slice(0, 8), m: msg, k: k || '' });
  if (NOTICES.length > 40) NOTICES.pop();
  renderNotice();
}

/* ---------------- Canvas 绘图 ---------------- */
function ctxOf(id) {
  const cv = $(id), r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  cv.width = r.width * d; cv.height = r.height * d;
  const c = cv.getContext('2d'); c.setTransform(d, 0, 0, d, 0, 0);
  c.clearRect(0, 0, r.width, r.height);
  return { c, w: r.width, h: r.height };
}
function draw() {
  const s = sym(M.active);
  if (M.tab === 'ts') { drawTS(s); drawVol(s); } else { drawK(s); drawKVol(s); }
}
function axes(c, w, h, pad, rows) {
  c.strokeStyle = '#eef1f6'; c.lineWidth = 1;
  for (let i = 0; i <= rows; i++) {
    const y = pad + (h - pad * 2) * i / rows;
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
  }
}
function drawTS(s) {
  const { c, w, h } = ctxOf('chart');
  const pad = 14, rw = w - 62;
  const dev = Math.max(...s.pts.map(p => Math.abs(p.p - s.prev)), 0.02);
  const mx = s.prev + dev * 1.1, mn = s.prev - dev * 1.1;
  const X = (i) => (i / Math.max(1, s.pts.length - 1)) * rw;
  const Y = (p) => pad + (mx - p) / (mx - mn) * (h - pad * 2);
  axes(c, rw, h, pad, 4);
  const up = s.price >= s.prev;
  const col = up ? '#e0393e' : '#17a34a';
  // 昨收虚线
  c.setLineDash([3, 3]); c.strokeStyle = '#c9cfda';
  c.beginPath(); c.moveTo(0, Y(s.prev)); c.lineTo(rw, Y(s.prev)); c.stroke(); c.setLineDash([]);
  // 填充
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, up ? 'rgba(224,57,62,.16)' : 'rgba(23,163,74,.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.beginPath(); c.moveTo(0, Y(s.pts[0].p));
  s.pts.forEach((p, i) => c.lineTo(X(i), Y(p.p)));
  c.lineTo(X(s.pts.length - 1), h); c.lineTo(0, h); c.closePath();
  c.fillStyle = g; c.fill();
  // 价格线
  c.beginPath(); s.pts.forEach((p, i) => i ? c.lineTo(X(i), Y(p.p)) : c.moveTo(X(i), Y(p.p)));
  c.strokeStyle = col; c.lineWidth = 1.6; c.stroke();
  // 均价线
  c.beginPath();
  let sum = 0;
  s.pts.forEach((p, i) => { sum += p.p; c.lineTo(X(i), Y(sum / (i + 1))); });
  c.strokeStyle = '#f59e0b'; c.lineWidth = 1; c.stroke();
  // 刻度
  c.fillStyle = '#9ca3af'; c.font = '11px ui-monospace,Consolas,monospace';
  c.fillText(mx.toFixed(2), rw + 6, pad + 4);
  c.fillText(s.prev.toFixed(2), rw + 6, Y(s.prev) + 4);
  c.fillText(mn.toFixed(2), rw + 6, h - pad + 4);
  const pc = (v) => ((v - s.prev) / s.prev * 100).toFixed(2) + '%';
  c.fillStyle = up ? '#e0393e' : '#17a34a';
  c.fillText(pc(mx), rw + 6, pad + 18);
  c.fillText(pc(mn), rw + 6, h - pad + 18);
  c.fillStyle = '#9ca3af';
  ['09:30', '10:30', '11:30/13:00', '14:00', '15:00'].forEach((t, i) =>
    c.fillText(t, Math.min(rw - 60, rw * i / 4), h - 2));
  // 当前点
  const lx = X(s.pts.length - 1), ly = Y(s.price);
  c.beginPath(); c.arc(lx, ly, 3, 0, 7); c.fillStyle = col; c.fill();
}
function drawVol(s) {
  const { c, w, h } = ctxOf('volCv');
  const rw = w - 62, pad = 4;
  const pts = s.pts.slice(-90);
  const mx = Math.max(...pts.map(p => p.v), 1);
  const bw = Math.max(1, rw / pts.length - 1);
  pts.forEach((p, i) => {
    const bh = (p.v / mx) * (h - pad * 2 - 8);
    c.fillStyle = i && p.p >= pts[i - 1].p ? 'rgba(224,57,62,.75)' : 'rgba(23,163,74,.75)';
    c.fillRect(i * (bw + 1), h - pad - 8 - bh, bw, bh);
  });
  c.fillStyle = '#9ca3af'; c.font = '11px ui-monospace,Consolas,monospace';
  c.fillText('成交量', 2, 12);
}
function drawK(s) {
  const { c, w, h } = ctxOf('chart');
  const pad = 14, rw = w - 62, n = 46;
  const ks = s.k.slice(-n);
  const mx = Math.max(...ks.map(k => k.h)), mn = Math.min(...ks.map(k => k.l));
  const X = (i) => (i + 0.5) * (rw / n);
  const Y = (p) => pad + (mx - p) / (mx - mn) * (h - pad * 2);
  axes(c, rw, h, pad, 4);
  const bw = Math.max(2, rw / n * 0.62);
  ks.forEach((k, i) => {
    const up = k.c >= k.o, col = up ? '#e0393e' : '#17a34a';
    c.strokeStyle = col; c.fillStyle = col;
    c.beginPath(); c.moveTo(X(i), Y(k.h)); c.lineTo(X(i), Y(k.l)); c.lineWidth = 1; c.stroke();
    const y1 = Y(Math.max(k.o, k.c)), y2 = Y(Math.min(k.o, k.c));
    c.fillRect(X(i) - bw / 2, y1, bw, Math.max(1, y2 - y1));
  });
  // MA5 / MA10
  const ma = (m) => ks.map((_, i) => {
    if (i < m - 1) return null;
    return ks.slice(i - m + 1, i + 1).reduce((a, b) => a + b.c, 0) / m;
  });
  [[ma(5), '#2563eb'], [ma(10), '#f59e0b']].forEach(([arr, col]) => {
    c.beginPath(); c.strokeStyle = col; c.lineWidth = 1;
    arr.forEach((v, i) => v == null ? null : (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
    c.stroke();
  });
  c.fillStyle = '#9ca3af'; c.font = '11px ui-monospace,Consolas,monospace';
  c.fillText(mx.toFixed(2), rw + 6, pad + 4);
  c.fillText(mn.toFixed(2), rw + 6, h - pad + 4);
  c.fillStyle = '#2563eb'; c.fillText('MA5', 2, 12);
  c.fillStyle = '#f59e0b'; c.fillText('MA10', 34, 12);
  ks.forEach((k, i) => { if (i % 12 === 0) c.fillStyle = '#9ca3af', c.fillText(k.d, X(i) - 12, h - 2); });
}
function drawKVol(s) {
  const { c, w, h } = ctxOf('volCv');
  const rw = w - 62, n = 46, ks = s.k.slice(-n), pad = 4;
  const mx = Math.max(...ks.map(k => k.v));
  const bw = Math.max(2, rw / n * 0.62);
  ks.forEach((k, i) => {
    const bh = (k.v / mx) * (h - pad * 2 - 8);
    c.fillStyle = k.c >= k.o ? 'rgba(224,57,62,.75)' : 'rgba(23,163,74,.75)';
    c.fillRect(X2(i) - bw / 2, h - pad - 8 - bh, bw, bh);
  });
  function X2(i) { return (i + 0.5) * (rw / n); }
}

/* ---------------- 交互 ---------------- */
function select(code) { M.active = code; render(); }
function setTab(t) {
  M.tab = t;
  document.querySelectorAll('.tab').forEach(e => e.classList.toggle('on', e.dataset.t === t));
  draw();
}
window.addEventListener('resize', draw);

/* ---------------- 真实算力节点联动 ---------------- */
async function jget(path, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 2500);
  try {
    const r = await fetch(srvUrl + path, { cache: 'no-store', signal: ctl.signal, mode: 'cors' });
    clearTimeout(t); return r.ok ? await r.json() : null;
  } catch (e) { clearTimeout(t); return null; }
}
function setSrvTxt(on, txt) {
  $('srvDot').className = 'dot' + (on ? '' : ' off');
  $('srvTxt').textContent = txt;
}
async function probeSrv() {
  const d = await jget('/health', 2500);
  if (d && d.status === 'ok') {
    const wasDown = !srvUp && srvFails > 0;
    srvUp = true; srvFails = 0; srvRisk = d.risk; srvLat = d.avgLatency; srvUptime = d.uptime;
    $('srvMeta').textContent = `延迟 ${d.avgLatency}ms · 风险分 ${d.risk} · uptime ${d.uptime}s`;
    setSrvTxt(true, '节点在线');
    // 风险分牵引真实标的报价（保费率 = 5% + 风险分 × 0.2%）
    SYMS.filter(s => s.real).forEach(s => { s.pull = 5 + d.risk * 0.2; s.risk = d.risk; });
    if (d.risk > 35) {
      const s = sym('CS-A01');
      if (!s.ev) { s.ev = '算力饱和'; notice(`⚠ 节点延迟 ${d.avgLatency}ms，风险分升至 ${d.risk} → CS-A01 费率上浮`, 'warn'); }
    } else { sym('CS-A01').ev = sym('CS-A01').ev === '算力饱和' ? '' : sym('CS-A01').ev; }
    if (wasDown) notice('💚 节点心跳恢复，风控Agent 下调风险分', 'pay');
  } else {
    srvUp = false; srvFails++;
    setSrvTxt(false, '节点不可达');
    $('srvMeta').textContent = `连续探测失败 ${srvFails} 次 · 上次风险分 ${srvRisk}`;
    if (srvFails === 2) onNodeDown();
  }
}
function onNodeDown() {
  const s = sym('CS-A01');
  s.ev = '违约触发';
  s.price = r2(s.price * 1.035); s.high = Math.max(s.high, s.price);
  s.vol += 4200;
  const nd = sym('ND-A01'); nd.price = r2(nd.price * 0.94);
  TRADES.unshift({ t: fmtMin(M.min), c: 'CS-A01', p: s.price, v: 4200, d: 'B', c2: 1 });
  notice('⚠ 风控Agent：节点连续 2 次探测超时 → 判定违约，保单 CS-A01 触发赔付', 'danger');
  toast('节点宕机 → 保单触发赔付流程', 'danger');
  setTimeout(() => {
    PAYOUT += 5000;
    notice('💸 挑战窗口结束，AI 裁决通过 → 自动赔付 5,000 BOT 已上链（节点 Slashing 500 BOT）', 'pay');
    toast('自动赔付 5,000 BOT 已上链', 'warn');
    render();
  }, 6000);
  render();
}
function connectSrv() {
  srvUrl = ($('srvUrl').value || '').trim().replace(/\/+$/, '');
  srvFails = 0;
  if (!window.__srvTimer) window.__srvTimer = setInterval(probeSrv, 3000);
  probeSrv();
  notice(`🔌 已接入真实算力节点 ${srvUrl}，开始 3s 一次心跳探测`, '');
  toast('已接入，开始探测', 'warn');
}
async function attack() {
  const N = 12, ms = 6000;
  notice(`🔥 向 ${srvUrl}/work 发起 ${N} 并发 × ${ms / 1000}s 阻塞压测`, 'warn');
  toast('压测已发出，观察行情与公告', 'danger');
  for (let i = 0; i < N; i++) fetch(srvUrl + '/work?ms=' + ms, { cache: 'no-store' }).catch(() => {});
}
async function kill() { await jget('/admin/kill', 2000); notice('☠️ 已下发硬宕机指令，/health 将返回 503', 'warn'); }
async function revive() { await jget('/admin/revive', 2000); notice('💚 服务已恢复', 'pay'); }

/* ---------------- 跑马灯 ---------------- */
function buildTicker() {
  $('ticker').innerHTML = SYMS.map(s => {
    const pc = r2((s.price - s.prev) / s.prev * 100);
    return `<span>${s.code} ${s.name} <b class="${cls(pc)}">${s.price.toFixed(2)} ${pct(pc)}</b></span>`;
  }).join('') + `<span>风险池规模 128,400 BOT · 今日赔付 ${fmtV(PAYOUT)} BOT · 平均风险分 ${Math.round(SYMS.reduce((a, s) => a + s.risk, 0) / SYMS.length)}</span>`;
}
setInterval(buildTicker, 20000);

/* ---------------- 启动 ---------------- */
NOTICES.push({ t: now().slice(0, 8), m: '📢 Aegis 算力保险交易所开盘，标的为保单合约与节点信用', k: '' });
NOTICES.push({ t: now().slice(0, 8), m: '🤖 风控Agent / 定价Agent / 理赔Agent 均已在线', k: '' });
buildTicker(); render();
probeSrv();
window.__srvTimer = setInterval(probeSrv, 3000);
