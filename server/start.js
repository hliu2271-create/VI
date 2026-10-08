/* 单端口统一入口：先起被保真实节点（内部 8787），再起保险核心（对外 PORT）
 * NODE_IMPL=target  → 被保节点改为「链安保险靶机 insure-target」（经 target-adapter 代理）
 * 默认               → 内置 node-server.js */
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const NODE_PORT = process.env.NODE_PORT || "8787";
const PORT = process.env.PORT || 8788;

// 1) 被保真实节点（内部端口，不对外暴露）
const impl = process.env.NODE_IMPL === "target" ? "target-adapter.js" : "node-server.js";
const nodeSrv = spawn(process.execPath, [path.join(__dirname, impl)], {
  env: { ...process.env, PORT: NODE_PORT }, stdio: ["ignore", "inherit", "inherit"],
});
nodeSrv.on("exit", c => console.log("[node-server] exit", c));

// 2) 保险核心（对外端口）
process.env.NODE_SRV = "http://127.0.0.1:" + NODE_PORT;
process.env.PORT = String(PORT);

// 等待被保节点就绪后再拉起核心，避免首轮询误判离线
const t0 = Date.now();
(function wait() {
  const req = http.get("http://127.0.0.1:" + NODE_PORT + "/health", res => {
    res.resume();
    require("./insurer.js");
  });
  req.on("error", () => {
    if (Date.now() - t0 > 15000) { console.error("被保节点启动超时，仍继续拉起核心"); return require("./insurer.js"); }
    setTimeout(wait, 300);
  });
})();

process.on("SIGTERM", () => { try { nodeSrv.kill(); } catch (e) {} process.exit(0); });
