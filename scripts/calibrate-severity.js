/* 单次赔付率（severity）与直通率（STP）实证标定
 * ------------------------------------------------------------
 * 为什么必须标定，不能用拍脑袋的假设：
 *  ① severity：原定价用 sev = (平均时长 − 免赔期) × 每小时费率 —— 均值线性外推。
 *     真实出险时长是右偏长尾（0.5h~12h），长尾事故损失远超该假设。
 *     这里用真实理赔引擎（/api/lab/sim 干跑）按真实时长分布抽样，统计「核定/保额」分布。
 *  ② STP 直通率：定价按 stpAssume 加权 LAE（直通件 45 / 编排件 380，差 8 倍）。
 *     假设拍高了 → 保费里没留够 LAE → 赔付率看着达标，加回理赔费用就亏。
 *     这里按「险种 × 报案通道」实测，区分现实结构与压力结构。
 *
 * 产物 reports/severity-calibration.json 被 scripts/feasibility-mc.js 直接消费。
 * 用法：node scripts/calibrate-severity.js [次数=200] [基址]
 */
const BASE = process.argv[3] || process.env.BASE || 'http://127.0.0.1:8788';
const N = Number(process.argv[2] || 200);
const { sampleHours, stratifiedHours, meanHours } = require('./loss-distribution.js');
const api = async (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then(r => r.json());

const PRODS = ['DOWNTIME', 'LATENCY', 'HASHRATE'];
const CN = { DOWNTIME: '宕机险', LATENCY: '延迟险', HASHRATE: '算力险' };
const SUMS = [8000, 15000, 20000, 30000, 40000, 60000];
/* 报案通道结构：现实结构（预言机自动报案为主）vs 压力结构（人工/盲区为主） */
const MIX = {
  realistic: { AUTO: 0.70, MANUAL: 0.25, BLIND: 0.05 },
  stress: { AUTO: 0.40, MANUAL: 0.40, BLIND: 0.20 },
};
const DOCSETS = [[], ['HEARTBEAT_LOG', 'OPS_TICKET'], ['HEARTBEAT_LOG', 'OPS_TICKET', 'CLOUD_BILL']];
const NOTES = ['', '', '', '本次为计划内维护窗口内的例行停机，已提前公告。', '根因定位为上游机房可用区故障，骨干网中断，非本节点自身过错。'];

const quantile = (a, q) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];
};
const pick = a => a[Math.floor(Math.random() * a.length)];
const drawChan = m => { let r = Math.random(); for (const k of Object.keys(m)) { r -= m[k]; if (r <= 0) return k; } return 'AUTO'; };
/* 分层抽样：按 70/25/5 精确配比轮转，保证每个通道都有足够样本估直通率
   （直通率必须按通道分开估——无条件直通率再叠加通道限制会双重计数，把 LAE 算错） */
const CHAN_PATTERN = (m, total) => {
  const out = [];
  for (const k of Object.keys(m)) for (let i = 0; i < Math.round(m[k] * total); i++) out.push(k);
  return out.length ? out : ['AUTO'];
};
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

