/* 实验室干跑接口自测：跑 5 个场景，并校验经营账未被污染 */
const BASE = 'http://127.0.0.1:8788';
const api = async (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then(r => r.json());

const SCEN = [
  ['直通件 · 保险人监控自动报案', { product: 'DOWNTIME', src: 'AUTO', sumInsured: 20000, hours: 3, docs: [] }],
  ['人工报案 · 未提交单证', { product: 'DOWNTIME', src: 'MANUAL', sumInsured: 20000, hours: 3, docs: [] }],
  ['人工报案 · 单证齐全', { product: 'DOWNTIME', src: 'MANUAL', sumInsured: 20000, hours: 3, docs: ['HEARTBEAT_LOG', 'OPS_TICKET'] }],
  ['计划内维护 · 除外成立', { product: 'DOWNTIME', src: 'MANUAL', sumInsured: 20000, hours: 3, docs: ['HEARTBEAT_LOG', 'OPS_TICKET'], note: '本次为计划内维护窗口内的例行停机，已提前公告。' }],
  ['上游机房故障 · 未提交账单（举证不足）', { product: 'DOWNTIME', src: 'MANUAL', sumInsured: 20000, hours: 3, docs: ['HEARTBEAT_LOG', 'OPS_TICKET'], note: '根因定位为上游机房可用区故障，骨干网中断，非本节点自身过错。' }],
  ['上游机房故障 · 账单齐备（除外成立）', { product: 'DOWNTIME', src: 'MANUAL', sumInsured: 20000, hours: 3, docs: ['HEARTBEAT_LOG', 'OPS_TICKET', 'CLOUD_BILL'], note: '根因定位为上游机房可用区故障，骨干网中断。' }],
  ['大额件 · 超授权阈值', { product: 'DOWNTIME', src: 'AUTO', sumInsured: 400000, hours: 12, docs: [] }],
  ['监控盲区 · 节点自证在线', { product: 'DOWNTIME', src: 'BLIND', sumInsured: 20000, hours: 3, docs: ['SELF_PROOF'] }],
];

(async () => {
  const before = await fetch(BASE + '/api/state').then(r => r.json());
  const b = { claims: before.claims.length, ai: before.ai.length, audit: before.audit.length, w: before.metrics.written, cr: before.metrics.combinedRatio, cap: before.pool ? before.pool.capital : null };

  for (const [name, body] of SCEN) {
    const r = await api('/api/lab/sim', body);
    if (!r.ok) { console.log('FAIL ' + name + ' → ' + r.error); continue; }
    const c = r.claim;
    const ex = (c.exclusions || []).map(h => h.code + ':' + (h.outcome === 'EXCLUSION_APPLIED' ? '成立' : '举证不足')).join(' ');
    console.log(
      name.padEnd(30, ' '),
      '| track', (c.track || '-').padEnd(12),
      '| ' + String(c.decision).padEnd(16),
      '| 申报', String(c.claimed).padStart(6),
      '核减', String(c.cut).padStart(5),
      '应付', String(c.payable).padStart(6),
      '自留', String(c.net).padStart(6),
      '| LAE', String(c.lae).padStart(3),
      '| agents', r.agents.length,
      '|', ex || '—'
    );
  }

  const after = await fetch(BASE + '/api/state').then(r => r.json());
  const a = { claims: after.claims.length, ai: after.ai.length, audit: after.audit.length, w: after.metrics.written, cr: after.metrics.combinedRatio, cap: after.pool ? after.pool.capital : null };
  console.log('\n经营账前后：', JSON.stringify(b), '→', JSON.stringify(a));
  const clean = b.claims === a.claims && b.ai === a.ai && b.audit === a.audit && b.w === a.w;
  console.log(clean ? 'PASS 干跑未污染经营账' : 'FAIL 干跑污染了经营账');
  process.exit(clean ? 0 : 1);
})();
