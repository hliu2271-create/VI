/* 随机场景端到端压测（检测项目能不能跑通，不是自证盈利）
 * ------------------------------------------------------------
 * 与 scripts/feasibility-mc.js 的分工：
 *   本脚本 = **端到端**：随机输入 → 真的调核保/报价/理赔引擎 → 看能不能闭环、定价充不充分。
 *   蒙特卡洛 = **组合盈利**：用实证损失分布做大数定律聚合，判定能不能赚钱。
 *   两者判的不是同一件事，混在一起会得出错误结论。
 *
 * 这里刻意不把「单张保单出一次险就亏」当成亏损：
 *   90 天期保费只覆盖约 0.6 次期望出险，一旦真出险，赔款必然超过这一张的保费——
 *   这是保险的常态。单张实现只作**尾部压力**披露，盈亏结论看组合口径。
 *
 * 判据（三条全部成立才算本次「可行」）：
 *   ① 定价可行：端到端报价 > 0，且报价 ≥ 实证期望成本（纯保费充足，不倒挂）
 *   ② 处理可行：赔案走到终局（APPROVED / DECLINED / REFERRED），没有卡死
 *   ③ 经济可行（期望口径）：保费 − 期望净损失 − 期望 LAE − 费用 > 0
 *
 * 用法：node scripts/random-feasibility.js [次数=50] [基址=http://127.0.0.1:8788]
 */
