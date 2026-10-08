/**
 * Aegis 神盾 · 精算定价核心（纯函数模块）
 * ------------------------------------------------------------
 * 独立出来是为了让「可行性压测 / 蒙特卡洛 / 财务测算」引用的是**真实定价代码**，
 * 而不是脚本里复制一份公式——复制品会漂移，压测结论就不可信。
 *
 * 盈利模型（精算口径）：
 *   保费 = (期望净损失 + 期望理赔费用 LAE) ÷ (1 − 费用率 − 目标利润率) × 风险边际
 *   毛赔款 → 比例再保险分出 cession → 自留净赔款 → 代位追偿 recovery → 最终净损失
 *   综合成本率 = (自留净赔款 + LAE) / 已赚保费 + 费用率
 *
 * 现实保险经营里最常见的死法：只盯赔付率、漏掉理赔费用（LAE）。
 * 因此 LAE 必须进分子，且通道结构假设必须与实测一致（见 stpAssume）。
 */

const fs = require("fs");
const path = require("path");

const R2 = (n) => Math.round(n * 100) / 100;

/* ============ 精算假设 ============ */
const ACT = {
  expenseRatio: 0.22,     // 费用率（佣金 + 管理）
  profitMargin: 0.15,     // 目标承保利润率
  riskMargin: 1.10,       // 风险边际
  cession: 0.20,          // 比例再保险分出比例（Quota Share，行业常见 15%~30%）
  cedingComm: 0.25,       // 分保佣金率（再保人从分出保费中返还，行业常见 20%~30%）
  recovery: 0.25,         // 代位追偿率（行业实际水平 15%~30%）
  waitingHours: 1,        // 免赔期：起赔前 N 小时不赔
  avgHours: 3.5,          // 定价假设：平均单次事故时长（仅作 sevCal 缺失时的兜底）
  stopLoss: 1.10,         // 节点赔付率红线 → 自动停售
  laeSTP: 45,             // 直通件单均理赔费用（Loss Adjustment Expense）
  laeFull: 380,           // 编排件单均理赔费用（含第三方定损、调查、复核）
  /* 定价假设直通率（全局兜底）。实测综合 48%，见 PRODUCTS[].stpRate 的分险种实测值。 */
  stpAssume: 0.43,
  /* 实证标定回灌（experience rating）：
     定价不写死常数，而是跟随 reports/severity-calibration.json 的最新实测值，
     再乘一层保守边际 sevMargin 吸收标定本身的抽样噪声。
     否则「标定重跑 → 实证值变了 → 定价没跟上」会让压测判定定价不充分，
     报告数字与引擎各说一套——这正是当初把公式独立出来的反面。 */
  sevMargin: 0.05,
  calMinSamples: 100,     // 标定样本量低于此值不予采信，退回兜底常数
};

/* stpRate：分险种定价假设直通率，来源 reports/severity-calibration.json 的**分层**实测。
   实测规律很干净：AUTO 通道 100% 直通，人工/盲区一律 0%；算力险任何通道都 0%
   （算力可自报、易被操纵，引擎设计上必须第三方定损）。
   宕机/延迟险定价取 0.70 = 实测值（现实通道 70% 自动报案 × 自动件 100% 直通）。
   不额外拍保守边际——所有定价参数一律取实测值，安全垫只在 riskMargin / profitMargin 里
   显式体现；「假设错了会怎样」交给 scripts/feasibility-mc.js 的情景压力去披露，
   而不是塞进参数里当黑箱。
   若沿用一刀切假设，算力险 LAE 会被低估 61%，组合压测里表现为综合成本率 96.8%。 */
const PRODUCTS = {
  DOWNTIME: { name: "节点宕机险", hourly: 0.020, occCap: 0.20, aggCap: 0.40, freq: 2.4, sevCal: 0.0137, stpRate: 0.70, desc: "连续心跳丢失触发，阶梯赔付" },
  LATENCY: { name: "延迟超标险", hourly: 0.012, occCap: 0.12, aggCap: 0.25, freq: 3.0, sevCal: 0.0055, stpRate: 0.70, desc: "延迟连续超阈值触发" },
  HASHRATE: { name: "算力不足险", hourly: 0.015, occCap: 0.15, aggCap: 0.30, freq: 2.0, sevCal: 0.0088, stpRate: 0.00, desc: "算力低于承诺 90% 触发，须第三方定损" },
};
/* sevCal：实证标定的「单次期望赔付率（核定/保额）」，来自 reports/severity-calibration.json。
   原公式 sev = (平均时长 − 免赔期) × 每小时费率 是**均值线性外推**，
   而真实出险时长右偏长尾（0.5h~12h），长尾事故损失可达均值假设的 3~5 倍。
   sevCal 用真实理赔引擎跑出来的分布均值，含免赔期侵蚀与单次限额截断，是经验费率。 */

/**
 * 实证标定回灌：用最新实测的 severity / 直通率覆盖兜底常数。
 * 返回标定元信息（未生效时返回 null），便于脚本打印「定价跟随哪一次标定」。
 */
