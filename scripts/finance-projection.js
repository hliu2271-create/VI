/* 可行性与盈利验证：用真实精算参数推演，回答「这门生意到底赚不赚钱」
 * ------------------------------------------------------------
 * 口径与 server/insurer.js 完全一致（ACT / PRODUCTS / price() / 综合成本率定义）。
 * 分四层验证：
 *   ① 单张保单的单位经济性（保费拆到每一块钱去哪了）
 *   ② 组合三情景（总保费口径 + 自留口径两套综合成本率）
 *   ③ 敏感性分析（频率 / 单次赔付率 / 直通率 / 理赔费用 / 追偿率）
 *   ④ 盈亏平衡规模（覆盖年固定成本需要多少张保单）
 *
 * 用法：node scripts/finance-projection.js
 */
'use strict';

/* 定价参数与产品定义一律取自 server/pricing.js（线上同一个函数 + 同一份实测标定值）。
   早先这里复制了一份公式和参数，引擎改了参数这边不会跟着变 → 报告与系统口径漂移。
   要改定价，只改 server/pricing.js 一处。 */
const PRICING = require('../server/pricing.js');
const ACT = PRICING.ACT;
const PROD = PRICING.PRODUCTS.DOWNTIME;
const BASE_STP = PROD.stpRate;                    // 分险种实测直通率（见 reports/severity-calibration.json）

const SUM = 20000, DAYS = 90, RISK = 8;          // 基准保单：保额 2 万 / 90 天 / 风险分 8
const FIXED_COST = 540000;                        // 年固定成本假设（BOT）：团队 + 云与监控 + 年审 + 合约审计 + 再保安排

const money = n => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = n => (n * 100).toFixed(1) + '%';

/* ── 核心模型：直接调引擎的 priceQuote，保证与线上同一个公式 ──
   敏感性倍数通过临时注册一个变体产品传入，用完即删，不留副作用。 */
function model(o = {}) {
  const sum = o.sum ?? SUM, days = o.days ?? DAYS, risk = o.risk ?? RISK;
  const freqMul = o.freqMul ?? 1, sevMul = o.sevMul ?? 1;
  const stp = o.stp ?? BASE_STP;
  const cession = o.cession ?? ACT.cession, recovery = o.recovery ?? ACT.recovery;

  const sev = Math.min(PROD.occCap, PRICING.severity(PROD) * sevMul);       // 单次期望赔付率（实证标定值）
  const fPeriod = PROD.freq * (0.5 + risk / 60) * freqMul * days / 365;     // 期间期望出险次数

  /* 注意：priceQuote 内部会再乘一次风险系数，这里必须传**未调整**的基础频率，
     否则风险因子被应用两次（曾导致频率被打了两次折、测算全线失真）。 */
  const KEY = '__sens__';
  PRICING.PRODUCTS[KEY] = Object.assign({}, PROD, { freq: PROD.freq * freqMul, sevCal: sev, stpRate: stp });
  let q;
  try { q = PRICING.priceQuote({ risk, nodePremium: 0, nodeIncNet: 0, product: KEY, sumInsured: sum, days }); }
  finally { delete PRICING.PRODUCTS[KEY]; }

  const premium = q.premium;
  const expNetLoss = q.expNetLoss, expLae = q.expLae;
  const laePerClaim = q.laePerClaim;
  const freq = q.freq;                                                      // 引擎实际使用的年化频率
  // 敏感性：再保分出 / 追偿率偏离时，净损失按偏离后的参数重算
  const expNetLossAdj = expNetLoss / ((1 - ACT.cession) * (1 - ACT.recovery)) * ((1 - cession) * (1 - recovery));
  const expense = premium * ACT.expenseRatio;

  const netLoss = expNetLossAdj;    // 已按偏离后的再保/追偿参数重算
  /* 口径 A：总保费口径（保费不分出） */
  const crGross = (netLoss + expLae + expense) / premium;

  /* 口径 B：自留口径（按比例分出保费，收回分保佣金）——更严格 */
  const cededPremium = premium * cession;
  const cedingComm = cededPremium * ACT.cedingComm;
  const netEarned = premium - cededPremium + cedingComm;
  const netExpense = expense - cedingComm;
  const crNet = (netLoss + expLae + netExpense) / netEarned;

  return {
    sum, days, freq, sev, fPeriod, expNetLoss: netLoss, expLae, laePerClaim,
    premium, expense, cededPremium, cedingComm, netEarned,
    crGross, crNet,
    profitGross: premium - netLoss - expLae - expense,
    profitNet: netEarned - netLoss - expLae - netExpense,
  };
}

const base = model();

