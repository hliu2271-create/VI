/**
 * 证据上传链路 · CLI 端到端自测
 * 用法： node scripts/evidence-demo.js [scenario]
 *   accident     事故日志 → 证据采纳 → 挂起解除 → 赔付
 *   maintenance  计划内维护工单 → 命中除外责任 → 拒赔
 *   selfproof    在线自证材料 → 推翻不利推定 → 撤销立案
 */
const http = require("http");
const API = "http://127.0.0.1:8788";
const SC = process.argv[2] || "accident";

function req(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(API + path, {
      method, headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) },
    }, (x) => { let b = ""; x.on("data", d => b += d); x.on("end", () => { try { res(JSON.parse(b)); } catch (e) { res(b); } }); });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const log = (...a) => console.log("  ", ...a);

const DOC = {
  accident: {
    kind: "HEARTBEAT_LOG", name: "node-heartbeat.log",
    text: ["# node heartbeat log · aegis-node-01",
      "2026-10-07 09:12:03 heartbeat ok seq=10224 latency=42ms hashrate=98.4TH/s",
      "2026-10-07 09:26:11 heartbeat lost seq=10226 error=connection timeout",
      "2026-10-07 09:27:11 heartbeat lost seq=10227 error=connection timeout OOM",
      "2026-10-07 09:28:11 heartbeat lost seq=10228 error=upstream unreachable",
      "2026-10-07 12:50:02 heartbeat ok seq=10240 latency=51ms",
      "# incident: node down 3.4h, heartbeat lost 7 times, root cause driver OOM"].join("\n"),
  },
  ops: {
    kind: "OPS_TICKET", name: "ops-ticket-8821.txt",
    text: ["# ops ticket #8821 · 主网算力节点 A01 故障处置报告",
      "09:26 告警触发：心跳连续丢失，error=connection timeout，节点 offline",
      "09:31 运维介入：GPU 驱动 OOM，重启容器并切换备用链路",
      "12:50 恢复：节点 online，hashrate 恢复至 97.9TH/s",
      "# 结论：非计划性停机，属突发故障，事故持续 3.4h"].join("\n"),
  },
  bill: {
    kind: "CLOUD_BILL", name: "compute-bill-1007.csv",
    text: ["date,resource,unit_price,amount,status",
      "2026-10-07,GPU-A100,12.5,336,offline",
      "2026-10-07,bandwidth,0.8,120,offline",
      "# 停机期间算力收入损失 456 BOT"].join("\n"),
  },
  maintenance: {
    kind: "OPS_TICKET", name: "ops-ticket-8821.txt",
    text: ["# ops ticket #8821 · GPU 集群例行维护",
      "window: scheduled maintenance window, 计划内维护，已提前 72h 公告",
      "# node down 2.0h during maintenance window, heartbeat suspended by operator"].join("\n"),
  },
  selfproof: {
    kind: "SELF_PROOF", name: "uptime-selfproof.txt",
    text: ["# self-proof · uptime attestation",
      "GET /health 200 OK · status ok · online",
      "heartbeat ok x40 · uptime 99.98% · no offline record",
      "GET /observer2 200 OK · status ok · online"].join("\n"),
  },
};

(async () => {
  console.log(`\n=== 证据上传链路自测 · ${SC} ===`);
  if (SC !== "selfproof") await req("POST", "/api/reset", {});   // 清空证据库，保证用例可复现
  let claimNo;
  if (SC === "selfproof") {
    console.log("[0] 演练：保险人系统下线 12s，同时被保节点整机崩溃（日志不可回拉）…");
    try { await req("GET", "/api/state"); } catch (e) { }
    await new Promise((res) => {
      const r = http.request("http://127.0.0.1:8787/admin/kill", { method: "POST" }, () => res());
      r.on("error", () => res()); r.end();
    });
    await req("POST", "/api/blackout", { seconds: 12 });
    console.log("    等待补录与举证责任倒置立案…");
    for (let i = 0; i < 20; i++) {
      await wait(1500);
      const s = await req("GET", "/api/state");
      const c = s.claims.find(x => x.pendingSelfProof);
      if (c) { claimNo = c.no; break; }
    }
    if (!claimNo) {
      const s = await req("GET", "/api/state");
      const c = s.claims.find(x => x.blind) || s.claims[0];
      if (!c) return console.log("    未产生盲区赔案（节点在线/补录无离线证据），请改用 accident 场景");
      claimNo = c.no;
      console.log(`    未进入倒置分支，改用赔案 ${claimNo} 演示普通证据上传`);
    }
  } else {
    const r = await req("POST", "/api/claim/manual", { nodeId: "aegis-node-01", product: "DOWNTIME" });
    claimNo = r.claim.no;
    console.log(`[0] 人工报案 ${claimNo} · 必要单证 ${JSON.stringify(r.claim.evRequired)}`);
  }

  const list = SC === "accident" ? [DOC.accident, DOC.ops, DOC.bill]
    : SC === "maintenance" ? [DOC.accident, DOC.maintenance]
      : [DOC.selfproof];

  for (const d of list) {
    console.log(`[1] 上传「${d.name}」（${d.kind}）…`);
    const up = await req("POST", "/api/evidence/upload", {
      claimNo, kind: d.kind, name: d.name, dataBase64: b64(d.text), submitter: "投保人 · 节点运营方",
    });
    if (!up.ok) return console.log("    上传失败：", up.error);
    const e = up.evidence;
    console.log(`    证据 ${e.id} · SHA-256 ${e.sha256.slice(0, 32)}… · ${e.size}B`);
    console.log(`    AI 核验：${e.verdict}（${e.score} 分，置信度 ${(e.conf * 100).toFixed(0)}%）`);
    e.checks.forEach(c => log(`${c.ok ? "✓" : "✗"} ${c.k}：${c.d}`));
    console.log(`    仍缺单证：${JSON.stringify(up.missing)}`);
    await wait(SC === "selfproof" ? 500 : 2500);
  }
  await wait(6000);
  const st = await req("GET", "/api/state");
  const c = st.claims.find(x => x.no === claimNo);
  console.log(`[3] 赔案终态：${c.stage} / ${c.decision || "—"}`);
  console.log(`    核赔意见：${c.why || "—"}`);
  if (c.selfProof) console.log(`    自证记录：${c.selfProof}`);
  console.log(`[4] 证据批次：${st.evBatches} 批 · 已锚定 ${st.evidence.filter(x => x.anchor).length} 份`);
  console.log(`[5] 经营指标：赔付率 ${st.metrics.lossRatio}% · 综合成本率 ${st.metrics.combinedRatio}% · 承保利润 ${st.metrics.uwProfit}`);
  if (SC === "selfproof") {
    await new Promise((res) => {
      const r = http.request("http://127.0.0.1:8787/admin/revive", { method: "POST" }, () => res());
      r.on("error", () => res()); r.end();
    });
    console.log("    已恢复被保节点");
  }
  console.log("");
})();
