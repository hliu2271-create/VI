/**
 * 理赔引擎自测 · 验证吸收自「理赔核定智能体」的四项机制
 *   node scripts/engine-demo.js stp         # 双轨：直通件（参数化 + 自有监控）
 *   node scripts/engine-demo.js exclusion   # 除外条款：举证齐备 → 拒赔
 *   node scripts/engine-demo.js unproven    # 除外条款：举证不足 → 仍须赔付 + 第三方追偿
 *   node scripts/engine-demo.js all
 */
const http = require("http");
const API = "http://127.0.0.1:8788";
const SC = process.argv[2] || "all";
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function req(method, path, body) {
  return new Promise((res, rej) => {
    const d = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(API + path, {
      method, headers: { "Content-Type": "application/json", ...(d ? { "Content-Length": d.length } : {}) },
    }, x => { let b = ""; x.on("data", c => b += c); x.on("end", () => { try { res(JSON.parse(b)); } catch (e) { res(b); } }); });
    r.on("error", rej); if (d) r.write(d); r.end();
  });
}
const state = () => req("GET", "/api/state");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const money = (n) => Math.round(n).toLocaleString("en-US");

const DOC = {
  heartbeat: { kind: "HEARTBEAT_LOG", name: "node-heartbeat.log", text: [
    "# node heartbeat log · aegis-node-01",
    "09:12:03 heartbeat ok seq=10224 latency=42ms hashrate=98.4TH/s",
    "09:26:11 heartbeat lost seq=10226 error=connection timeout",
    "09:41:02 heartbeat lost seq=10231 error=upstream unreachable",
    "12:50:02 heartbeat ok seq=10240 latency=51ms",
    "# incident: node down 3.4h, heartbeat lost 7 times"].join("\n") },
  ops: { kind: "OPS_TICKET", name: "ops-ticket-8821.txt", text: [
    "# ops ticket #8821 · 主网算力节点 A01 故障处置报告",
    "09:26 告警触发：心跳连续丢失，error=connection timeout，节点 offline",
    "09:31 运维介入：GPU 驱动 OOM，重启容器并切换备用链路",
    "12:50 恢复：节点 online，hashrate 恢复至 97.9TH/s",
    "# 结论：非计划性停机，属突发故障，事故持续 3.4h"].join("\n") },
  maintenance: { kind: "OPS_TICKET", name: "ops-ticket-9002.txt", text: [
    "# ops ticket #9002 · GPU 集群例行维护",
    "window: scheduled maintenance window, 计划内维护，已提前 72h 公告",
    "# node down 2.0h during maintenance window, heartbeat suspended by operator"].join("\n") },
  upstream: { kind: "HEARTBEAT_LOG", name: "node-heartbeat-idc.log", text: [
    "# node heartbeat log · aegis-node-01",
    "09:26:11 heartbeat lost seq=10226 error=connection timeout",
    "09:27:11 上游机房骨干网故障，可用区整体中断，运营商公告 region down",
    "12:50:02 heartbeat ok seq=10240",
    "# incident: node down 3.4h, 非节点自身故障"].join("\n") },
};

async function upload(claimNo, d) {
  return req("POST", "/api/evidence/upload", { claimNo, kind: d.kind, name: d.name, dataBase64: b64(d.text), submitter: "投保人" });
}
function showClaim(tag, c) {
  console.log(`  [${tag}] ${c.no} · track=${c.track} · ${c.stage} / ${c.decision || "—"}`);
  if (c.claimed) console.log(`      申报 ${money(c.claimed)} → 核减 ${money(c.cut)}（核减率 ${(c.cut / c.claimed * 100).toFixed(0)}%）→ 核定 ${money(c.loss)} → 应付 ${money(c.payable)}`);
  if (c.causation != null) console.log(`      因果强度 ${c.causation} · 理赔费用(LAE) ${c.lae} BOT`);
  if (c.items) c.items.forEach(i => console.log(`        ${i.id} ${i.name}：申报 ${money(i.claimed)} → 比价 ${money(i.priced)} × 因果 ${(i.causation * 100).toFixed(0)}% = ${money(i.adj)}`));
  if (c.adjuster) console.log(`      第三方定损：${c.adjuster.name}（${c.adjuster.operator.slice(0, 12)}…）`);
  if (c.exclusions && c.exclusions.length) c.exclusions.forEach(e =>
    console.log(`      除外 ${e.code}「${e.name}」→ ${e.outcome === "EXCLUSION_APPLIED" ? "除外成立（举证齐备）" : "举证不足，除外不成立"}`));
  if (c.thirdPartyClaim) console.log(`      第三方追偿：${c.thirdPartyClaim.code} → ${money(c.thirdPartyClaim.amount)} BOT`);
  console.log(`      核赔意见：${c.why || "—"}`);
}

(async () => {
  const doStp = SC === "stp" || SC === "all";
  const doEx = SC === "exclusion" || SC === "all";
  const doUn = SC === "unproven" || SC === "all";

  await req("POST", "/api/reset", {});
  console.log("\n=========== 理赔引擎自测 ===========");

  if (doStp) {
    console.log("\n--- 场景 1：双轨 · 直通件（STP）---");
    await req("POST", "/api/attack", {});          // 打挂真实节点 → 保险人自主报案
    let c = null;
    for (let i = 0; i < 14; i++) {
      await wait(1500);
      const s = await state();
      c = s.claims.find(x => x.src === "AUTO" || x.src === "BACKFILL");
      if (c && c.stage === "CLOSED") break;
    }
    if (c) showClaim("STP", c); else console.log("  未产生自主报案赔案（节点可能未宕机）");
  }

  if (doEx) {
    console.log("\n--- 场景 2：除外条款 · 举证齐备 → 拒赔 ---");
    const m = await req("POST", "/api/claim/manual", { nodeId: "aegis-node-01", product: "DOWNTIME" });
    const no = m.claim.no;
    await upload(no, DOC.heartbeat);
    const up = await upload(no, DOC.maintenance);
    console.log(`  证据 ${up.evidence.id} 核验：${up.evidence.verdict}（${up.evidence.score} 分）`);
    await wait(6000);
    const s = await state();
    showClaim("EXCLUSION", s.claims.find(x => x.no === no));
  }

  if (doUn) {
    console.log("\n--- 场景 3：除外条款 · 举证不足 → 仍须赔付 + 第三方追偿 ---");
    const m = await req("POST", "/api/claim/manual", { nodeId: "aegis-node-01", product: "DOWNTIME" });
    const no = m.claim.no;
    const up = await upload(no, DOC.upstream);     // 命中 EX-03 上游故障，但 requires 云账单未提交
    console.log(`  证据 ${up.evidence.id} 核验：${up.evidence.verdict}（${up.evidence.score} 分）`);
    await upload(no, DOC.ops);
    await wait(12000);
    const s = await state();
    showClaim("UNPROVEN", s.claims.find(x => x.no === no));
  }

  const s = await state();
  const m = s.metrics;
  console.log("\n--- 经营指标 ---");
  console.log(`  赔付率 ${m.lossRatio}% · 费用率 ${m.expenseRatio}%（含 LAE ${m.lae} BOT / ${m.laeRatio}%）· 综合成本率 ${m.combinedRatio}%`);
  console.log(`  直通率 ${m.stpRate}% · 定损核减率 ${m.cutRate}% · 承保利润 ${money(m.uwProfit)}（${m.margin}%）`);
  console.log(m.combinedRatio < 100 ? "  ✅ 仍保持承保盈利" : "  ❌ 承保亏损，需调参");
  console.log("");
})();