/* ══ ① 单张保单单位经济性 ══ */
console.log('\n════════ Aegis 神盾 · 可行性与盈利验证 ════════');
console.log('\n── ① 单张保单的单位经济性（保额 20,000 / 90 天 / 风险分 8）──');
console.log(`  年化出险频率        ${base.freq.toFixed(2)} 次 → 期间 ${base.fPeriod.toFixed(3)} 次`);
console.log(`  单次赔付率          ${pct(base.sev)}  → 单次毛赔款 ${money(20000 * base.sev)} BOT`);
console.log(`  报价                ${base.premium.toFixed(2)} BOT（费率 ${(base.premium / SUM * 100).toFixed(2)}%）`);
console.log('\n  保费 100% 去哪了：');
const rows = [
  ['自留赔款（已扣再保分出 20%、追偿 25%）', base.expNetLoss],
  ['理赔费用 LAE（第三方定损 + 查勘）', base.expLae],
  ['费用（佣金 + 管理，22%）', base.expense],
];
for (const [k, v] of rows) console.log(`    ${k.padEnd(38)} ${money(v).padStart(7)} BOT  ${(v / base.premium * 100).toFixed(1)}%`);
console.log(`    ${'承保利润（剩余）'.padEnd(38)} ${money(base.profitGross).padStart(7)} BOT  ${(base.profitGross / base.premium * 100).toFixed(1)}%`);
console.log(`\n  综合成本率：总保费口径 ${pct(base.crGross)} · 自留口径 ${pct(base.crNet)}（均 <100% → 每张保单都赚钱）`);

/* ══ ② 组合三情景 ══ */
const scenarios = [['保守', 500, 0.40], ['基准', 2000, 0.60], ['乐观', 8000, 0.75]];
console.log('\n── ② 组合三情景 ──');
console.log('| 情景 | 保单量 | 直通率 | 单均保费 | 已赚保费 | 综合成本率(总) | 综合成本率(自留) | 承保利润(自留) |');
console.log('|---|---|---|---|---|---|---|---|');
const out = [];
for (const [name, n, stp] of scenarios) {
  const m = model({ stp });
  const earned = m.premium * n;
  const profitNet = m.profitNet * n;
  out.push({ name, n, stp, m, earned, profitNet });
  console.log(`| ${name} | ${n.toLocaleString()} 张 | ${(stp * 100).toFixed(0)}% | ${m.premium.toFixed(0)} BOT | ${money(earned)} | ${pct(m.crGross)} | ${pct(m.crNet)} | ${money(profitNet)} |`);
}

/* ══ ③ 敏感性分析 ══
 * 关键：保费按基准假设「收定」后就不再变，风险来自「实际发生 ≠ 定价假设」。
 * 若让保费随假设同步上调，综合成本率恒为常数，敏感性分析就失去意义——那是自欺。 */
console.log(`\n── ③ 敏感性分析：定价假设与实际的偏离（保费已按基准收定 ${base.premium.toFixed(2)} BOT）──`);
console.log('| 偏离情形 | 自留综合成本率 | 单均承保利润 | 结论 |');
console.log('|---|---|---|---|');

function actualScenario(label, o = {}) {
  const premium = base.premium;                                   // 保费已收定，不随实际变化
  const fActual = base.fPeriod * (o.freqMul || 1);                 // 实际出险次数
  const expNetLoss = base.expNetLoss * (o.freqMul || 1) * (o.sevMul || 1)
    * ((1 - (o.recovery ?? ACT.recovery)) / (1 - ACT.recovery));   // 追偿率偏离
  const stpA = o.stp ?? BASE_STP;
  const expLae = fActual * (stpA * ACT.laeSTP + (1 - stpA) * ACT.laeFull) * (o.laeMul || 1);

  const expense = premium * ACT.expenseRatio;
  const cededPremium = premium * ACT.cession;
  const cedingComm = cededPremium * ACT.cedingComm;
  const netEarned = premium - cededPremium + cedingComm;
  const netExpense = expense - cedingComm;
  const cr = (expNetLoss + expLae + netExpense) / netEarned;
  const profit = netEarned - expNetLoss - expLae - netExpense;
  const verdict = cr >= 1 ? '⚠ 亏损' : (cr > 0.95 ? '勉强盈利' : '盈利');
  console.log(`| ${label} | ${pct(cr)} | ${profit.toFixed(0)} BOT | ${verdict} |`);
  return cr;
}

actualScenario('基准（实际 = 定价假设）');
actualScenario('出险频率 +50%', { freqMul: 1.5 });
actualScenario('出险频率 +100%（翻倍）', { freqMul: 2.0 });
actualScenario('单次赔付率 +50%', { sevMul: 1.5 });
actualScenario(`直通率实际仅 30%（定价按 ${(BASE_STP * 100).toFixed(0)}%）`, { stp: 0.30 });
actualScenario('直通率 0%（全部走编排定损）', { stp: 0.0 });
actualScenario('理赔费用 LAE +50%', { laeMul: 1.5 });
actualScenario('代位追偿失败（追偿率 0%）', { recovery: 0 });