(async () => {
  const st = await fetch(BASE + '/api/state').then(r => r.json());
  const nodes = (st.nodes || []).map(n => n.id);
  if (!nodes.length) { console.error('拿不到节点列表，服务未就绪？' + BASE); process.exit(1); }
  console.log(`实证标定 · 每险种 ${N} 次 · 时长分布均值 ${meanHours().toFixed(2)}h（右偏，含 6~12h 长尾）\n`);

  const out = {}, samples = {}, stpMix = {}, stpByChan = {};
  for (const product of PRODS) {
    const sevs = [], hoursSev = {};
    const track = { realistic: { stp: 0, n: 0 }, stress: { stp: 0, n: 0 } };
    const perChan = {};                       // 分层：按通道实测直通率
    const pattern = CHAN_PATTERN(MIX.realistic, 20);
    const hoursPlan = stratifiedHours(N);     // 分层：按时长分布固定配比，压低均值估计方差
    for (let i = 0; i < N; i++) {
      const nodeId = pick(nodes);
      const sumInsured = pick(SUMS);
      const hours = hoursPlan[i % hoursPlan.length];
      const chan = pattern[i % pattern.length];
      const sim = await api('/api/lab/sim', {
        nodeId, product, sumInsured, deductible: sumInsured * 0.02, hours,
        src: chan, docs: pick(DOCSETS), note: pick(NOTES),
      });
      const c = (sim && sim.claim) || {};
      const sev = sumInsured ? (c.payable || 0) / sumInsured : 0;
      sevs.push(sev); samples[product] = samples[product] || []; samples[product].push(+sev.toFixed(6));
      (hoursSev[hours] = hoursSev[hours] || []).push(sev);
      track.realistic.n++; if (c.track === 'STP') track.realistic.stp++;
      perChan[chan] = perChan[chan] || { n: 0, stp: 0 }; perChan[chan].n++;
      if (c.track === 'STP') perChan[chan].stp++;
    }
    // 压力结构单独测直通率（只测通道影响，不重复标 severity）
    const M = Math.max(30, Math.round(N / 2));
    for (let i = 0; i < M; i++) {
      const sim = await api('/api/lab/sim', {
        nodeId: pick(nodes), product, sumInsured: pick(SUMS), deductible: 0,
        hours: sampleHours(), src: drawChan(MIX.stress), docs: pick(DOCSETS), note: pick(NOTES),
      });
      track.stress.n++; if (((sim && sim.claim) || {}).track === 'STP') track.stress.stp++;
    }

    out[product] = {
      mean: +mean(sevs).toFixed(4), p50: +quantile(sevs, 0.5).toFixed(4),
      p75: +quantile(sevs, 0.75).toFixed(4), p90: +quantile(sevs, 0.9).toFixed(4),
      p99: +quantile(sevs, 0.99).toFixed(4), max: +Math.max(...sevs).toFixed(4),
    };
    const byChan = {};
    for (const k of Object.keys(perChan)) byChan[k] = +(perChan[k].stp / perChan[k].n).toFixed(3);
    stpByChan[product] = byChan;
    stpMix[product] = {
      realistic: +(track.realistic.stp / track.realistic.n).toFixed(3),
      stress: +(track.stress.stp / track.stress.n).toFixed(3),
    };
    console.log(`${CN[product]}（${product}）`);
    console.log(`  损失强度（核定/保额）：均值 ${(out[product].mean * 100).toFixed(2)}% · P50 ${(out[product].p50 * 100).toFixed(2)}% · P75 ${(out[product].p75 * 100).toFixed(2)}% · P90 ${(out[product].p90 * 100).toFixed(2)}% · P99 ${(out[product].p99 * 100).toFixed(2)}% · 最大 ${(out[product].max * 100).toFixed(2)}%`);
    console.log('  按时长：' + Object.keys(hoursSev).sort((a, b) => a - b)
      .map(h => `${h}h=${(mean(hoursSev[h]) * 100).toFixed(1)}%`).join(' '));
    console.log(`  直通率：现实结构 ${(stpMix[product].realistic * 100).toFixed(0)}% · 压力结构 ${(stpMix[product].stress * 100).toFixed(0)}%`);
    console.log(`  分层直通率：` + Object.keys(byChan).map(k => `${k}=${(byChan[k] * 100).toFixed(0)}%`).join(' · ') + '\n');
  }

  const stpReal = mean(PRODS.map(p => stpMix[p].realistic));
  const stpStress = mean(PRODS.map(p => stpMix[p].stress));
  console.log(`综合直通率：现实结构 ${(stpReal * 100).toFixed(1)}% · 压力结构 ${(stpStress * 100).toFixed(1)}%`);
  console.log(`→ 定价建议 stpAssume = ${(Math.max(0.2, stpReal - 0.05)).toFixed(2)}（现实结构 −5pp 保守边际）`);
  console.log('→ 建议 sevCal：' + PRODS.map(p => `${p}=${out[p].mean}`).join(' · '));

  require('fs').writeFileSync(require('path').join(__dirname, '..', 'reports', 'severity-calibration.json'),
    JSON.stringify({
      ts: new Date().toISOString(), n: N, hoursMean: meanHours(), base: BASE,
      byProduct: out, samples, stpRate: stpMix, stpByChan,
      stpOverall: { realistic: +stpReal.toFixed(3), stress: +stpStress.toFixed(3) },
      suggest: { stpAssume: +Math.max(0.2, stpReal - 0.05).toFixed(2), sevCal: PRODS.reduce((a, p) => (a[p] = out[p].mean, a), {}) },
    }, null, 2));
  console.log('\n写入 reports/severity-calibration.json');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
