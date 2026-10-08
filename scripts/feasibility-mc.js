/* 组合层面可行性蒙特卡洛（Aegis 神盾 · 盈利验证）
 * ------------------------------------------------------------
 * 为什么必须做组合口径：
 *   单张保单「出一次险就亏」是保险的常态，不是模型缺陷。
 *   90 天期保费只覆盖约 0.6 次期望出险，一旦真出险，赔款必然超过这一张的保费。
 *   保险靠的是大数定律 + 再保险 + 聚合，所以可行性只能在**组合层面**判定。
 *
 * 模型（全部用真实代码与实测数据，不用复制品）：
 *   定价：server/pricing.js priceQuote（与线上同一个函数）
 *   损失强度：reports/severity-calibration.json 的实证样本（真实理赔引擎干跑得到）
 *   出险次数：泊松(年化频率 × 期间/365)
 *   通道结构：现实 70% 预言机自动 / 25% 人工 / 5% 盲区
 *   LAE：按实测直通率判定直通(45) vs 编排(380)，并按直通门槛净额 ≤12000 强制降级
 *
 * 用法：node scripts/feasibility-mc.js [保单张数=2000] [组合重复次数=400] [随机种子]
 */
const path = require('path');
const { priceQuote, ACT, PRODUCTS } = require('../server/pricing.js');

const M = Number(process.argv[2] || 2000);        // 单个组合的保单张数
const RUNS = Number(process.argv[3] || 400);      // 组合重复次数
let seed = Number(process.argv[4] || 20261007);

/* ---- 可复现随机 ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(seed);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const poisson = (lam) => {           // Knuth，λ 小
  const L = Math.exp(-lam); let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
};

/* ---- 实证损失强度样本（真实理赔引擎干跑得到） ---- */
const CAL_PATH = path.join(__dirname, '..', 'reports', 'severity-calibration.json');
if (!require('fs').existsSync(CAL_PATH)) {
  console.error('缺少 reports/severity-calibration.json，请先跑：node scripts/calibrate-severity.js 120 <基址>');
  process.exit(1);
}
const CAL = require(CAL_PATH);
const SAMPLES = {}, STPR = {}, STPCHAN = {};
for (const p of Object.keys(PRODUCTS)) {
  SAMPLES[p] = (CAL.samples && CAL.samples[p] && CAL.samples[p].length) ? CAL.samples[p] : [PRODUCTS[p].sevCal];
  STPR[p] = (CAL.stpRate && CAL.stpRate[p]) ? CAL.stpRate[p].realistic : 0.5;
  // 分层直通率：P(直通 | 通道)。无条件直通率不能再叠加通道限制，否则双重计数把 LAE 算错。
  STPCHAN[p] = (CAL.stpByChan && CAL.stpByChan[p]) ? CAL.stpByChan[p] : { AUTO: STPR[p] };
}
const drawSev = (p) => { const s = SAMPLES[p]; return s[Math.floor(rnd() * s.length)]; };
const stpGiven = (p, chan) => {
  const t = STPCHAN[p];
  return typeof (t && t[chan]) === 'number' ? t[chan] : 0;
};

/* ---- 业务结构假设（可复现、可质疑、可改） ---- */
const MIX = {
  product: { DOWNTIME: 0.45, LATENCY: 0.30, HASHRATE: 0.25 },
  channel: { AUTO: 0.70, MANUAL: 0.25, BLIND: 0.05 },   // 现实结构：预言机自动报案为主
  sumInsured: [8000, 12000, 15000, 20000, 25000, 30000, 35000, 40000, 50000, 60000],
  terms: [30, 60, 90, 180],
  risk: [12, 18, 25, 31, 38, 44, 52, 60],               // 节点风险分档（与节点注册表同量级）
};
const drawKey = (m) => { let r = rnd(); for (const k of Object.keys(m)) { r -= m[k]; if (r <= 0) return k; } return Object.keys(m)[0]; };
const STP_MAX_NET = 12000;   // 直通式准入门槛（与 server/insurer.js STP.maxNet 一致）

/* 情景开关：通道结构（报案渠道恶化会直接抬高 LAE）与损失强度倍数（参数误差敏感性） */
let CHAN_MIX = MIX.channel;
let SEV_MULT = 1;      // 损失强度倍数（参数低估敏感性）
let FREQ_MULT = 1;     // 出险频率倍数（参数低估敏感性）