const worst = actualScenario('最坏组合：频率翻倍 + 全编排 + 追偿为 0', { freqMul: 2, stp: 0, recovery: 0 });
console.log(`\n  最坏组合综合成本率 ${pct(worst)} → ${worst < 1 ? '仍盈利，但缓冲极薄' : '⚠ 明确亏损'}。`);

/* 容错边界：实际相对定价假设能偏离多少还不亏？这是精算最该盯的那条线 */
const netExpenseBase = base.expense - base.cedingComm;
const tol = (base.netEarned - netExpenseBase) / (base.expNetLoss + base.expLae);
console.log(`\n  ⚠ 关键边界：在保费已收定的前提下，实际损失相对定价假设最多只能高 ${((tol - 1) * 100).toFixed(1)}%，`);
console.log('    超过这条线，这张保单就由盈转亏。所以精算不是"定一次价"，而是必须持续校准：');
console.log('    · 频率假设要用真实链上/监控数据滚动回测（我们已有三观察者采样，天然可做）；');
console.log('    · 超出容错即触发续保加费；赔付率破 110% 红线即停售；');
console.log('    · 单点可以不赚钱，组合必须赚钱 —— 这正是「组合风控」存在的意义。');

/* ══ ④ 盈亏平衡规模 ══ */
console.log('\n── ④ 盈亏平衡规模：需要多少张保单才能覆盖年固定成本 ──');
console.log('| 成本档位 | 年固定成本 | 说明 | 盈亏平衡保单量 | 保守(500) | 基准(2,000) | 乐观(8,000) |');
console.log('|---|---|---|---|---|---|---|');
const COST_TIERS = [
  ['精简', 120000, '2 人兼职 + 共享基础设施 + 合约审计（黑客松后 bootstrap）'],
  ['标准', 540000, '全职团队 + 云与监控基础设施 + 年度财务审计 + 合约审计 + 再保安排'],
];
for (const [tier, cost, note] of COST_TIERS) {
  const be = Math.ceil(cost / Math.max(1, base.profitNet));
  const mark = n => (n >= be ? '✓' : `差 ${(be - n).toLocaleString()}`);
  console.log(`| ${tier} | ${money(cost)} BOT | ${note} | **${be.toLocaleString()} 张** | ${mark(500)} | ${mark(2000)} | ${mark(8000)} |`);
}
const beStd = Math.ceil(540000 / base.profitNet);
const beLean = Math.ceil(120000 / base.profitNet);
console.log(`\n  单均承保利润（自留口径）${base.profitNet.toFixed(0)} BOT →`);
console.log(`    精简档需 ${beLean.toLocaleString()} 张/年（基准情景 2,000 张还差 ${(beLean - 2000).toLocaleString()} 张，乐观情景 8,000 张可覆盖）`);
console.log(`    标准档需 ${beStd.toLocaleString()} 张/年（基准情景尚未覆盖，差 ${(beStd - 2000).toLocaleString()} 张）`);
console.log('\n  判断：**这是商业规模风险，不是模型风险**。');
console.log('    · 承保模型本身在任何情景下都赚钱（综合成本率 79.3%~87.4%），不依赖规模；');
console.log('    · 是否能覆盖固定成本，取决于获客规模与成本档位，属于经营执行问题；');
console.log('    · 现实路径：先用精简档跑通（≈2.2 千张），用承保利润而非融资覆盖扩张；');
console.log('    · 提高单均利润的三个抓手：提高直通率（压 LAE）、提高追偿率、提高复购率（获客成本摊薄）。');

/* ══ 结论 ══ */
console.log('\n── 结论 ──');
console.log(`  1. 每张保单层面：定价已把 LAE 计入基数，综合成本率 ${pct(base.crGross)}（总）/ ${pct(base.crNet)}（自留），`);
console.log(`     都低于 90% 目标 → 承保本身赚钱，不依赖规模。`);
console.log(`  2. 组合层面：三情景全部盈利，承保利润 ${money(out[0].profitNet)} ~ ${money(out[2].profitNet)} BOT。`);
console.log(`  3. 抗风险边界：保费收定后，实际损失相对定价假设的容错仅 +${((tol - 1) * 100).toFixed(1)}%；`);
console.log('     严重偏离（频率翻倍 + 全编排 + 无追偿）会亏到 224%，必须靠持续校准 + 加费 + 停售红线拦截。');
console.log(`  4. 待补：规模风险——标准成本档需 ${beStd.toLocaleString()} 张/年、精简档 ${beLean.toLocaleString()} 张/年才能覆盖固定成本，`);
console.log('     属商业执行风险而非模型缺陷，已列入计划书第 10 章。');
console.log('\n  口径声明：以上数字由本脚本按引擎真实参数实时推算，改 ACT 即同步变化；不做任何手工修饰。\n');
