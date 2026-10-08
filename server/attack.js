/**
 * Aegis 神盾 · 攻击脚本（把被保算力节点打挂）
 * ------------------------------------------------------------
 * 用法： node server/attack.js [并发数] [持续秒]
 *   node server/attack.js 40 8     → 40 并发 × 8 秒阻塞
 * 原理：/work 端点同步忙等占死 Node 主线程，
 *       期间 /health 完全无响应 → 前端风控Agent 探测超时 → 判定违约。
 */
const http = require("http");

const N = +process.argv[2] || 40;
const SEC = +process.argv[3] || 8;
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 8787;

function hit(i) {
  return new Promise((res) => {
    const req = http.request(
      { host: HOST, port: PORT, path: `/work?ms=${SEC * 1000}`, method: "GET", timeout: (SEC + 5) * 1000 },
      (r) => { r.resume(); r.on("end", res); }
    );
    req.on("error", () => res());
    req.on("timeout", () => { req.destroy(); res(); });
    req.end();
  });
}

(async () => {
  console.log(`🔥 发起攻击 → http://${HOST}:${PORT}  ${N} 并发 × ${SEC}s 阻塞`);
  // 攻击前心跳
  const before = await new Promise((res) => {
    const r = http.get({ host: HOST, port: PORT, path: "/health" }, (x) => {
      let b = ""; x.on("data", (d) => (b += d)); x.on("end", () => res(b));
    });
    r.on("error", () => res("unreachable"));
  });
  console.log("   攻击前 /health :", before.slice(0, 120));

  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, (_, i) => hit(i)));
  console.log(`✅ 攻击结束，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s — 期间 /health 应无响应`);

  const after = await new Promise((res) => {
    const r = http.get({ host: HOST, port: PORT, path: "/health", timeout: 3000 }, (x) => {
      let b = ""; x.on("data", (d) => (b += d)); x.on("end", () => res(b));
    });
    r.on("error", () => res("unreachable"));
  });
  console.log("   攻击后 /health :", after.slice(0, 120));
})();