/* ---- 单张保单的期间损益（随机实现） ---- */
function simulatePolicy() {
  const product = drawKey(MIX.product);
  const sumInsured = pick(MIX.sumInsured);
  const days = pick(MIX.terms);
  const risk = pick(MIX.risk);
  const q = priceQuote({ risk, nodePremium: 0, nodeIncNet: 0, product, sumInsured, days });
  const lam = (q.freq || 0) * (days / 365) * FREQ_MULT;
  const n = poisson(lam);
  let gross = 0, lae = 0;
  const prod = PRODUCTS[product];
  for (let i = 0; i < n; i++) {
    const g = drawSev(product) * sumInsured * SEV_MULT;
    gross += g;
    const chan = drawKey(CHAN_MIX);
    // 直通判定：P(直通|通道) 用分层实测值；净额超门槛必须降级为编排（含第三方定损）
    const netOne = g * (1 - ACT.cession);
    const stp = netOne <= STP_MAX_NET && rnd() < stpGiven(product, chan);
    lae += stp ? ACT.laeSTP : ACT.laeFull;
  }
  // 年度累计限额（aggCap）按期间折算
  const aggCap = prod.aggCap * sumInsured * Math.min(1, days / 365);
  if (gross > aggCap) gross = aggCap;
  const ceded = gross * ACT.cession;
  const net = gross - ceded;
  const recovered = net * ACT.recovery;
  const netLoss = net - recovered;
  const expense = q.premium * ACT.expenseRatio;
  return {
    product, sumInsured, days, risk, n,
    premium: q.premium, gross, net, recovered, netLoss, lae, expense,
    profit: q.premium - netLoss - lae - expense,
  };
}

/* ---- 跑一个组合 ---- */
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
function runPortfolio() {
  const ps = [];
  for (let i = 0; i < M; i++) ps.push(simulatePolicy());
  const written = sum(ps, p => p.premium);
  const netLoss = sum(ps, p => p.netLoss);
  const lae = sum(ps, p => p.lae);
  const expense = sum(ps, p => p.expense);
  const gross = sum(ps, p => p.gross);
  const recovered = sum(ps, p => p.recovered);
  /* 自留口径：与 server/insurer.js 口径完全一致——
     分出保费要真分出去，再保人返还分保佣金冲减费用，避免「只分赔款不分保费」把利润做好看。 */
  const cededPremium = written * ACT.cession;
  const cedingComm = cededPremium * ACT.cedingComm;
  const netEarned = written - cededPremium + cedingComm;
  const netExpense = Math.max(0, expense - cedingComm);
  return {
    written, gross, netLoss, lae, expense, recovered, cededPremium, cedingComm, netEarned, netExpense,
    profit: written - netLoss - lae - expense,                       // 总保费口径承保利润
    profitNet: netEarned - netLoss - lae - netExpense,               // 自留口径（更严格）
    combined: (netLoss + lae + expense) / written,
    combinedNet: (netLoss + lae + netExpense) / netEarned,
    claims: sum(ps, p => p.n),
    byProduct: Object.keys(PRODUCTS).reduce((a, p) => {
      const rs = ps.filter(x => x.product === p);
      const w = sum(rs, x => x.premium);
      a[p] = w ? (sum(rs, x => x.netLoss + x.lae + x.expense)) / w : 0;
      return a;
    }, {}),
    perPolicy: ps,
  };
}

/* ---- 执行 ---- */
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (n) => (n * 100).toFixed(1) + '%';
const money = (n) => Math.round(n).toLocaleString('en-US');

/* 标定漂移守卫：定价用的 sevCal 必须等于实证样本的均值，否则定价有偏，
   而综合成本率仍会显示得很好看（因为分子分母用的是同一套数）——这是最危险的失真。 */
const drift = [];
for (const p of Object.keys(PRODUCTS)) {
  const m = SAMPLES[p].reduce((a, b) => a + b, 0) / SAMPLES[p].length;
  const d = Math.abs(PRODUCTS[p].sevCal - m) / Math.max(1e-9, m);
  if (d > 0.2) drift.push(`${p}: 定价 ${(PRODUCTS[p].sevCal * 100).toFixed(2)}% vs 实证均值 ${(m * 100).toFixed(2)}%（偏 ${(d * 100).toFixed(0)}%）`);
}
if (drift.length) {
  console.log('\n⚠ 标定漂移（定价参数与实证样本已脱节，结论不可信 —— 请重跑 npm run calibrate 并同步 server/pricing.js）：');
  drift.forEach(s => console.log('  · ' + s));
}