function loadCalibration() {
  const off = process.env.AEGIS_NO_CAL === "1";
  const file = path.join(__dirname, "..", "reports", "severity-calibration.json");
  try {
    if (off || !fs.existsSync(file)) return null;
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!c || !c.suggest || !c.suggest.sevCal || !Number.isFinite(c.n) || c.n < ACT.calMinSamples) return null;
    let changed = 0;
    for (const p of Object.keys(PRODUCTS)) {
      const sev = c.suggest.sevCal[p];
      if (typeof sev === "number" && sev > 0) {
        /* 注意精度：sevCal 是 1% 量级的比率，R2（两位小数）会把它抹成 0.02 —— 失真 30%。
           比率一律用 4 位小数。 */
        PRODUCTS[p].sevCal = Math.round(sev * (1 + ACT.sevMargin) * 10000) / 10000;
        changed++;
      }
      const stp = c.stpRate && c.stpRate[p] && c.stpRate[p].realistic;
      if (typeof stp === "number") PRODUCTS[p].stpRate = stp;
    }
    return changed ? { ts: c.ts, n: c.n, margin: ACT.sevMargin, sevCal: c.suggest.sevCal } : null;
  } catch (e) {
    return null;
  }
}

/**
 * 单次期望赔付率（severity）
 * 优先用实证标定值；缺失时退回均值线性兜底（保证不中断）。
 */
function severity(prod) {
  if (prod && typeof prod.sevCal === "number" && prod.sevCal > 0) return prod.sevCal;
  return Math.min(prod.occCap, Math.max(0, (ACT.avgHours - ACT.waitingHours) * prod.hourly));
}

/**
 * 精算定价（纯函数，不依赖 DB）
 * @param {object} a
 * @param {number} a.risk          节点风险分（未知节点用 40 标准体）
 * @param {number} a.nodePremium   该节点累计已赚保费（用于续保加费）
 * @param {number} a.nodeIncNet    该节点累计自留净赔款（用于续保加费）
 * @param {string} a.product       险种
 * @param {number} a.sumInsured    保额
 * @param {number} a.days          保险期间（天）
 */
function priceQuote(a) {
  const prod = PRODUCTS[a.product] || PRODUCTS.DOWNTIME;
  const sum = Math.max(0, Number(a.sumInsured) || 0);
  const term = Math.max(1, Number(a.days) || 30);
  const risk = Number.isFinite(a.risk) ? a.risk : 40;
  // 年化出险频率：基础频率 × 风险调整
  const freq = prod.freq * (0.5 + risk / 60);
  // 单次期望赔付率（实证标定，含免赔期与单次限额）
  const sev = severity(prod);
  // 再保分出 + 代位追偿后的净损失率
  const netRate = sev * (1 - ACT.cession) * (1 - ACT.recovery);
  // 年期望净损失
  const annualExpected = sum * freq * netRate;
  const termExpected = annualExpected * (term / 365);
  /* 期望理赔费用（LAE）：按**分险种**实测直通率加权单均费用 × 期间期望出险次数。
     直通件 45 BOT vs 编排件 380 BOT 差 8 倍，一刀切假设会系统性错定价。 */
  const stpAssume = typeof prod.stpRate === "number" ? prod.stpRate : ACT.stpAssume;
  const laePerClaim = stpAssume * ACT.laeSTP + (1 - stpAssume) * ACT.laeFull;
  const termLae = freq * (term / 365) * laePerClaim;
  // 保费 = (期望净损失 + 期望LAE) / (1 - 费用率 - 目标利润率) × 风险边际
  let premium = ((termExpected + termLae) / (1 - ACT.expenseRatio - ACT.profitMargin)) * ACT.riskMargin;
  // 续保加费：该节点赔付率越高，费率越高（保证可持续盈利）
  const nodeLR = a.nodePremium > 0 ? (a.nodeIncNet || 0) / a.nodePremium : 0;
  const renewalLoad = nodeLR > 0.8 ? 1 + (nodeLR - 0.8) * 0.8 : 1;
  premium *= renewalLoad;
  // 最低保费（覆盖固定成本）
  premium = Math.max(premium, sum * 0.0015);
  return {
    premium: R2(premium), deductible: R2(sum * 0.02), freq: R2(freq),
    sev: R2(sev * 100), renewalLoad: R2(renewalLoad), nodeLR: R2(nodeLR * 100),
    expNetLoss: R2(termExpected), expLae: R2(termLae),   // 定价构成透明化：净损失 + 理赔费用
    laePerClaim: R2(laePerClaim), combined: R2(((termExpected + termLae) / Math.max(1, premium) + ACT.expenseRatio) * 100),
  };
}

const CAL = loadCalibration();   // 模块加载即回灌：服务、脚本、压测全部跟随同一份实测

module.exports = { ACT, PRODUCTS, R2, severity, priceQuote, CAL };
