/**
 * Aegis 神盾 · 被保算力节点（真实运行的服务）
 * ------------------------------------------------------------
 * 角色：链下组件中的「节点心跳模拟器 + 风控Agent 数据源」
 * 前端 Demo 会真实轮询 /health；把本服务打挂（attack.js 或 /work 阻塞），
 * 前端连续探测超时 → 风控Agent 判定违约 → 触发保单 → 自动赔付。
 *
 * 启动： node server/node-server.js   （默认 http://127.0.0.1:8787）
 */
const http = require("http");
const os = require("os");

const PORT = process.env.PORT || 8787;

const state = {
  start: Date.now(),
  reqs: 0,
  heartbeats: 0,
  killed: false,
  attackHits: 0,
  lat: [],           // 最近处理延迟样本
  history: [],       // 节点侧心跳日志（供监控盲区补录）
  downSince: 0,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function pushLat(ms) {
  state.lat.push(ms);
  if (state.lat.length > 30) state.lat.shift();
}
function avgLat() {
  if (!state.lat.length) return 0;
  return Math.round(state.lat.reduce((a, b) => a + b, 0) / state.lat.length);
}
/** 风控Agent 自评风险分：基于平均处理延迟与负载（0 最安全 / 100 最高危） */
function selfRisk() {
  const l = avgLat();
  let r = 8 + Math.min(60, l / 12);                       // 延迟贡献
  r += Math.min(20, os.loadavg()[0] * 12);                // 系统负载贡献
  return Math.max(5, Math.min(100, Math.round(r)));
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...CORS, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** 同步忙等 —— 真实占死 Node 主线程，模拟算力节点被压垮 */
function burn(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(Math.random() * 1000);
  return x;
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const u = new URL(req.url, "http://127.0.0.1");
  state.reqs++;

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  /* ---- 心跳：前端风控Agent 轮询的接口 ---- */
  if (u.pathname === "/health") {
    if (state.killed) {
      state.history.push({ ts: Date.now(), ok: false, src: "health" });
      return json(res, 503, { status: "down", reason: "killed", downSince: state.downSince });
    }
    state.heartbeats++;
    pushLat(Date.now() - t0);
    if (state.history.length > 400) state.history.shift();
    state.history.push({ ts: Date.now(), ok: true, src: "health", lat: Date.now() - t0 });
    return json(res, 200, {
      status: "ok",
      node: "aegis-node-01",
      uptime: Math.round((Date.now() - state.start) / 1000),
      heartbeats: state.heartbeats,
      latency: Date.now() - t0,
      avgLatency: avgLat(),
      load: os.loadavg()[0].toFixed(2),
      mem: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      risk: selfRisk(),               // 风控Agent 实时风险分
      underAttack: state.attackHits > 0,
      ts: Date.now(),
    });
  }

/* ---- 第二个观察者独立端点（模拟异地观察者） ---- */
  if (u.pathname === "/observer2") {
    if (state.killed) {
      state.history.push({ ts: Date.now(), ok: false, src: "observer-2" });
      return json(res, 503, { status: "down", src: "observer-2", reason: "killed" });
    }
    state.heartbeats++;
    pushLat(Date.now() - t0);
    return json(res, 200, {
      status: "ok", src: "observer-2", node: "aegis-node-01",
      uptime: Math.round((Date.now() - state.start) / 1000),
      latency: Date.now() - t0, risk: selfRisk(), ts: Date.now(),
    });
  }

  /* ---- 补录接口：监控盲区结束后回拉节点侧心跳日志 ---- */
  if (u.pathname === "/history") {
    const from = +u.searchParams.get("from") || 0;
    const win = state.history.filter(h => h.ts >= from);
    const down = win.filter(h => !h.ok).length;
    // 依据样本间隔推断离线时长（样本点间隔 3s）
    return json(res, 200, {
      window: { from, to: Date.now() },
      samples: win.slice(-40),
      downSamples: down,
      provenDownSeconds: down * 3,
      hasData: win.length > 0,
    });
  }

  /* ---- 指标 ---- */
  if (u.pathname === "/metrics") {
    return json(res, 200, {
      reqs: state.reqs, heartbeats: state.heartbeats, attackHits: state.attackHits,
      avgLatency: avgLat(), risk: selfRisk(), killed: state.killed,
      load: os.loadavg(), mem: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      latencySamples: state.lat,
    });
  }

  /* ---- 算力任务（攻击面）：同步阻塞，占满主线程 ---- */
  if (u.pathname === "/work") {
    const ms = Math.min(10000, Math.max(100, +u.searchParams.get("ms") || 3000));
    state.attackHits++;
    burn(ms);
    pushLat(Date.now() - t0);
    return json(res, 200, { ok: true, burnedMs: ms });
  }

  /* ---- 硬宕机 / 恢复（可控演示） ---- */
  if (u.pathname === "/admin/kill") {
    state.killed = true; state.downSince = Date.now();
    console.log("[node] ☠️  已硬宕机（/health 返回 503）");
    return json(res, 200, { killed: true });
  }
  if (u.pathname === "/admin/revive") {
    state.killed = false; state.downSince = 0; state.attackHits = 0; state.lat = [];
    console.log("[node] 💚 已恢复服务");
    return json(res, 200, { killed: false });
  }

  return json(res, 404, { error: "not found", endpoints: ["/health", "/metrics", "/work", "/admin/kill", "/admin/revive"] });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Aegis] 被保算力节点已启动 → http://127.0.0.1:${PORT}`);
  console.log("  GET /health        心跳（前端风控Agent 轮询）");
  console.log("  GET /work?ms=6000  算力任务（攻击面：同步阻塞主线程）");
  console.log("  GET /admin/kill    硬宕机   /admin/revive 恢复");
});