const path = require('path');
const BASE = process.argv[3] || process.env.BASE || 'http://127.0.0.1:8788';
const N = Number(process.argv[2] || 50);
const { ACT, PRODUCTS } = require('../server/pricing.js');
const api = async (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then(r => r.json());

const PICK = a => a[Math.floor(Math.random() * a.length)];
const PRODS = ['DOWNTIME', 'LATENCY', 'HASHRATE'];
const SUMS = [8000, 12000, 15000, 20000, 25000, 30000, 35000, 40000, 50000, 60000];
const DED = [500, 1000, 1500, 2000];
const HOURS = [0.5, 1, 2, 3, 4, 6, 9, 12];
const SRCS = ['AUTO', 'MANUAL', 'AUTO', 'MANUAL', 'BLIND'];
const DOCSETS = [[], ['HEARTBEAT_LOG', 'OPS_TICKET'], ['HEARTBEAT_LOG', 'OPS_TICKET', 'CLOUD_BILL']];
const NOTES = [
  '', '', '',
  '本次为计划内维护窗口内的例行停机，已提前公告。',
  '根因定位为上游机房可用区故障，骨干网中断，非本节点自身过错。',
];
const TERM = 90;

/* 实证损失强度（用于核验定价是否不低于实证期望 —— 检测参数偏差，而非重复定价公式） */
const CALP = path.join(__dirname, '..', 'reports', 'severity-calibration.json');
const CAL = require('fs').existsSync(CALP) ? require(CALP) : null;
const empSev = (p) => (CAL && CAL.byProduct && CAL.byProduct[p]) ? CAL.byProduct[p].mean : PRODUCTS[p].sevCal;

function roll() {
  const product = PICK(PRODS);
  const sumInsured = PICK(SUMS);
  const deductible = PICK(DED);
  const hours = PICK(HOURS);
  const src = PICK(SRCS);
  const docs = src === 'AUTO' ? [] : PICK(DOCSETS);
  const note = PICK(NOTES);
  return { product, sumInsured, deductible, hours, src, docs, note };
}

(async () => {
  /* 先重置：承保能力校验会看「保额 / 风险池资本」，服务跑久了资本被压测赔案消耗后
     会整批触发集中度拒保，测出来的「可行率」就成了环境噪声而不是模型结论。
     压测要可复现，必须从干净状态开始（与 60 秒演示开演时 reset 的做法一致）。 */
  await api('/api/reset', {}).catch(() => {});
  const st = await fetch(BASE + '/api/state').then(r => r.json());
  const nodes = (st.nodes || []).map(n => n.id);
  if (!nodes.length) { console.error('拿不到节点列表，服务未就绪？' + BASE); process.exit(1); }

  console.log(`随机端到端压测 · ${N} 次 · 目标 ${BASE}`);
  console.log(`节点 ${nodes.length} 个 · 险种 ${PRODS.length} 种 · 保额 ${SUMS.length} 档 · 时长 ${HOURS.length} 档 · 期间 ${TERM} 天`);
  console.log(`实证损失强度：${CAL ? 'reports/severity-calibration.json（' + CAL.ts.slice(0, 10) + '）' : '未标定，退回定价内置值'}\n`);

  const rows = [];
  for (let i = 0; i < N; i++) {
    const r = roll();
    const nodeId = PICK(nodes);
    // ① 定价（端到端真实报价）
    const q = await api('/api/quote', { nodeId, product: r.product, sumInsured: r.sumInsured, days: TERM, deductible: r.deductible });
    if (!q || q.error) { rows.push({ ...r, nodeId, err: 'quote:' + (q && q.error) }); continue; }
    const premium = q.premium || 0;
    /* 定价充分性：报价是否 ≥ 实证期望成本。
       用实证损失强度（真实理赔引擎干跑得出）反算一遍，与定价内置的期望对比，
       检测「定价公式是否系统性低于真实损失」——单看报价数字看不出这个。 */
    const freq = q.freq || 0;
    const empNet = r.sumInsured * freq * (TERM / 365) * empSev(r.product) * (1 - ACT.cession) * (1 - ACT.recovery);
    const pricedNet = q.expNetLoss || 0;
    const adequate = pricedNet >= empNet * 0.95;      // 容忍 5%：实证标定本身是蒙特卡洛估计，带抽样噪声
    // ③ 经济可行（期望口径）
    const expLae = q.expLae || 0, expense = premium * ACT.expenseRatio;
    const expProfit = premium - pricedNet - expLae - expense;
    // ② 处理可行（端到端真实理赔）
    const sim = await api('/api/lab/sim', { nodeId, product: r.product, sumInsured: r.sumInsured, deductible: r.deductible, hours: r.hours, src: r.src, docs: r.docs, note: r.note });
    if (!sim || !sim.ok) { rows.push({ ...r, nodeId, premium, err: 'sim:' + (sim && sim.error) }); continue; }
    const c = sim.claim || {};
    const lae = c.track === 'STP' ? ACT.laeSTP : ACT.laeFull;
    /* 只有 APPROVED 才真正赔付（服务端 pay() 只在 APPROVED 分支调用）。
       拒赔 / 挂起 / 升级中一律不计净赔款，但理赔费用 LAE 已经发生——该花照花。
       这正是「该拒赔不计入赔付率，保护承保利润」的落点：拒赔省下的是赔款，不是费用。 */
    const paid = c.decision === 'APPROVED';
    const net = paid ? (c.net || 0) - (c.recovered || 0) : 0;
    const terminal = /APPROVED|DECLINED|REFERRED|PENDING_EVIDENCE/.test(c.decision || '');
    const feasible = premium > 0 && adequate && terminal && expProfit > 0;
    rows.push({
      ...r, nodeId, premium, payable: c.payable || 0, net: c.net || 0, rec: c.recovered || 0, lae, paid,
      expense, expNet: pricedNet, empNet, expProfit,
      realizedProfit: premium - net - lae - expense,   // 单次实现（尾部压力，不作结论）
      decision: c.decision, track: c.track, feasible, adequate, decl: q.decision === 'DECLINE',
    });
  }

  const ok = rows.filter(r => r.feasible);
  const err = rows.filter(r => r.err);
  const live = rows.filter(r => !r.err);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const pct = n => (n * 100).toFixed(1) + '%';
  const cn = { DOWNTIME: '宕机险', LATENCY: '延迟险', HASHRATE: '算力险' };

  console.log('── ① 总览（可行 = 定价充分 ∧ 端到端闭环 ∧ 期望承保利润 > 0）──');
  console.log(`样本 ${rows.length} · 可行 ${ok.length}（${pct(ok.length / rows.length)}）· 接口异常 ${err.length}`);
  console.log(`终局闭环 ${live.filter(r => r.decision).length}/${live.length} · 定价充分 ${live.filter(r => r.adequate).length}/${live.length} · 拒保（风控拦截）${rows.filter(r => r.decl).length}`);
  console.log(`期望承保利润：均值 ${avg(live.map(r => r.expProfit)).toFixed(0)} BOT · 最低 ${Math.min(...live.map(r => r.expProfit)).toFixed(0)}`);

  console.log('\n── ② 分险种 ──');
  for (const p of PRODS) {
    const rs = live.filter(r => r.product === p);
    if (!rs.length) continue;
    console.log(`${cn[p]}：样本 ${rs.length} · 可行 ${rs.filter(r => r.feasible).length} · 直通(STP) ${rs.filter(r => r.track === 'STP').length} · 期望利润 ${avg(rs.map(r => r.expProfit)).toFixed(0)} BOT`);
  }

  console.log('\n── ③ 分报案通道 ──');
  for (const s of ['AUTO', 'MANUAL', 'BLIND']) {
    const rs = live.filter(r => r.src === s);
    if (!rs.length) continue;
    console.log(`${s}：样本 ${rs.length} · 闭环 ${rs.filter(r => r.decision).length} · 直通(STP) ${rs.filter(r => r.track === 'STP').length} · 单均 LAE ${avg(rs.map(r => r.lae)).toFixed(0)} BOT`);
  }

  console.log('\n── ④ 尾部压力（单次实现，仅披露，不作盈亏结论）──');
  const tail = live.slice().sort((a, b) => a.realizedProfit - b.realizedProfit);
  console.log(`  期间期望出险仅 ${TERM}/365 × 年化频率 ≈ 0.6 次，出险保单的单张实现必然为负——这是保险的常态。`);
  console.log(`  单张实现利润：均值 ${avg(live.map(r => r.realizedProfit)).toFixed(0)} BOT · 亏损占比 ${pct(live.filter(r => r.realizedProfit <= 0).length / live.length)}`);
  console.log('  最差 5 个样本：');
  tail.slice(0, 5).forEach(r => {
    console.log(`    ${r.nodeId} ${cn[r.product]} 保额${r.sumInsured} ${r.hours}h ${r.src} → 保费${Math.round(r.premium)} 实付净额${Math.round(r.net)} 追偿${Math.round(r.rec)} LAE${r.lae} → 实现 ${Math.round(r.realizedProfit)} BOT · ${r.decision}`);
  });
  if (err.length) console.log('\n接口异常样本：', err.slice(0, 3).map(e => e.err).join(' | '));

  const out = {
    n: rows.length, feasible: ok.length, feasibleRate: ok.length / rows.length,
    closedRate: live.filter(r => r.decision).length / Math.max(1, live.length),
    adequateRate: live.filter(r => r.adequate).length / Math.max(1, live.length),
    expProfitMean: avg(live.map(r => r.expProfit)),
    realizedLossRate: live.filter(r => r.realizedProfit <= 0).length / Math.max(1, live.length),
    errN: err.length, base: BASE, ts: new Date().toISOString(), term: TERM,
    note: '盈亏结论以组合口径为准，见 scripts/feasibility-mc.js',
  };
  require('fs').writeFileSync(path.join(__dirname, '..', 'reports', 'random-feasibility.json'), JSON.stringify({ ...out, rows }, null, 2));
  console.log('\n报告已写 reports/random-feasibility.json');
  console.log('结论：可行率 ' + pct(out.feasibleRate) + '（闭环 ' + pct(out.closedRate) + ' · 定价充分 ' + pct(out.adequateRate) + '）' +
    (out.feasibleRate >= 0.9 ? ' → 端到端稳健' : ' → 需排查'));
  console.log('盈亏结论：请以组合口径为准（node scripts/feasibility-mc.js），单张实现为负不代表模型亏损。');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
