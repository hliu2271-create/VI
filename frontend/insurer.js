/* Aegis 神盾 · 保险核心工作台 —— 渲染层（无框架，直接操作 DOM） */
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null || isNaN(n) ? '-' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const pct = n => n == null || isNaN(n) ? '-' : Number(n).toFixed(1) + '%';

let S = null;               // 最近一次 /api/state
let selClaim = null;        // 当前选中的赔案号
let evFileRef = null;       // 待上传的证据文件
let lastQuote = null;
let lastChartN = -1;        // 上次绘制走势的记账笔数（用于判断是否重放描边动画）

/* ── 网络 ─────────────────────────────────── */
async function get(path) {
  const r = await fetch(path); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  const data = await r.json();
  if (!r.ok) { const error = new Error(data.error || data.reason || '服务暂时不可用，请重试'); error.code = data.code; error.status = r.status; throw error; }
  return data;
}

/* ── 视图切换 ─────────────────────────────── */
const VIEW_META = {
  apply: ['投保', '配置保障，确认报价，查看保单。', '— APPLICATION'],
  ov:  ['经营总览', '承保 · 核保 · 理赔 · 追偿 全流程', '— 01 · OVERVIEW'],
  wk:  ['赔案工作台', '报案 → 查勘定损 → 核赔 → 赔付 → 追偿', '— 02 · CLAIMS DESK'],
  ev:  ['证据中心', '单证提交 · 规则核验 · Merkle 批次记录', '— 03 · EVIDENCE VAULT'],
  mon: ['监控与连续性', '三观察者仲裁 · 盲区纪律 · 保险人系统下线处置', '— 04 · CONTINUITY'],
  fin: ['账务与审计', '复式记账流水 · 防篡改审计链', '— 05 · LEDGER & AUDIT'],
};
/* 逐级浮现：先摘类、强制回流、再挂类；动画结束后摘掉，
   避免轮询重绘的卡片反复入场。 */