console.log(`组合可行性蒙特卡洛 · 每组合 ${M} 张保单 · 重复 ${RUNS} 次 · 种子 ${seed}`);
console.log(`定价来源：server/pricing.js（线上同一函数） · 损失强度：实证样本（n=${CAL.n}/险种，${CAL.ts.slice(0, 10)}）`);
console.log(`结构假设：产品 ${JSON.stringify(MIX.product)} · 通道 ${JSON.stringify(MIX.channel)} · 期间 ${MIX.terms.join('/')}天\n`);

const runs = [];
for (let i = 0; i < RUNS; i++) runs.push(runPortfolio());

const comb = runs.map(r => r.combined), combNet = runs.map(r => r.combinedNet);
const profit = runs.map(r => r.profit), profitNet = runs.map(r => r.profitNet);
const written = runs.map(r => r.written), netEarned = runs.map(r => r.netEarned);
const lossRuns = comb.filter(c => c > 1).length, lossRunsNet = combNet.filter(c => c > 1).length;
const allPolicies = runs[runs.length - 1].perPolicy;

console.log('── ① 组合综合成本率（判定盈利的核心指标）──');
console.log(`  总保费口径：均值 ${pct(mean(comb))} · P5 ${pct(q(comb, .05))} · P50 ${pct(q(comb, .5))} · P95 ${pct(q(comb, .95))} · P99 ${pct(q(comb, .99))}`);
console.log(`  自留口径　：均值 ${pct(mean(combNet))} · P95 ${pct(q(combNet, .95))} · P99 ${pct(q(combNet, .99))}（更严格：分出保费 + 分保佣金冲减费用）`);
console.log(`  承保利润　：总保费口径 ${money(mean(profit))} BOT（利润率 ${pct(mean(profit) / mean(written))}）· 自留口径 ${money(mean(profitNet))} BOT（利润率 ${pct(mean(profitNet) / mean(netEarned))}）`);
console.log(`  亏损概率　：总保费口径 ${pct(lossRuns / RUNS)} · 自留口径 ${pct(lossRunsNet / RUNS)}`);

console.log('\n── ② 分险种综合成本率 ──');
const cn = { DOWNTIME: '宕机险', LATENCY: '延迟险', HASHRATE: '算力险' };
for (const p of Object.keys(PRODUCTS)) {
  const a = runs.map(r => r.byProduct[p]).filter(x => x > 0);
  if (!a.length) continue;
  console.log(`  ${cn[p]}：均值 ${pct(mean(a))} · P95 ${pct(q(a, .95))}`);
}

console.log('\n── ③ 单张保单（期望口径 vs 尾部压力）──');
const pr = allPolicies.map(p => p.profit);
const withClaim = allPolicies.filter(p => p.n > 0);
const wcProfit = withClaim.map(p => p.profit);
console.log(`  全部保单：单均利润 ${mean(pr).toFixed(0)} BOT · 盈利占比 ${pct(pr.filter(x => x > 0).length / pr.length)}`);
console.log(`  出险保单：单均利润 ${mean(wcProfit).toFixed(0)} BOT · 亏损占比 ${pct(wcProfit.filter(x => x <= 0).length / wcProfit.length)} ← 尾部压力，非模型亏损`);
console.log(`  说明：期间期望出险 ${mean(allPolicies.map(p => p.n)).toFixed(2)} 次，出险率 ${pct(withClaim.length / allPolicies.length)}；`);
console.log(`        「出险的那部分保单亏钱」正是保险靠大数定律运转的原因，可行性看①不看这一行。`);

console.log('\n── ④ 尾部与资本 ──');
const worst = q(comb, .99);
console.log(`  P99 综合成本率 ${pct(worst)} → 极端年景仍${worst < 1 ? '盈利' : '需动用资本/再保摊回'}`);
console.log(`  追偿回收：均值 ${money(mean(runs.map(r => r.recovered)))} BOT/组合（代位求偿，${pct(ACT.recovery)}）`);
console.log(`  再保分出：净赔款中 ${pct(ACT.cession)} 由再保人摊回`);

