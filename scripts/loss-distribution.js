/* 出险时长分布（全项目共用，标定与压测必须用同一分布，否则结论不自洽）
 * 依据运维经验：多数事故短、少数长尾——右偏分布，不能用「平均时长」线性外推定价。
 */
const HOURS_DIST = [
  { h: 0.5, p: 0.14 },
  { h: 1, p: 0.22 },
  { h: 2, p: 0.24 },
  { h: 3, p: 0.16 },
  { h: 4, p: 0.10 },
  { h: 6, p: 0.08 },
  { h: 9, p: 0.04 },
  { h: 12, p: 0.02 },
];

function sampleHours(rnd) {
  const r = rnd ? rnd() : Math.random();
  let acc = 0;
  for (const d of HOURS_DIST) { acc += d.p; if (r <= acc) return d.h; }
  return HOURS_DIST[HOURS_DIST.length - 1].h;
}

const meanHours = () => HOURS_DIST.reduce((s, d) => s + d.h * d.p, 0);

/* 分层抽样（方差削减）：按分布比例**确定性地**排好 n 个时长再打乱。
   纯随机抽样时 12h 长尾只占 2%（200 次里约 4 个样本），却贡献了大部分损失，
   均值估计会在 1.0%~1.6% 之间乱跳 —— 拿这种数去标定定价参数是不可接受的。
   分层后各档样本量固定，均值估计稳定可复现。 */
function stratifiedHours(n, rnd) {
  const r = rnd || Math.random;
  const plan = [];
  for (const d of HOURS_DIST) for (let i = 0; i < Math.max(1, Math.round(d.p * n)); i++) plan.push(d.h);
  for (let i = plan.length - 1; i > 0; i--) {         // Fisher–Yates
    const j = Math.floor(r() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

module.exports = { HOURS_DIST, sampleHours, stratifiedHours, meanHours };