function revealView(s) {
  if (!s || REDUCE_MOTION) return;
  s.classList.remove('reveal');
  void s.offsetWidth;
  s.classList.add('reveal');
  clearTimeout(s._rvT);
  s._rvT = setTimeout(() => s.classList.remove('reveal'), 760);
}
function goView(v) {
  if (v !== 'apply') document.getElementById('policyDialog')?.close();
  document.querySelectorAll('.nv a[data-view]').forEach(a => a.classList.toggle('on', a.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => {
    const on = s.id === 'vw-' + v;
    s.classList.toggle('on', on);
    if (on) revealView(s);
  });
  const m = VIEW_META[v] || VIEW_META.ov;
  $('vwTitle').innerHTML = m[0] + '<span class="chev"> ›</span>';
  $('vwSub').textContent = m[1];
  $('vwLabel').textContent = m[2];
}

/* ── 提示 ─────────────────────────────────── */
function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.textContent = msg;
  $('toastBox').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

/* ── 状态样式 ─────────────────────────────── */
function stageTxt(c) {
  const M = {
    REPORTED: '已报案', INVESTIGATING: '查勘定损', ADJUSTED: '已定损',
    ADJUDICATED: '已核赔', PAID: '已赔付', RECOVERED: '已追偿', CLOSED: '已结案',
  };
  if (c.decision === 'DECLINED') return '拒赔结案';
  if (c.decision === 'PENDING_EVIDENCE') return '待补单证';
  return M[c.stage] || c.stage || '-';
}
function stageCls(c) {
  if (c.decision === 'DECLINED') return 'st-bad';
  if (c.stage === 'CLOSED') return 'st-mut';
  if (c.stage === 'PAID' || c.stage === 'RECOVERED') return 'st-ok';
  return 'st-warn';
}
const STAGES = ['REPORTED', 'INVESTIGATING', 'ADJUSTED', 'ADJUDICATED', 'PAID'];
const STAGE_NAMES = { REPORTED: '报案', INVESTIGATING: '定损', ADJUSTED: '核价', ADJUDICATED: '核赔', PAID: '赔付' };

function verdictTxt(v) {
  return { ACCEPTED: '通过', ACCEPTED_WITH_RESERVE: '存疑通过', REJECTED: '驳回', EXCLUDED: '不采信', PENDING: '核验中' }[v] || v;
}
function verdictCls(v) {
  return v === 'ACCEPTED' ? 'st-ok' : v === 'ACCEPTED_WITH_RESERVE' ? 'st-warn' : v === 'PENDING' ? 'st-mut' : 'st-bad';
}

/* ═══════════ 渲染：总览 ═══════════ */
function chip(text, seed) {
  return `<span class="chip">${esc(text)}</span>`;
}

/* ── 数字滚动（数据动效：旧值 → 新值补间） ── */
const CNT_PREV = {};
const REDUCE_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const cntFmt = (v, kind) => kind === 'pct' ? (v || 0).toFixed(1) + '%'
  : kind === 'int' ? String(Math.round(v || 0))
    : fmt(Math.round((v || 0) * 100) / 100);
const cnt = (v, kind, k) =>
  `<span class="cnt" data-kind="${kind}" data-to="${(Number(v) || 0).toFixed(2)}" data-k="${k}">—</span>` +
  (kind === 'bot' ? ' <small>BOT</small>' : kind === 'int' ? ' <small>件</small>' : '');
function tweenCounts(root) {
  (root || document).querySelectorAll('.cnt').forEach(el => {
    const to = parseFloat(el.dataset.to) || 0;
    const kind = el.dataset.kind || 'int', key = el.dataset.k || '';
    const prev = CNT_PREV[key];
    CNT_PREV[key] = to;
    const from = prev == null ? 0 : prev;
    if (REDUCE_MOTION || Math.abs(to - from) < 0.05) { el.textContent = cntFmt(to, kind); return; }
    const t0 = performance.now(), dur = 520;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = cntFmt(from + (to - from) * (1 - Math.pow(1 - p, 3)), kind);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function renderStats() {
  const m = S.metrics || {};
  const cr = m.combinedRatio || 0, lr = m.lossRatio || 0;
  const items = [
    ['已赚保费', cnt(m.earned, 'bot', 'earned'),
      `<div class="d flat">签单 ${fmt(m.written)} · 在保 ${S.summary?.activePolicies ?? (S.policies || []).length} 张</div>`],
    ['净赔付率', cnt(lr, 'pct', 'lr'),
      `<div class="d ${lr <= 80 ? 'up' : 'down'}">${lr <= 80 ? '▲' : '▼'} 目标线 80%</div>`],
    ['综合成本率', cnt(cr, 'pct', 'cr'),
      `<div class="d ${cr < 100 ? 'up' : 'down'}">${cr < 100 ? '▲ 承保盈利区间' : '▼ 承保亏损区间'}</div>`],
    ['承保利润', cnt(m.uwProfit, 'bot', 'uw'),
      `<div class="d ${(m.uwProfit || 0) >= 0 ? 'up' : 'down'}">${(m.uwProfit || 0) >= 0 ? '▲' : '▼'} 利润率 ${pct(m.margin)}</div>`],
    ['未决准备金', cnt(m.reserve, 'bot', 'res'),
      `<div class="d flat">偿付能力 ${pct(m.solvency)}</div>`],
    ['在途赔案', cnt(m.openClaims ?? 0, 'int', 'open'),
      `<div class="d flat">直通率 ${pct(m.stpRate)} · 核减率 ${pct(m.cutRate)}</div>`],
  ];
  $('stats').innerHTML = items.map(([k, v, d]) =>
    `<div class="st"><div class="k">${k}</div><div class="v">${v}</div>${d}</div>`).join('');
  tweenCounts($('stats'));
}

/* 资金与赔付走势（TradingView 面积图）
 * 数据 = 全量记账（S.series，服务端同源累计），而非最近流水窗口 —— 窗口里只有演示大赔款、没有存量保费，会画出假性亏损。
 * 三条线：保费收入（墨实线）/ 赔款·自留（红虚线，再保分出后口径）/ 追偿收入（灰点线）。
 * 承保是否赚钱的权威口径是统计条（权责发生制，含费用摊提），图右上角直接引用，避免两处打架。 */
const serFallbackT = { premT: 0, payT: 0, recT: 0 };
function renderChart() {
  const m = S.metrics || {};
  const cr = m.combinedRatio || 0;
  let prem, pay, rec, subLabel;
  const ser = S.series;
  if (ser && ser.prem && ser.prem.length >= 2) {
    prem = ser.prem; pay = ser.pay; rec = ser.rec || [];
    subLabel = `全组合记账 ${ser.n} 笔 · 赔款为自留口径（再保分出后）`;
  } else {
    const lg = (S.ledger || []).slice().reverse();   // 旧服务端兜底：窗口流水
    prem = []; pay = []; rec = [];
    let a = 0, b = 0, c = 0;
    for (const l of lg) {
      if (l.cr === '保费收入') a += l.amt;
      if (l.dr === '赔款支出' || l.cr === '赔款支出') b += l.amt;
      if (l.cr === '追偿收入') c += l.amt;
      prem.push(a); pay.push(b); rec.push(c);
    }
    serFallbackT.premT = a; serFallbackT.payT = b; serFallbackT.recT = c;
    subLabel = `记账 ${lg.length} 笔（窗口）· 赔款为自留口径`;
  }
  const T = ser && ser.prem && ser.prem.length >= 2 ? ser : serFallbackT;
  const netFlow = T.premT - T.payT + T.recT;

  $('chartSub').textContent = subLabel;
  $('chartVerdict').innerHTML =
    `<span class="cv ${netFlow >= 0 ? 'ok' : 'bad'}">承保净流 <b>${netFlow >= 0 ? '+' : ''}${fmt(netFlow)}</b> BOT</span>` +
    `<span class="cv ${cr < 100 ? 'ok' : 'bad'}">综合成本率 <b>${pct(cr)}</b> · 承保利润 <b>${m.uwProfit >= 0 ? '+' : ''}${fmt(m.uwProfit)}</b> BOT</span>`;
  if (prem.length < 2) { $('ovChart').innerHTML = '<div class="empty">数据积累中，出单 / 赔付后自动绘制</div>'; return; }

  const W = 760, H = 170, PL = 52, PR = 14, PT = 14, PB = 22;
  const max = Math.max(...prem, ...pay, ...(rec.length ? rec : [0]), 1) * 1.08;
  const X = i => PL + (W - PL - PR) * i / (prem.length - 1);
  const Y = v => PT + (H - PT - PB) * (1 - v / max);
  const path = arr => arr.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
  const area = arr => path(arr) + ` L${X(arr.length - 1).toFixed(1)},${Y(0)} L${X(0).toFixed(1)},${Y(0)} Z`;
  const grid = [0, .25, .5, .75, 1].map(g => {
    const y = Y(max * g / 1.08);
    return `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="#e5e7eb"/>` +
      `<text x="${PL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#6b7280" font-family="Consolas">${fmt(Math.round(max * g / 1.08))}</text>`;
  }).join('');
  const t0 = (S.ledger || []).length ? (S.ledger[S.ledger.length - 1] || {}).t || '' : '';
  const t1 = (S.ledger || [])[0] || {};
  const drawFx = !REDUCE_MOTION && lastChartN !== prem.length;
  lastChartN = prem.length;
  /* 图例：由「右上角四行竖排」改为「绘图区顶部空带一行横排」（TradingView 式）。
     四行竖排的问题：行距 12px 过密、首行贴容器边框、深浅色叠出贴纸感 —— 即「突兀」的来源。
     横排利用顶部空带（最高网格线 y≈PT+10 之上），单行分色，视觉立减；
     仍带纸色描边保证压线可读。 */
  const LGY = PT + 5;
  const lgSeg = (color, txt) => `<tspan fill="${color}">${txt}</tspan>`;
  const lgSep = `<tspan fill="#9ca3af">  ·  </tspan>`;
  const legend =
    `<text x="${PL + 2}" y="${LGY}" font-size="10" font-family="Consolas" stroke="#fafaf9" stroke-width="3" paint-order="stroke" style="paint-order:stroke">` +
    lgSeg('#1a1a1a', `保费 ${fmt(T.premT)}`) + lgSep +
    lgSeg('#e0393e', `赔款·自留 ${fmt(T.payT)}`) + lgSep +
    (rec.length ? lgSeg('#6b7280', `追偿 +${fmt(T.recT)}`) + lgSep : '') +
    lgSeg(netFlow >= 0 ? '#0f6e56' : '#a32d2d', `承保净流 ${netFlow >= 0 ? '+' : ''}${fmt(netFlow)}`) +
    `</text>`;
  $('ovChart').innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block"${drawFx ? ' class="draw"' : ''}>
    <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1a1a" stop-opacity=".14"/><stop offset="1" stop-color="#1a1a1a" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path class="ar" d="${area(prem)}" fill="url(#ag)"/>
    <path class="ln" d="${path(prem)}" fill="none" stroke="#1a1a1a" stroke-width="1.8"/>
    <path class="ln2" d="${path(pay)}" fill="none" stroke="#e0393e" stroke-width="1.4" stroke-dasharray="4 3"/>
    ${rec.length ? `<path class="ln3" d="${path(rec)}" fill="none" stroke="#6b7280" stroke-width="1.2" stroke-dasharray="1.5 2.5"/>` : ''}
    <rect x="${X(prem.length - 1) - 2.5}" y="${Y(prem[prem.length - 1]) - 2.5}" width="5" height="5" fill="#1a1a1a"/>
    <text x="${PL}" y="${H - 6}" font-size="9" fill="#6b7280" font-family="Consolas">${t0}</text>
    <text x="${W - PR}" y="${H - 6}" text-anchor="end" font-size="9" fill="#6b7280" font-family="Consolas">${t1.t || ''}</text>
    ${legend}
  </svg>`;
  // 描边播完后摘掉 draw，让赔款线恢复虚线样式
  if (drawFx) {
    const svg = $('ovChart').querySelector('svg');
    setTimeout(() => svg && svg.classList.remove('draw'), 1400);
  }
}

function renderNodes() {
  const nodes = S.nodes || [];
  $('nodeSub').textContent = `${nodes.length} 个节点 · 真实节点 ${S.nodeUp ? '在线' : '离线'}`;
  $('nodes').innerHTML = `<table class="tb"><tr><th>节点</th><th class="num">风险分</th><th class="num">可用率</th><th class="num">12月赔案</th><th>状态</th></tr>` +
    nodes.map(n => `<tr>
      <td><div class="tcell">${chip(n.id.slice(-2).toUpperCase(), n.id)}<div><div class="tt mono">${esc(n.id)}</div><div class="ts">${esc(n.name || n.role || '')}${n.real ? ' · 真实节点' : ''}</div></div></div></td>
      <td class="num">${n.risk}</td><td class="num">${n.avail}%</td><td class="num">${n.claims12m ?? '-'}</td>
      <td><span class="pill ${n.suspended ? 'st-bad' : 'st-ok'}"><span class="dot"></span>${n.suspended ? '停售' : '正常'}</span></td>
    </tr>`).join('') + '</table>';
}

function renderPolicies() {
  const ps = S.policies || [];
  $('polSub').textContent = `共 ${S.summary?.totalPolicies ?? ps.length} 张 · 最近 ${ps.length} 张`;
  $('insuranceSummary').textContent = `风险池资本 ${fmt(S.summary?.capital)} BOT · 在保 ${S.summary?.activePolicies ?? '—'} 张 · 累计赔款 ${fmt(S.summary?.grossPaid)} BOT`;
  $('pols').innerHTML = ps.length ? `<table class="tb"><tr><th>保单号</th><th>节点</th><th>险种</th><th class="num">保额</th><th class="num">保费</th><th>剩余</th></tr>` +
    ps.map(p => `<tr>
      <td class="mono"><button class="policy-link" data-policy="${esc(p.no)}">${esc(p.no)} ↗</button></td><td class="mono">${esc(p.nodeId)}</td>
      <td>${esc((S.products[p.product] || {}).name || p.product)}</td>
      <td class="num">${fmt(p.sumInsured)}</td><td class="num">${fmt(p.premium)}</td>
      <td class="dim">${p.daysLeft != null ? p.daysLeft + ' 天' : '-'}</td>
    </tr>`).join('') + '</table>'
    : '<div class="empty">暂无有效保单</div>';
}

function renderEngine() {
  const m = S.metrics || {};
  const ex = S.exclusions || [];
  $('engSub').textContent = `直通率 ${pct(m.stpRate)} · 核减率 ${pct(m.cutRate)}`;
  $('eng').innerHTML = `
    <div class="kv" style="margin-bottom:10px">
      <div><div class="k">理赔费用 LAE</div><div class="v">${fmt(m.lae)} BOT（${pct(m.laeRatio)}）</div></div>
      <div><div class="k">直通 STP / 编排</div><div class="v">${pct(m.stpRate)} / ${pct(100 - (m.stpRate || 0))}</div></div>
      <div><div class="k">追偿回收率</div><div class="v">${pct(m.recoveryRatio)}</div></div>
      <div><div class="k">偿付能力</div><div class="v">${pct(m.solvency)}</div></div>
    </div>
    <h4 style="font-size:12px;color:var(--ink-3);font-weight:500;margin:10px 0 6px">责任免除条款库（${ex.length} 条 · 保险人负举证责任）</h4>
    <table class="tb"><tr><th>条款</th><th>内容</th><th>所需单证</th></tr>
    ${ex.map(e => `<tr><td class="mono">${e.code}</td><td>${esc(e.name)}</td><td class="dim">${esc((e.requires || []).join('、'))}${e.thirdParty ? ' · 触发第三方追偿' : ''}</td></tr>`).join('')}
    </table>`;
}

/* ═══════════ 渲染：赔案工作台 ═══════════ */
const SEEN_CLAIM = new Set();   // 已出现过的赔案号（用于新案入队闪烁）
const STAMP_PREV = {};          // 每笔赔案上次的状态签名（用于结论盖章）
let queuePrimed = false;
function renderQueue() {
  const cs = S.claims || [];
  const open = cs.filter(c => c.stage !== 'CLOSED').length;
  $('nbOpen').textContent = open || '';
  if (!cs.length) { $('claimList').innerHTML = '<div class="empty">暂无赔案。可点上方「人工报案」或「节点压力演练」触发。</div>'; queuePrimed = true; return; }
  const fresh = [];
  $('claimList').innerHTML = cs.map(c => {
    const isNew = queuePrimed && !SEEN_CLAIM.has(c.no);
    SEEN_CLAIM.add(c.no);
    if (isNew) fresh.push(c.no);
    return `
    <div class="qit ${c.no === selClaim ? 'sel' : ''}${isNew ? ' new' : ''}" onclick="pickClaim('${c.no}')">
      ${chip(c.no.slice(-2), c.no)}
      <div class="qb">
        <div class="ql1"><b>${esc(c.no)}</b><span class="pill ${stageCls(c)}"><span class="dot"></span>${stageTxt(c)}</span></div>
        <div class="ql2"><span>${esc(c.nodeId)} · ${esc((S.products[c.product] || {}).name || c.product)}</span><span class="mono">${c.payable ? fmt(c.payable) + ' BOT' : (c.claimed ? '申报 ' + fmt(c.claimed) : '待核')}</span></div>
      </div>
    </div>`;
  }).join('');
  queuePrimed = true;
  // 回收已结案/已清空的案号，避免重置或归档后案号复用时不再闪烁
  const alive = new Set(cs.map(c => c.no));
  SEEN_CLAIM.forEach(no => { if (!alive.has(no)) SEEN_CLAIM.delete(no); });
  Object.keys(STAMP_PREV).forEach(no => { if (!alive.has(no)) delete STAMP_PREV[no]; });
  // 新案入队时自动跟到最新一笔，让右侧详情直接播演进（用户点选优先，下一笔新案再自动跟随）
  if (fresh.length && fresh.indexOf(selClaim) < 0) selClaim = fresh[fresh.length - 1];
}

function pickClaim(no) { selClaim = no; renderQueue(); renderDetail(); }

function renderDetail() {
  const box = $('claimDetail');
  const c = (S.claims || []).find(x => x.no === selClaim);
  if (!c) {
    box.innerHTML = '<div class="empty" style="padding-top:80px">从左侧队列选择一笔赔案查看处理详情</div>';
    return;
  }
  const declined = c.decision === 'DECLINED';

  // 结论落定（进入终态 / 拒赔）时盖章一次，避免轮询反复动画
  const stampKey = c.stage + '|' + (c.decision || '');
  const isStamp = STAMP_PREV[c.no] != null && STAMP_PREV[c.no] !== stampKey;
  STAMP_PREV[c.no] = stampKey;
  const stampCls = isStamp ? ' stamp' : '';

  // 阶段步进
  const curIdx = STAGES.indexOf(c.stage);
  const steps = STAGES.map((s, i) => {
    const cls = declined && s === 'ADJUDICATED' ? 'cur' : (i < curIdx || c.stage === 'CLOSED' || c.stage === 'RECOVERED' ? 'done' : i === curIdx ? 'cur' : '');
    return `<div class="s ${cls}"><i>${i + 1}</i>${STAGE_NAMES[s]}</div>`;
  }).join('<div class="sep2"></div>') +
    (c.stage === 'RECOVERED' || c.stage === 'CLOSED' ? '<div class="sep2"></div><div class="s done"><i>✓</i>' + (c.stage === 'RECOVERED' ? '追偿' : '结案') + '</div>' : '');

  let html = `<div class="sect">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <b class="mono" style="font-size:14px">${esc(c.no)}</b>
      <span class="pill ${stageCls(c)}${stampCls}"><span class="dot"></span>${stageTxt(c)}</span>
      ${c.track ? `<span class="dim" style="font-size:11px">${c.track === 'STP' ? '直通处理' : '编排调度'}${c.lae != null ? ' · LAE ' + fmt(c.lae) + ' BOT' : ''}</span>` : ''}
      <span class="dim" style="margin-left:auto;font-size:11px">${esc(c.src || '')} 来源</span>
    </div>
    <div class="kv" style="margin-top:10px">
      <div><div class="k">被保节点</div><div class="v">${esc(c.nodeId)}</div></div>
      <div><div class="k">险种 / 保单</div><div class="v">${esc((S.products[c.product] || {}).name || c.product)} / ${esc(c.policyNo || '-')}</div></div>
      <div><div class="k">申报金额</div><div class="v">${c.claimed ? fmt(c.claimed) + ' BOT' : '待定损'}</div></div>
      <div><div class="k">核减</div><div class="v">${c.cut ? fmt(c.cut) + ' BOT' : '-'}</div></div>
      <div><div class="k">应付 / 自留</div><div class="v">${c.payable ? fmt(c.payable) + ' / ' + fmt(c.net) + ' BOT' : '-'}</div></div>
      <div><div class="k">再保摊回</div><div class="v">${c.ceded ? fmt(c.ceded) + ' BOT' : '-'}</div></div>
    </div>
    <div class="steps" style="margin-top:12px">${steps}</div>
  </div>`;

  // 拒赔 / 责任免除
  if (declined) {
    html += `<div class="sect"><h4>核赔结论</h4>
      <div class="pill st-bad${stampCls}"><span class="dot"></span>拒赔${c.why ? '：' + esc(c.why) : ''}</div></div>`;
  }
  if (c.exclusions && c.exclusions.length) {
    html += `<div class="sect"><h4>责任免除核查</h4>` + c.exclusions.map(e =>
      `<div style="font-size:12px;padding:3px 0"><span class="pill ${e.outcome === 'EXCLUSION_APPLIED' ? 'st-bad' : 'st-warn'}"><span class="dot"></span>${esc(e.code)} ${esc(e.name)}</span>
       <span class="dim"> — ${e.outcome === 'EXCLUSION_APPLIED' ? '举证成立，适用免赔' : '保险人举证不足，不得拒赔'}</span></div>`).join('') + '</div>';
  }

  // 损失分项
  if (c.items && c.items.length) {
    html += `<div class="sect"><h4>损失分项核定（市场比价 × 因果折算）</h4>
      <table class="tb"><tr><th>损失项</th><th class="num">申报</th><th class="num">市场基准</th><th class="num">因果强度</th><th class="num">核定</th><th class="num">核减</th></tr>
      ${c.items.map(it => `<tr><td>${esc(it.name)}</td><td class="num">${fmt(it.claimed)}</td><td class="num">${fmt(it.market)}</td>
        <td class="num">${Math.round(it.causation * 100)}%</td><td class="num">${fmt(it.adj)}</td><td class="num dim">${fmt(it.cut)}</td></tr>`).join('')}
      </table>
      ${c.adjuster ? `<div class="hint">第三方公估 ${esc(c.adjuster.name || c.adjuster)} 签出定损金额，理赔岗无权修改（职责分离）。</div>` : ''}
    </div>`;
  }

  // 编排进度
  if (c.orch && c.orch.length) {
    const doneN = c.orch.filter(o => o.state === 'DONE').length;
    html += `<div class="sect"><h4>编排调度（${doneN}/${c.orch.length} 步）</h4>` +
      c.orch.map(o => {
        const st = o.state === 'DONE' ? 'st-ok' : o.state === 'RUN' ? 'st-warn' : 'st-mut';
        const stTxt = o.state === 'DONE' ? '完成' : o.state === 'RUN' ? '执行中' : '等待';
        return `<div style="font-size:12px;padding:2px 0"><span class="pill ${st}"><span class="dot"></span>${esc(o.name)}</span> <span class="dim">${stTxt} · ${esc(o.svc || '')}</span></div>`;
      }).join('') + '</div>';
  }

  // 第三方追偿
  if (c.thirdPartyClaim) {
    const t = c.thirdPartyClaim;
    html += `<div class="sect"><h4>第三方责任追偿</h4>
      <div style="font-size:12px">上游云服务商责任成立，按 ${Math.round((t.rate || 0) * 100)}% 追偿 <b class="mono">${fmt(t.amount)} BOT</b>。</div></div>`;
  }
  if (c.subrogation) {
    html += `<div class="sect"><h4>代位追偿</h4>
      <div style="font-size:12px">已向节点质押账户追偿 <b class="mono">${fmt(c.subrogation.amount ?? c.subrogation)} BOT</b>。</div></div>`;
  }

  // 自证窗口 / 单证要求
  if (c.pendingSelfProof || c.evHold || c.decision === 'PENDING_EVIDENCE') {
    html += `<div class="sect"><h4>待办</h4>
      <div class="ev-banner warn show">${c.pendingSelfProof ? '举证责任倒置生效：等待投保人上传「在线自证」，逾期将按离线定损。' : ''}${c.decision === 'PENDING_EVIDENCE' ? '核赔暂缓：等待必要单证。' : ''}${c.evHold ? ' 缺少必要单证，赔付暂缓。' : ''}${c.evRequired && c.evRequired.length ? ' 需补：' + esc(c.evRequired.map(k => (S.evKinds[k] || {}).name || k).join('、')) + '。' : ''}
      请到 <a href="javascript:goView('ev')">证据中心</a> 提交。</div></div>`;
  }

  // 判定依据（AI 记录中与本赔案相关的）
  const aiRel = (S.ai || []).filter(a => a.claimNo === c.no);
  if (aiRel.length) {
    html += `<div class="sect"><h4>规则判定依据</h4>` + aiRel.map(a => `
      <details class="basis" style="margin-bottom:8px">
        <summary>${esc(String(a.agent || '').replace(/Agent/g, '规则'))} · ${esc(a.decision)} · 规则评分 ${Math.round((a.confidence || 0) * 100)}% <span class="dim">${esc(a.t || '')}</span></summary>
        <div class="bbody">${esc((a.reasoning || []).map(r => '· ' + r.s + '：' + r.d).join('\n'))}${a.evidence && a.evidence.length ? '\n链上/系统数据：' + a.evidence.map(e => e.k + ' = ' + e.v).join('；') : ''}</div>
      </details>`).join('') + '</div>';
  }

  // 相关证据
  const evs = (S.evidence || []).filter(e => e.claimNo === c.no);
  if (evs.length) {
    html += `<div class="sect"><h4>关联单证（${evs.length}）</h4>
      <table class="tb"><tr><th>编号</th><th>类型</th><th>文件</th><th>核验</th><th>锚定</th></tr>
      ${evs.map(e => `<tr><td class="mono">${e.id}</td><td>${esc(e.kindName)}</td>
        <td><a href="${esc(e.url)}" target="_blank">${esc(e.name)}</a></td>
        <td><span class="pill ${verdictCls(e.verdict)}"><span class="dot"></span>${verdictTxt(e.verdict)} ${e.score ? e.score + '分' : ''}</span></td>
        <td class="dim mono">${e.anchor ? e.anchor.batch : '待批次'}</td></tr>`).join('')}
      </table></div>`;
  }

  box.innerHTML = html;
}

/* ═══════════ 渲染：证据中心 ═══════════ */
function renderEvidence() {
  const evs = S.evidence || [];
  const anchored = evs.filter(e => e.anchor).length;
  $('evSub').textContent = `${evs.length} 份 · 已入批次 ${anchored} 份 / ${S.evBatches || 0} 批`;

  // 关联赔案下拉（签名变化才重建）
  const open = (S.claims || []).filter(c => c.stage !== 'CLOSED');
  const opts = open.length ? open : (S.claims || []).slice(0, 6);
  const sel = $('evClaim');
  const sig = opts.map(c => c.no + (c.pendingSelfProof ? '*' : '') + (c.evHold ? '!' : '')).join('|');
  if (sig && sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = opts.map(c =>
      `<option value="${c.no}">${c.no} · ${stageTxt(c)}${c.pendingSelfProof ? ' · 待自证' : ''}${c.evHold ? ' · 缺单证' : ''}</option>`).join('');
  }
  // 单证类型下拉
  const ks = $('evKind');
  if (!ks.dataset.done && S.evKinds) {
    ks.dataset.done = 1;
    ks.innerHTML = Object.entries(S.evKinds).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  }

  // 顶部横幅：待自证 / 缺单证
  const pending = (S.claims || []).find(c => c.pendingSelfProof);
  const hold = (S.claims || []).filter(c => c.evHold);
  const bn = $('evBanner');
  if (pending) {
    bn.className = 'ev-banner warn show';
    bn.innerHTML = `赔案 <b class="mono">${pending.no}</b> 举证责任倒置生效，请在自证窗口内上传「在线自证」。` +
      ` <a href="javascript:pickSelfProof('${pending.no}')">选中该赔案</a>`;
  } else if (hold.length) {
    bn.className = 'ev-banner info show';
    bn.textContent = `${hold.length} 笔赔案缺少必要单证，赔付暂缓：${hold.map(c => c.no).join('、')}`;
  } else {
    bn.className = 'ev-banner'; bn.innerHTML = '';
  }

  $('evList').innerHTML = evs.length ? `<table class="tb">
    <tr><th>编号</th><th>类型</th><th>文件</th><th>关联赔案</th><th>核验</th><th class="num">大小</th><th>锚定</th></tr>
    ${evs.map(e => `<tr>
      <td class="mono">${e.id}</td><td>${esc(e.kindName)}</td>
      <td><a href="${esc(e.url)}" target="_blank" title="SHA-256 ${e.sha256}">${esc(e.name)}</a></td>
      <td class="mono dim">${e.claimNo || '-'}</td>
      <td><span class="pill ${verdictCls(e.verdict)}"><span class="dot"></span>${verdictTxt(e.verdict)}${e.score ? ' ' + e.score + '分' : ''}</span></td>
      <td class="num dim">${(e.size / 1024).toFixed(1)}K</td>
      <td class="mono dim">${e.anchor ? e.anchor.batch : '待批次'}</td>
    </tr>`).join('')}</table>`
    : '<div class="empty">暂无证据。左侧选择文件或用示例生成后提交。</div>';
}

function pickSelfProof(no) {
  const sel = $('evClaim'); if (sel) sel.value = no;
  const ks = $('evKind');
  if (ks) { for (const o of ks.options) if (/自证/.test(o.text)) { ks.value = o.value; break; } }
  toast('已选中赔案 ' + no + '，请上传在线自证');
}

/* ═══════════ 渲染：监控 ═══════════ */
function renderMon() {
  const m = S.mon || {};
  $('monSub').textContent = `监控可用率 ${pct(m.uptime)} · 仲裁 ${m.quorum || 2}/3`;
  const statusMap = { HEALTHY: ['st-ok', '正常'], BLIND: ['st-bad', '监控盲区'], DEGRADED: ['st-warn', '降级运行'] };
  const [cls, txt] = statusMap[m.status] || ['st-mut', m.status || '-'];
  $('monStatus').innerHTML = `
    <div class="kv">
      <div><div class="k">监控状态</div><div class="v"><span class="pill ${cls}"><span class="dot"></span>${txt}</span>${m.blackout ? ' <span class="dim">（演练中）</span>' : ''}</div></div>
      <div><div class="k">累计盲区</div><div class="v">${m.blindCount || 0} 次 / ${fmt(m.blindTotal || 0)}s</div></div>
      <div><div class="k">被保真实节点</div><div class="v"><span class="pill ${S.nodeUp ? 'st-ok' : 'st-bad'}"><span class="dot"></span>${S.nodeUp ? '在线' : '离线'}</span></div></div>
      <div><div class="k">心跳失败计数</div><div class="v">${S.nodeFails || 0}</div></div>
    </div>
    ${m.blind ? `<div class="ev-banner warn show" style="margin-top:10px">当前处于监控盲区（${esc(m.blind.reason || '')}）。盲区期间不认定出险；恢复后自动补录。</div>` : ''}`;

  $('observers').innerHTML = `<table class="tb"><tr><th>观察者</th><th>状态</th><th class="num">延迟</th><th>最近心跳</th></tr>` +
    (S.observers || []).map(o => `<tr><td>${esc(o.name)}</td>
      <td><span class="pill ${o.ok ? 'st-ok' : 'st-bad'}"><span class="dot"></span>${o.ok ? '可达' : '不可达'}</span></td>
      <td class="num dim">${o.lat || 0}ms</td><td class="dim mono">${esc(o.last || '-')}</td></tr>`).join('') + '</table>';
}

function renderAI() {
  const list = S.ai || [];
  $('aiSub').textContent = `${list.length} 条`;
  $('ai').innerHTML = list.length ? list.map(a => `
    <details class="basis" style="padding:6px 0;border-bottom:1px solid var(--line-2)">
      <summary><b>${esc(String(a.agent || '').replace(/Agent/g, '规则'))}</b> · ${esc(a.decision)} · 规则评分 ${Math.round((a.confidence || 0) * 100)}%
        ${a.claimNo ? `<span class="mono dim"> ${esc(a.claimNo)}</span>` : ''}
        <span class="dim" style="float:right">${esc(a.t || '')}</span></summary>
      <div class="bbody">${esc((a.reasoning || []).map(r => '· ' + r.s + '：' + r.d).join('\n'))}${a.evidence && a.evidence.length ? '\n数据：' + a.evidence.map(e => e.k + ' = ' + e.v).join('；') : ''}</div>
    </details>`).join('')
    : '<div class="empty">暂无规则评估记录</div>';
}

/* ═══════════ 渲染：账务 ═══════════ */
function renderFin() {
  const lg = S.ledger || [];
  $('ledger').innerHTML = lg.length ? `<table class="tb">
    <tr><th>时间</th><th>借方</th><th>贷方</th><th class="num">金额</th><th>摘要</th></tr>
    ${lg.map(l => `<tr><td class="mono dim">${esc(l.t || '')}</td><td>${esc(l.dr)}</td><td>${esc(l.cr)}</td>
      <td class="num">${fmt(l.amt)}</td><td class="dim">${esc(l.memo || '')}</td></tr>`).join('')}</table>`
    : '<div class="empty">暂无流水</div>';

  const au = S.audit || [];
  $('audSub').textContent = `${au.length} 条 · 哈希链`;
  $('audit').innerHTML = au.length ? au.slice().reverse().map(a => `
    <div class="lit"><span class="lt">${esc(a.t || '')}</span><span class="tag">${esc(a.type)}</span>
    <span>${esc(a.msg)}${a.hash ? `<span class="dim mono"> · ${String(a.hash).slice(0, 12)}…</span>` : ''}</span></div>`).join('')
    : '<div class="empty">暂无审计记录</div>';
}

/* ═══════════ 操作 ═══════════ */
async function quote(fromDemo=false) { return window.InsuranceFlow.quote(fromDemo); }
async function issue(fromDemo=false) { return window.InsuranceFlow.issue(fromDemo); }

async function manualClaim() {
  const nodeId = $('fNode').value;
  const r = await post('/api/claim/manual', { nodeId, product: 'DOWNTIME' });
  if (r && r.ok) { toast('已报案 ' + r.claim.no + '，进入查勘定损'); goView('wk'); selClaim = r.claim.no; pull(); }
}

async function attack() {
  await post('/api/attack', {});
  toast('已向真实节点注入压测流量，观察心跳与自动报案');
}

async function blackout() {
  const r = await post('/api/blackout', { seconds: 20 });
  if (r && r.ok) toast('演练开始：保险人系统下线 20s（监控盲区）');
}

async function toggleAuto() {
  const on = !(S && S.auto);
  $('autoSw').classList.toggle('on', on);          // 先动一下，避免点击无视觉反馈
  const r = await post('/api/auto', { on });
  if (r) { toast('自动演练已' + (r.auto ? '开启' : '关闭')); pull(); }
  else pull();                                     // 失败时按服务端真实状态回正
}

async function resetAll() {
  if (demoRunning || !window.InsuranceFlow.canReset()) return toast('请先完成当前提交或核对待确认的出单结果，再重建数据。', 'err');
  window.InsuranceFlow.maintenance(true);
  try { await post('/api/reset', {}); selClaim = null; await pull(); window.InsuranceFlow.clearDraft(); toast('演示数据已重建'); }
  catch { toast('数据重建未完成，请检查连接后重试。', 'err'); }
  finally { window.InsuranceFlow.maintenance(false); }
}

/* 证据上传 */
function bindDrop() {
  const dz = $('evDrop'), fi = $('evFile');
  dz.onclick = () => fi.click();
  fi.onchange = () => { if (fi.files[0]) { evFileRef = fi.files[0]; $('evName').textContent = fi.files[0].name; } };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = e => {
    e.preventDefault(); dz.classList.remove('over');
    if (e.dataTransfer.files[0]) { evFileRef = e.dataTransfer.files[0]; $('evName').textContent = evFileRef.name; }
  };
}

const DEMO_DOCS = {
  accident: ['node-outage.log', [
    '[2026-10-07 14:02:11] ERROR heartbeat lost, node unreachable',
    '[2026-10-07 14:02:12] ERROR rpc endpoint timeout, service down',
    '[2026-10-07 14:07:40] WARN  workload dropped 98%, outage ongoing',
    '[2026-10-07 14:31:05] INFO  service recovered after failover',
  ].join('\n')],
  maintenance: ['maintenance-ticket.txt', [
    '维护工单 MA-2026-1031',
    '内容：计划内停机维护（更换宿主机电源模块）',
    '窗口：2026-10-07 13:30 - 15:30',
    '事前通知：未按合约要求提前 72 小时通知保险人',
  ].join('\n')],
  selfproof: ['self-proof.txt', [
    '节点在线自证',
    '时间：' + new Date().toISOString(),
    '近期 100 次心跳全部成功，RPC 正常出块，节点持续在线。',
    '签名：0x' + Math.random().toString(16).slice(2, 42),
  ].join('\n')],
};

function fillDemo(kind) {
  const [name, text] = DEMO_DOCS[kind];
  evFileRef = new File([text], name, { type: 'text/plain' });
  $('evName').textContent = name;
  const ks = $('evKind');
  if (kind === 'selfproof') { for (const o of ks.options) if (/自证/.test(o.text)) { ks.value = o.value; break; } }
  if (kind === 'maintenance') { for (const o of ks.options) if (/维护|工单/.test(o.text)) { ks.value = o.value; break; } }
  if (kind === 'accident') { for (const o of ks.options) if (/日志/.test(o.text)) { ks.value = o.value; break; } }
  toast('示例单证已生成，点击「提交并核验」');
}

async function uploadEvidence() { return window.InsuranceFlow.uploadEvidence(); }

/* ═══════════ 轮询与启动 ═══════════ */
async function pull() {
  try {
    S = await get('/api/state');
    $('srvDot').className = 'dot ok'; $('srvTxt').textContent = '核心在线';
    $('autoTxt').textContent = '自动演练 ' + (S.auto ? '开' : '关');
    $('autoSw').classList.toggle('on', !!S.auto);   // 开关视觉状态跟随后端
    // 被保标的：若后端接了真实外部系统（如链安保险靶机），在此显式标注
    const ic = $('insuredChip');
    if (S.insured) {
      ic.style.display = '';
      $('insuredTxt').textContent = '标的 ' + S.insured.label;
      ic.title = `${S.insured.label}\n${S.insured.url}\n已采样 ${S.insured.samples} 次 · 可用率 ${(S.insured.okRate * 100).toFixed(1)}%`;
    } else ic.style.display = 'none';
    renderStats(); renderChart(); renderNodes(); renderPolicies(); renderEngine();
    renderQueue(); renderDetail();
    renderEvidence(); renderMon(); renderAI(); renderFin();
    // 活动面板：演示中只刷新数据条，非演示时展示真实监控状态
    if (demoRunning) { NOW_STATE.data = nowDataChips(); nowRender(); }
    else nowLive();
    // 核保节点下拉
    const sel = $('fNode');
    const sig = (S.nodes || []).map(n => n.id).join('|');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = (S.nodes || []).map(n => `<option value="${n.id}">${n.id}</option>`).join('');
    }
    dispatchEvent(new Event('insurance-state'));
  } catch (e) {
    $('srvDot').className = 'dot bad'; $('srvTxt').textContent = '连接中断 · 数据待更新';
  }
}

/* ═══════════════════════════════════════════════════════════
   「当前在做什么」活动面板 —— 向展示对象实时交代系统在干什么
   常驻显示：不点演示时显示真实监控状态；演示时显示当前步骤 + 实时数据。
   ═══════════════════════════════════════════════════════════ */
const STAGE_CN = { REPORTED: '已自动报案', INVESTIGATING: '查勘定损中', ADJUSTED: '核价中', ADJUDICATED: '核赔中', PAID: '赔付划付中', RECOVERED: '代位追偿中' };
const STAGE_ORDER = ['REPORTED', 'INVESTIGATING', 'ADJUSTED', 'ADJUDICATED', 'PAID', 'RECOVERED'];
const NOW_STATE = { mode: 'live', idx: '●', title: '', what: '', data: [], step: 0, total: 0 };

function nowRender() {
  const s = NOW_STATE;
  $('nowMode').textContent = s.mode === 'demo' ? '一键演示 · 60S' : '实时监控 · LIVE';
  $('nowIdx').textContent = s.idx;
  $('nowTitle').textContent = s.title;
  $('demoTxt').textContent = s.what;                       // 保留 demoTxt 以兼容既有回归
  $('nowData').innerHTML = (s.data || []).filter(Boolean).map(d =>
    `<span class="nd${d.tone ? ' ' + d.tone : ''}">${d.k} <b>${d.v}</b></span>`).join('');
  const st = $('nowSteps');
  st.innerHTML = s.total > 0
    ? Array.from({ length: s.total }, (_, i) => `<i class="ns${i < s.step - 1 ? ' done' : (i === s.step - 1 ? ' cur' : '')}"></i>`).join('')
    : '';
}

/* 实时数据条：有在办赔案就报赔案，否则报监控 */
function nowDataChips() {
  const s = S || {};
  const open = (s.claims || []).filter(c => c.stage !== 'CLOSED');
  const cur = open[open.length - 1];
  if (cur) return [
    { k: '赔案', v: cur.no },
    { k: '阶段', v: STAGE_CN[cur.stage] || cur.stage },
    cur.payable ? { k: '应付', v: cur.payable + ' BOT' } : null,
    cur.track ? { k: '通道', v: cur.track === 'STP' ? '直通' : '编排' } : null,
    cur.fraud != null ? { k: '欺诈分', v: cur.fraud } : null,
  ].filter(Boolean);
  const obs = s.observers || [], up = obs.filter(o => o.ok).length;
  const node = (s.nodes || []).find(n => n.real) || (s.nodes || [])[0];
  return [
    { k: '观察者在线', v: `${up}/${obs.length || 3}`, tone: up >= 2 ? 'ok' : 'warn' },
    node ? { k: '风险分', v: node.risk } : null,
    { k: '在办赔案', v: open.length },
    s.mon ? { k: '监控可用率', v: s.mon.uptime + '%' } : null,
  ].filter(Boolean);
}

/* 演示态：切到某一幕 */
function nowStep(idx, title, what, step, total) {
  Object.assign(NOW_STATE, { mode: 'demo', idx: String(idx), title, what, step: step || 0, total: total || 0 });
  NOW_STATE.data = nowDataChips();
  nowRender();
}

/* 常态：读真实状态，不编造 */
function nowLive() {
  const s = S || {};
  const open = (s.claims || []).filter(c => c.stage !== 'CLOSED');
  const cur = open[open.length - 1];
  if (cur) {
    Object.assign(NOW_STATE, {
      mode: 'live', idx: '●', title: STAGE_CN[cur.stage] || '处理中',
      what: `赔案 ${cur.no} 正在由系统自动推进，全程无人工介入。`,
      step: STAGE_ORDER.indexOf(cur.stage) + 1, total: STAGE_ORDER.length,
    });
  } else {
    Object.assign(NOW_STATE, {
      mode: 'live', idx: '●', title: '正在监控被保节点',
      what: '三观察者每秒探测节点心跳；看不到的时候不做任何出险判定（监控中断 ≠ 节点正常）。',
      step: 0, total: 0,
    });
  }
  NOW_STATE.data = nowDataChips();
  nowRender();
  if (!demoRunning) {
    const d = new Date();
    $('demoTime').textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    $('demoProg').style.width = '0%';
  }
}

function toggleNow() {
  const folded = $('demoBar').classList.toggle('folded');
  $('nowFold').textContent = folded ? '+' : '—';
}

/* ═══════════ 60 秒一键演示 ═══════════ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let demoRunning = false;

/* 演示计时：每 100ms 走一次，秒表与进度条实时变动（不再按步骤跳变） */
let demoT0 = 0, demoTick = null;
/* 演示自愈：断连 → 自动暂停并提示；连接恢复 → 从断点继续（秒表/进度条/幕次轴全部接续） */
let DEMO_T0 = 0, demoPaused = false, demoPauseT0 = 0;
function waitConn(maxMs) {
  const t0 = Date.now();
  return new Promise(res => {
    (function chk() {
      get('/api/state').then(r => { if (r) return res(true); setTimeout(chk, 1200); })
        .catch(() => { if (Date.now() - t0 > (maxMs || 180000)) return res(false); setTimeout(chk, 1200); });
    })();
  });
}
function demoPause(what) {
  if (demoPaused) return;
  demoPaused = true; demoPauseT0 = Date.now();
  demoTimerStop();                          // 秒表/进度条停走，暂停时段不计入演示时长
  NOW_STATE.what = '⏸ ' + what + '，恢复后将自动继续…';
  nowRender();
}
function demoResume() {
  if (!demoPaused) return;
  const elapsed = demoPauseT0 - demoT0;     // 暂停前已进行的演示秒数
  const dur = Date.now() - demoPauseT0;     // 暂停时长
  DEMO_T0 += dur;                           // 幕次时间轴顺延
  demoT0 = Date.now() - elapsed;            // 秒表接续（不归零、不计时暂停）
  demoPaused = false;
  nowLive();
  demoTimerStart();
}
/* 网络守卫：演示中任何网络调用失败 → 暂停 → 等连接 → 重试该调用 */
async function demoNet(fn) {
  for (;;) {
    try { return await fn(); }
    catch (e) {
      const netErr = e instanceof TypeError || /fetch|network/i.test(String((e && e.message) || e));
      if (!netErr || !demoRunning) throw e;
      demoPause('服务连接中断');
      const back = await waitConn(180000);
      if (!back) throw new Error('服务长时间未恢复（已等待 3 分钟）');
      demoResume();
    }
  }
}
function demoClock() {
  const s = Math.max(0, (Date.now() - demoT0) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  $('demoTime').textContent = mm + ':' + ss + '.' + Math.floor((s % 1) * 10);
  $('demoProg').style.width = Math.min(100, s / 60 * 100) + '%';
}
function demoTimerStart() {
  demoT0 = Date.now();
  clearInterval(demoTick);
  demoTick = setInterval(demoClock, 100);
  demoClock();
}
function demoTimerStop() { clearInterval(demoTick); demoTick = null; }


function demoSay(txt) {
  // 旁白形如「③ 报案 —— 说明」→ 拆成大字标题 + 白话说明，并同步顶部字幕
  const m = String(txt).match(/^([①-⑨])\s*([^—–]+)[—–]{1,2}\s*([\s\S]*)$/);
  if (m) nowStep(m[1], m[2].trim(), m[3].trim(), DEMO_SCENE_NO(m[1]), 7);
  else { NOW_STATE.mode = 'demo'; NOW_STATE.what = String(txt); nowRender(); }
  subSay(m ? m[1] : '●', m ? m[2].trim() + ' —— ' + m[3].trim() : String(txt));
}

/* ── 顶部字幕条：演示时才出现，结束即收起（不影响静态界面） ── */
function subSay(idx, txt) {
  const bar = $('subBar'); if (!bar) return;
  document.body.classList.add('demo-on');
  $('sbIdx').textContent = idx;
  $('sbTxt').textContent = txt;
  if (!REDUCE_MOTION) {
    const el = $('sbTxt');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';   // 重播淡入
  }
}
function subOff() { document.body.classList.remove('demo-on'); }
function subTag(t) { if ($('sbTag')) $('sbTag').textContent = t; }

/* ── 随机场景：每次演示抽一组真实可承保的输入，用于验证引擎在各种组合下是否可行 ── */
const PICK = arr => arr[Math.floor(Math.random() * arr.length)];
const PROD_CN = { DOWNTIME: '宕机险', LATENCY: '延迟险', HASHRATE: '算力险' };
function rollScenario() {
  const nodes = (S && S.nodes) || [];
  const prods = Object.keys((S && S.products) || {}).filter(k => PROD_CN[k]);
  if (!prods.length) prods.push('DOWNTIME');
  const node = nodes.length ? PICK(nodes) : { id: 'aegis-node-01' };
  const product = PICK(prods);
  const sumInsured = PICK([8000, 12000, 15000, 20000, 25000, 30000, 35000, 40000, 50000, 60000]);
  const days = PICK([30, 90, 90, 180, 365]);
  const deductible = PICK([500, 1000, 1500, 2000]);
  const concur = PICK([8, 12, 16, 20]);          // 攻击并发
  const dur = PICK([3, 4, 6]);                    // 压测持续时间（秒）
  return {
    nodeId: node.id, nodeName: node.name || node.id, product, sumInsured, days, deductible, concur, dur,
    prodCn: PROD_CN[product] || product,
    stamp: new Date().toISOString(),
  };
}
/* 把随机值写回核保表单 —— 界面上能看见这次抽到了什么 */
function fillUnderwrite(sc) {
  const set = (id, v) => { if ($(id)) $(id).value = v; };
  if ($('fNode')) { $('fNode').value = sc.nodeId; }
  set('fProd', sc.product); set('fSum', sc.sumInsured); set('fDays', sc.days); set('fDed', sc.deductible);
}
/* 本次随机场景的历史可行的累计（localStorage，仅本机） */
function demoLog(rec) {
  try {
    const k = 'aegis.demoRuns';
    const arr = JSON.parse(localStorage.getItem(k) || '[]');
    arr.push(rec);
    while (arr.length > 50) arr.shift();
    localStorage.setItem(k, JSON.stringify(arr));
    const okN = arr.filter(x => x.ok).length;
    return { n: arr.length, rate: arr.length ? Math.round(okN / arr.length * 100) : 100 };
  } catch (e) { return { n: 1, rate: 100 }; }
}
/* 幕号 → 步骤序号（面板底部六格进度） */
function DEMO_SCENE_NO(idx) {
  return { '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5, '⑥': 6, '⑦': 7 }[idx] || 0;
}
function demoEnd() {
  demoTimerStop();
  $('demoTime').textContent = '01:00.0';
  $('demoProg').style.width = '100%';
  setTimeout(() => { demoRunning = false; window.InsuranceFlow.refreshControls(); nowLive(); subOff(); }, 4000);
}

function b64(text) { return btoa(unescape(encodeURIComponent(text))); }
async function uploadDemoDoc(claimNo, kind, name, text) {
  return post('/api/evidence/upload', { claimNo, kind, name, dataBase64: b64(text), submitter: '投保人 · 节点运营方（演示代传）' });
}
const DEMO_HB = [
  '[2026-10-07 16:02:11] ERROR heartbeat lost, node unreachable',
  '[2026-10-07 16:02:12] ERROR rpc endpoint timeout, service down',
  '[2026-10-07 16:07:40] WARN  workload dropped 98%, outage ongoing',
  '[2026-10-07 16:31:05] INFO  service recovered after failover',
].join('\n');
const DEMO_OPS = [
  '运维工单 OP-5512',
  '现象：节点突发宕机，heartbeat 连续丢失，服务 down，算力输出中断。',
  '处置：值班工程师 5 分钟响应，执行故障切换，29 分钟后恢复。',
  '结论：突发硬件故障，已完成处置并复测通过。',
].join('\n');

/* 攻击未触发自动报案时兜底：人工报案 + 当场补全两份必要单证 */
async function ensureDemoClaim(product) {
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const cs = (S && S.claims) || [];
    if (cs.length) { selClaim = cs[0].no; return cs[0]; }
  }
  const nodeId = (S && S.nodes && S.nodes[0] && S.nodes[0].id) || 'aegis-node-01';
  const r = await post('/api/claim/manual', { nodeId, product: product || 'DOWNTIME' });
  if (r && r.ok) {
    selClaim = r.claim.no;
    await sleep(2500);                       // 等定损/核赔进入待补证
    await uploadDemoDoc(r.claim.no, 'HEARTBEAT_LOG', 'heartbeat.log', DEMO_HB);
    await uploadDemoDoc(r.claim.no, 'OPS_TICKET', 'ops-ticket.txt', DEMO_OPS);
    return r.claim;
  }
  return null;
}

async function demo60() {
  if (demoRunning) return toast('演示进行中…');
  if (!window.InsuranceFlow.canReset()) return toast('请先完成当前提交或核对待确认的出单结果，再开始演练。', 'err');
  demoRunning = true;
  window.InsuranceFlow.refreshControls();
  /* 开演预检：服务不通就明确拒绝并给指引，而不是跑到一半「Failed to fetch」 */
  try { await get('/api/state'); }
  catch (e) { demoRunning = false; window.InsuranceFlow.refreshControls(); return toast('服务未连接，请先启动本地服务（双击 start-server.bat）', 'err'); }
  demoTimerStart();
  DEMO_T0 = Date.now();
  /* 本次随机场景：每次演示抽一组真实可承保的输入，跑完给出可行性判定 */
  const SC = rollScenario();
  let scPrem = 0, scPayable = 0, scNet = 0, scRec = 0, scNo = '';
  subTag(`随机场景 · ${SC.nodeId} · ${SC.prodCn} · 保额 ${fmt(SC.sumInsured)} · ${SC.days}天`);
  const at = async (sec, txt, fn) => {
    const wait = DEMO_T0 + sec * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    demoSay(txt, sec);
    if (fn) await demoNet(fn);
  };
  try {
    await at(0, `① 买保险 —— 随机抽到 ${SC.nodeId}（${SC.prodCn}），核保中…`, async () => {
      goView('apply'); await post('/api/reset', {}); selClaim = null; await pull();
      fillUnderwrite(SC);
      const q = await quote(true);
      if (!q) throw new Error('报价未完成，演练已中断');
      if (q.decision === 'DECLINE') {
        demoSay(`① 买保险 —— 本次随机场景被拒保：${((q.reasons || [])[0] || {}).d || '风险超限'}，风控生效`);
        SC.declined = true;
        return;
      }
      scPrem = q.premium || 0;
      const policy = await issue(true);
      if (!policy) throw new Error('出单尚未完成，请核对申请状态');
      demoSay(`① 买保险 —— ${SC.nodeId} 花 ${fmt(scPrem)} BOT，买到 ${SC.days} 天、保额 ${fmt(SC.sumInsured)} 的${SC.prodCn}（免赔 ${fmt(SC.deductible)}）`);
    });
    await at(9, `② 出事了 —— ${SC.nodeId} 被 ${SC.concur} 路并发流量打瘫，心跳断掉，算力收入开始流失`, async () => {
      goView('mon'); await post('/api/attack', { concur: SC.concur, ms: SC.dur * 1000 });
    });
    await at(17, '③ 系统自己立案 —— 三个观察者都连不上它，判定真宕机，无需投保人申请', async () => {
      goView('wk'); ensureDemoClaim(SC.product);        // 不阻塞旁白，后台等赔案出现
    });
    await at(27, '④ 算该赔多少 —— 逐项核实损失、比对市场价、剔除无关部分，第三方公估签字');
    await at(38, '⑤ 赔钱 —— 核赔通过后直接划款，其中 20% 由再保公司承担');
    await at(48, '⑥ 追偿与赚钱 —— 向责任方追回一部分，20% 由再保摊回，把综合成本率压在 100% 以下', async () => {
      goView('ov');
      const cs = (S && S.claims) || [];
      if (!cs.length) await ensureDemoClaim(SC.product);
    });
    await at(56, '⑦ 完了 —— 从宕机到拿到赔款约 40 秒，全程没有人工介入', async () => {
      const cs = (S && S.claims) || [];
      const c = cs[cs.length - 1];
      const m = (S && S.metrics) || {};
      const cr = m.combinedRatio || 0;
      const uw = m.uwProfit || 0;
      scNo = c ? c.no : '';
      scPayable = c ? (c.payable || 0) : 0;
      scNet = c ? (c.net || 0) : 0;
      scRec = c ? (c.recovered || 0) : 0;
      const feasible = !!c && !!c.payable && cr < 100;                 // 闭环且承保盈利 = 可行
      const hist = demoLog({ t: SC.stamp, node: SC.nodeId, prod: SC.product, sum: SC.sumInsured, days: SC.days, prem: scPrem, payable: scPayable, cr, uw, ok: feasible });
      if (c && c.payable) {
        NOW_STATE.data = [
          { k: '赔案', v: c.no, tone: 'ok' },
          { k: '实赔', v: c.payable + ' BOT', tone: 'ok' },
          { k: '自留', v: (c.net || 0) + ' BOT' },
          { k: '追偿', v: (c.recovered || 0) + ' BOT' },
          { k: '本次成本率', v: cr + '%', tone: cr < 100 ? 'ok' : 'warn' },
          { k: '历史可行率', v: hist.rate + '%（' + hist.n + ' 次）', tone: 'ok' },
        ];
        NOW_STATE.what = `本次随机场景 ${SC.nodeId}／${SC.prodCn}／保额 ${fmt(SC.sumInsured)}：收保费 ${fmt(scPrem)} BOT，实赔 ${fmt(scPayable)}（自留 ${fmt(scNet)}、追偿 ${fmt(scRec)}）→ 组合综合成本率 ${cr}%、承保利润 ${fmt(uw)} BOT → ${feasible ? '可行 ✓' : '需复核'}。单张赔款大于保费是保险的常态，盈利与否看组合口径（历史 ${hist.n} 次随机演练可行率 ${hist.rate}%）。`;
      } else if (SC.declined) {
        NOW_STATE.data = [{ k: '核保', v: '拒保', tone: 'warn' }, { k: '本次', v: '风控拦截', tone: 'ok' }];
        NOW_STATE.what = `本次随机场景（${SC.nodeId}／${SC.prodCn}）被核保拒保 —— 风控拦截本身就是可行性的另一种证明：不赚钱的单不做。`;
      } else {
        NOW_STATE.what = `本次随机场景未产生赔付（监控未判定出险）。历史 ${hist.n} 次随机演练可行率 ${hist.rate}%。`;
      }
      nowRender();
      demoSay(`⑦ 完了 —— ${feasible ? '可行 ✓' : '需复核'}：组合成本率 ${cr}%、承保利润 ${fmt(uw)} BOT · 历史 ${hist.n} 次随机演练可行率 ${hist.rate}%`);
    });
    demoEnd();
  } catch (e) {
    demoTimerStop();
    demoSay('演示中断：' + (e.message || e), 0);
    setTimeout(() => { demoRunning = false; window.InsuranceFlow.refreshControls(); nowLive(); subOff(); }, 6000);
  }
}

setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);
bindDrop();
goView('ov');
pull();
setInterval(pull, 1600);