console.log('\n── ⑤ 情景压力（假设错了还能不能活）──');
const SCEN = [
  { name: '基准：现实通道结构', chan: MIX.channel, sev: 1 },
  { name: '通道恶化：人工+盲区 60%', chan: { AUTO: 0.40, MANUAL: 0.40, BLIND: 0.20 }, sev: 1 },
  { name: '损失强度低估 25%', chan: MIX.channel, sev: 1.25 },
  { name: '损失强度低估 50%', chan: MIX.channel, sev: 1.5 },
  { name: '损失强度低估 100%', chan: MIX.channel, sev: 2.0 },
  { name: '出险频率 +50%', chan: MIX.channel, sev: 1, freq: 1.5 },
];
const scenOut = [];
for (const s of SCEN) {
  CHAN_MIX = s.chan; SEV_MULT = s.sev; FREQ_MULT = s.freq || 1;
  const rs = [];
  for (let i = 0; i < Math.max(60, Math.round(RUNS / 2)); i++) rs.push(runPortfolio());
  const c = mean(rs.map(r => r.combined)), cn2 = mean(rs.map(r => r.combinedNet));
  const flag = c < 1 && cn2 < 1 ? '✓ 两口径均盈利' : (c < 1 ? '△ 自留口径转亏' : '✗ 总保费口径即转亏');
  scenOut.push({ name: s.name, combined: +c.toFixed(4), combinedNet: +cn2.toFixed(4) });
  console.log(`  ${s.name.padEnd(24, ' ')} 综合成本率 ${pct(c)}（自留 ${pct(cn2)}） ${flag}`);
}
CHAN_MIX = MIX.channel; SEV_MULT = 1; FREQ_MULT = 1;
/* 容错边界：净赔款被低估多少倍，综合成本率才触到 100%
   （LAE 与费用不随损失强度放大，所以只放大净赔款这一项） */
const SW = mean(runs.map(r => r.written)), SL = mean(runs.map(r => r.lae));
const SN = mean(runs.map(r => r.netLoss)), SE = mean(runs.map(r => r.expense));
const tol = (SW - SL - SE) / Math.max(1e-9, SN);
console.log(`  容错边界：净赔款被低估 ${((tol - 1) * 100).toFixed(1)}% 时，综合成本率才触及 100%（自留口径 ${((((SW * (1 - ACT.cession + ACT.cession * ACT.cedingComm)) - SL - Math.max(0, SE - SW * ACT.cession * ACT.cedingComm)) / Math.max(1e-9, SN) - 1) * 100).toFixed(1)}%）`);

const verdict = mean(comb) < 1 && lossRuns / RUNS < 0.05;
const out = {
  ts: new Date().toISOString(), M, RUNS, seed,
  combinedMean: +mean(comb).toFixed(4), combinedP95: +q(comb, .95).toFixed(4), combinedP99: +q(comb, .99).toFixed(4),
  combinedNetMean: +mean(combNet).toFixed(4),
  profitMean: Math.round(mean(profit)), writtenMean: Math.round(mean(written)),
  lossProb: +(lossRuns / RUNS).toFixed(4), lossProbNet: +(lossRunsNet / RUNS).toFixed(4),
  tolerance: +(tol - 1).toFixed(4), scenarios: scenOut, verdict,
  mix: MIX, act: { stpAssume: ACT.stpAssume, cession: ACT.cession, recovery: ACT.recovery, expenseRatio: ACT.expenseRatio },
  sevCal: Object.keys(PRODUCTS).reduce((a, p) => (a[p] = PRODUCTS[p].sevCal, a), {}),
};
require('fs').writeFileSync(path.join(__dirname, '..', 'reports', 'feasibility-mc.json'), JSON.stringify(out, null, 2));
console.log('\n报告已写 reports/feasibility-mc.json');
console.log('结论：' + (verdict
  ? `可行 —— 组合综合成本率 ${pct(mean(comb))}，亏损概率 ${pct(lossRuns / RUNS)}，承保利润率 ${pct(mean(profit) / mean(written))}`
  : `不可行 —— 组合综合成本率 ${pct(mean(comb))}，亏损概率 ${pct(lossRuns / RUNS)}，需校准参数`));
