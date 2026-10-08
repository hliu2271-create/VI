/**
 * Aegis 神盾 · 保险核心系统（Policy & Claims Core）
 * ------------------------------------------------------------
 * 现实保险全流程：核保 → 出单 → 监控 → 报案(FNOL) → 查勘 → 定损理算
 *              → 核赔(含反欺诈) → 支付 → 代位追偿 → 结案
 *
 * 盈利模型（精算口径）：
 *   保费 = 期望净损失 ÷ (1 − 费用率 − 目标利润率) × 风险边际
 *   毛赔款 → 比例再保险分出 30% → 自留净赔款 → 代位追偿 70% → 最终净损失
 *   赔付率 = 自留净赔款 / 已赚保费；综合成本率 = 赔付率 + 费用率（目标 < 90%）
 *   风控：单一节点赔付率 > 110% 自动停售，出险后续保费率上调
 *
 * AI Agent 自主研判：每环节输出 决策 + 置信度 + 推理链 + 证据
 * 自动闭环：Agent 持续监控真实节点，自主完成从出险到追偿
 *
 * 启动： node server/insurer.js   （http://127.0.0.1:8788）
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const handleModelRoutes = require("./model-assist").createModelRoutes();
const { getVerification, readReport } = require("./verification");

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = process.env.PORT || 8788;
const NODE_SRV = process.env.NODE_SRV || "http://127.0.0.1:8787";

/* ============ 精算假设 ============
 * 单一事实来源 server/pricing.js：可行性压测、组合蒙特卡洛、财务测算脚本
 * 全部 require 同一份定价代码，避免「脚本里复制一份公式」导致的结论漂移。 */
const PRICING = require("./pricing.js");
const ACT = PRICING.ACT;
/* ---- 除外责任条款库 ----
 * 保险法原则：保险人主张除外，举证责任在保险人；举证不足的，除外不成立，仍须赔付。
 * 因此每条条款都带 requires（举证要件），命中条款但拿不出要件 → 只能照赔，且记合规风险。
 */
const EXCLUSIONS = {
  'EX-01': { name: "计划内维护 / 例行停机", requires: ["OPS_TICKET"], kw: /计划内|planned|scheduled|维护窗口|例行维护/i },
  'EX-02': { name: "投保前已披露且未修复的已知故障", requires: ["AUDIT_REPORT"], kw: /已知.{0,6}未修复|known issue|遗留故障|历史缺陷/i },
  'EX-03': { name: "上游基础设施整体故障（非节点自身）", requires: ["CLOUD_BILL"], kw: /上游|机房|运营商|region.{0,4}down|可用区故障|骨干网/i, thirdParty: true },
  'EX-04': { name: "被保人故意行为或重大过失", requires: ["AUDIT_REPORT"], kw: /人为|误操作|违规操作|自伤|擅自/i },
  'EX-05': { name: "不可抗力 / 战争 / 政府行为", requires: ["AUDIT_REPORT"], kw: /不可抗力|地震|洪水|断电限电|政府|force majeure|战争/i },
};
/* 第三方定损机构登记表（职责分离：定损出金额，核赔无权改，争议提请独立复核） */
const ADJUSTERS = {
  'ADJ-01': { name: "第三方算力损失评估机构", license: "保险公估机构备案 · 信息安全服务资质", role: "定损", operator: "0x7A2f9C4E6b18D205e7B3c8A1f04D6E92A15C41d" },
  'ADJ-02': { name: "独立保险公估（复核）", license: "保险公估机构备案", role: "复核", operator: "0x4E8812B7a90C35f6D4e1A8b27C096E53F219b7" },
};
/* 双轨理赔：直通式(STP) 走决策引擎秒核定；复杂件走 8 步编排 */
const ORCH_PLAN = [
  { id: "gateway", name: "事件接入与校验", svc: "event.gateway", ms: 220 },
  { id: "dedupe", name: "幂等去重", svc: "idempotency.store", ms: 120 },
  { id: "evidence", name: "取证与存证固化", svc: "evidence.vault", ms: 420 },
  { id: "mitigate", name: "减损指令下发", svc: "mitigation.ops", ms: 300 },
  { id: "assess", name: "事件评估", svc: "incident.assess", ms: 520 },
  { id: "adjust", name: "第三方定损", svc: "loss.adjust", ms: 780 },
  { id: "pricing", name: "保单规则引擎", svc: "policy.engine", ms: 260 },
  { id: "payout", name: "赔付执行", svc: "payout.core", ms: 380 },
];
const STP = { maxNet: 12000, minCausation: .8, maxFraud: 35 };   // 直通式准入门槛

const PRODUCTS = PRICING.PRODUCTS;

/* 双轨准入：参数化险种 + 保险人自有监控数据 + 非盲区 → 直通式处理（STP）
   直通件单均理赔费用约为编排件的 1/8，是压低综合成本率的关键抓手 */
function stpEligible(c) {
  return !c.blind && c.src !== "MANUAL" && c.src !== "BLIND" && c.product !== "HASHRATE";
}
function hasPassedDoc(c, kind) {
  return DB.evidence.some(e => e.claimNo === c.no && e.kind === kind && (e.verdict === "ACCEPTED" || e.verdict === "ACCEPTED_WITH_RESERVE"));
}

/* ============ 工具 ============ */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
const R2 = (n) => Math.round(n * 100) / 100;
const money = (n) => Math.round(n);
function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }
function id(pre) { return pre + "-" + Math.random().toString(36).slice(2, 7).toUpperCase(); }
function nowISO() { return new Date().toISOString().slice(11, 19); }

/* ============ 数据 ============ */
const DB = {
  nodes: [], policies: [], claims: [],
  pool: { capital: 500000, written: 0, earned: 0, expenses: 0, lae: 0, gross: 0, ceded: 0, netClaims: 0, recovered: 0, reserve: 0 },
  ledger: [], audit: [], ai: [], evidence: [], evSeq: 0,
  auto: true, seq: { policy: 2400, claim: 800 },
  nodeFails: 0, nodeUp: true,
};

/* DRY（干跑）标志：智能体实验室调用全链路推演时置位。
   置位期间不调度任何异步定时器、不落盘证据原文，结束后整库回滚快照 —— 实验室只推演，不污染经营账。 */
let DRY = false;

function audit(type, msg, ref) {
  const prev = DB.audit.length ? DB.audit[DB.audit.length - 1].hash : "0".repeat(8);
  const e = { i: DB.audit.length + 1, t: nowISO(), type, msg, ref: ref || "", prev: prev.slice(0, 6) };
  e.hash = hash(prev + JSON.stringify(e));
  DB.audit.push(e);
  if (DB.audit.length > 200) DB.audit.shift();
}
function ledger(dr, cr, amt, memo) {
  DB.ledger.unshift({ t: nowISO(), dr, cr, amt: money(amt), memo });
  if (DB.ledger.length > 2000) DB.ledger.pop();     // 上限放宽：保费记录不得被赔款流水挤出（否则走势图假性亏损）
}

/* 全量记账累计曲线（图表专用）：与统计条同一本账，杜绝「最近流水窗口」造成的假性亏损 */
function ledgerSeries() {
  const rows = DB.ledger.slice().reverse();          // ledger 最新在前 → 转时间正序
  const s = { n: rows.length, prem: [], pay: [], rec: [], premT: 0, payT: 0, recT: 0 };
  let a = 0, b = 0, c = 0;
  for (const l of rows) {
    if (l.cr === "保费收入") a += l.amt;
    if (l.dr === "赔款支出" || l.cr === "赔款支出") b += l.amt;   // 记账口径即自留净额（再保分出后）
    if (l.cr === "追偿收入") c += l.amt;
    s.prem.push(money(a)); s.pay.push(money(b)); s.rec.push(money(c));
  }
  s.premT = money(a); s.payT = money(b); s.recT = money(c);
  return s;
}
function aiLog(agent, decision, confidence, reasoning, evidence, claimNo) {
  const rec = { t: nowISO(), agent, decision, confidence: R2(confidence), reasoning, evidence, claimNo: claimNo || "" };
  DB.ai.unshift(rec);
  if (DB.ai.length > 60) DB.ai.pop();
  return rec;
}

/* ============ 证据中心（Evidence Vault） ============
 * 入口：投保人 / 节点运营方在报案后上传单证（运维日志、工单、账单、截图、在线自证）
 * 流程：落盘 → SHA-256 指纹 → AI 证据核验 Agent 打分 → 影响定损/核赔 → 批量 Merkle 锚定上链
 * 铁律：原文不出域，链上只存哈希；单证不全可拒赔，重复指纹/计划内维护直接命中除外责任
 */
const MAX_UPLOAD = 4 * 1024 * 1024;
const EV_KINDS = {
  HEARTBEAT_LOG: { name: "心跳/监控日志", req: true, text: true, exts: "log txt json csv", w: .30, desc: "证明事故发生与持续时长" },
  OPS_TICKET:    { name: "运维工单/事故报告", req: true, text: true, exts: "log txt md pdf", w: .25, desc: "证明事故原因与处置过程" },
  CLOUD_BILL:    { name: "云厂商账单/算力对账单", req: false, text: true, exts: "csv json txt pdf", w: .15, desc: "量化算力/收入损失" },
  SCREENSHOT:    { name: "监控截图", req: false, text: false, exts: "png jpg jpeg webp", w: .12, desc: "辅助佐证（仅元数据核验）" },
  CHAIN_PROOF:   { name: "链上凭证(tx)", req: false, text: true, exts: "txt json", w: .10, desc: "链上心跳/SLA 锚定凭证" },
  SELF_PROOF:    { name: "在线自证材料", req: false, text: true, exts: "log txt json png jpg", w: .20, desc: "盲区举证责任倒置下节点自证在线" },
  AUDIT_REPORT:  { name: "第三方审计报告", req: false, text: true, exts: "pdf txt md", w: .08, desc: "独立第三方核验" },
};
const EV_BATCH = { items: [], seq: 0, timer: null };

function extOf(name) { return (path.extname(name || "").replace(".", "") || "").toLowerCase(); }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function merkle(hashes) {
  let lvl = hashes.slice(); if (!lvl.length) return "";
  while (lvl.length > 1) {
    const nx = [];
    for (let i = 0; i < lvl.length; i += 2) nx.push(i + 1 < lvl.length ? sha256(Buffer.from(lvl[i] + lvl[i + 1])) : lvl[i]);
    lvl = nx;
  }
  return lvl[0];
}
/* 文本取证：抽取事故时长 / 是否计划内维护 / 是否在线自证 */
function scanText(t) {
  const s = (t || "").slice(0, 200000);
  const planned = /(?<!非)计划内|planned\s+maintenance|scheduled\s+maintenance|维护窗口|例行维护/i.test(s);
  const selfOn = /在线|online|uptime|status\s*[:=]\s*ok|heartbeat\s*[:=]\s*ok|200\s*OK/i.test(s);
  const m = s.match(/(?:down|offline|宕机|离线|中断)[^\d\n]{0,8}(\d+(?:\.\d+)?)\s*(h|小时|min|分钟|m)?/i);
  let hours = null;
  if (m) { hours = parseFloat(m[1]); if (/min|分钟/.test(m[2] || "")) hours = hours / 60; }
  return {
    planned, selfOn, hours, raw: s.slice(0, 4000),            // 留存可检索原文（供除外条款命中比对）
    hb: (s.match(/heartbeat|心跳/gi) || []).length,
    err: (s.match(/error|timeout|故障|失败|OOM|offline|宕机|停机|outage|中断/gi) || []).length,
    len: s.length,
  };
}

function addEvidence(o) {
  const c = o.claimNo ? DB.claims.find(x => x.no === o.claimNo) : null;
  const meta = EV_KINDS[o.kind] || EV_KINDS.SCREENSHOT;
  const buf = o.buf || Buffer.from(o.text == null ? "" : String(o.text), "utf8");
  const h = sha256(buf);
  const fname = `${h.slice(0, 16)}-${(o.name || "evidence").replace(/[^\w.\-]/g, "_").slice(0, 48)}`;
  if (!DRY) fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);   // 干跑：原文不落盘
  const ev = {
    id: "EV" + String(DB.evSeq = (DB.evSeq || 0) + 1).padStart(4, "0"),
    claimNo: o.claimNo || "", nodeId: o.nodeId || (c ? c.nodeId : ""), kind: o.kind, kindName: meta.name,
    name: o.name || fname, size: buf.length, ext: extOf(o.name), sha256: h, url: "/uploads/" + fname,
    at: Date.now(), t: nowISO(), submitter: o.submitter || "投保人",
    verdict: "PENDING", score: 0, conf: 0, checks: [],
    scan: o.text != null ? scanText(String(o.text)) : null, anchor: null,
  };
  DB.evidence.unshift(ev);
  if (DB.evidence.length > 200) DB.evidence.pop();
  return ev;
}

/* ---- AI 证据核验 Agent：真实性 / 完整性 / 唯一性 / 时效 / 相关性 / 交叉验证 ---- */
function verifyEvidence(ev, c) {
  const meta = EV_KINDS[ev.kind] || EV_KINDS.SCREENSHOT;
  const checks = [];
  const dup = DB.evidence.filter(e => e.sha256 === ev.sha256 && e.id !== ev.id);

  const extOk = meta.exts.split(" ").indexOf(ev.ext) >= 0;
  checks.push({ k: "格式校验", ok: extOk, d: extOk ? `.${ev.ext} 属「${meta.name}」允许格式` : `格式 .${ev.ext || "?"} 不在白名单（${meta.exts}）`, w: .12 });
  checks.push({ k: "完整性", ok: ev.size > 0, d: `SHA-256 ${ev.sha256.slice(0, 16)}… · ${(ev.size / 1024).toFixed(1)}KB 已完整落盘`, w: .12 });
  checks.push({ k: "指纹唯一性", ok: dup.length === 0, d: dup.length ? `与证据 ${dup[0].id} 指纹相同，重复举证嫌疑` : "证据库内无相同指纹，非重复提交", w: .18 });

  let timely = true, td = "无关联赔案，按通用时效校验通过";
  if (c) { const gap = (ev.at - (c.ts || ev.at)) / 3600000; timely = gap <= 72; td = `距报案 ${gap.toFixed(1)}h（条款：单证须 72h 内提交）`; }
  checks.push({ k: "提交时效", ok: timely, d: td, w: .12 });

  let rel = .5, rd = "非文本证据，仅做元数据与指纹核验，证明力有限";
  if (meta.text) {
    let sc = ev.scan;
    if (!sc) { let txt = ""; try { txt = fs.readFileSync(path.join(UPLOAD_DIR, path.basename(ev.url)), "utf8"); } catch (e) { } sc = scanText(txt); ev.scan = sc; }
    if (ev.kind === "SELF_PROOF") {
      // 自证材料：相关性的判据是「能否证明在线」，而非事故关键词
      rel = sc.selfOn ? .85 + Math.min(.15, (sc.hb + sc.err) / 40) : .25;
      rd = `自证材料解析：${sc.selfOn ? "检出在线/uptime/200 OK 记录，具备自证效力" : "未检出在线记录，不足以推翻不利推定"} · 心跳样本 ${sc.hb} 处`;
    } else {
      const hit = Math.min(1, (sc.hb + sc.err) / 12);
      rel = .35 + hit * .65;
      rd = `文本解析：心跳/故障关键词命中 ${sc.hb + sc.err} 处` +
        (sc.hours != null ? ` · 可提取时长 ${sc.hours}h` : "") +
        (sc.planned ? " · ⚠ 检出「计划内维护」字样" : "") + (sc.selfOn ? " · 检出「在线/uptime」字样" : "");
    }
  }
  checks.push({ k: "内容相关性", ok: rel >= .5, d: rd, w: .28 });

  let cross = true, cd = "无保险人侧监控数据可比，属单方证据，证明力下调";
  if (c && c.hours) {
    const ph = ev.scan && ev.scan.hours;
    if (ph != null) { const diff = Math.abs(ph - c.hours) / Math.max(1, c.hours); cross = diff <= .4; cd = `证据时长 ${ph}h vs 监控核定 ${c.hours}h，偏差 ${(diff * 100).toFixed(0)}%（阈值 40%）`; }
    else cd = `监控核定 ${c.hours}h，证据未载明时长，以保险人监控口径为准`;
  } else if (c) cd = "赔案尚未定损，暂不做时长交叉验证";
  checks.push({ k: "交叉验证", ok: cross, d: cd, w: .18 });

  let acc = 0, ws = 0;
  checks.forEach(ch => { acc += (ch.k === "内容相关性" ? rel : (ch.ok ? 1 : 0)) * ch.w; ws += ch.w; });
  const score = Math.round(acc / ws * 100);
  let verdict = score >= 78 ? "ACCEPTED" : (score >= 55 ? "ACCEPTED_WITH_RESERVE" : "REJECTED");
  if (rel < .5 && verdict === "ACCEPTED") verdict = "ACCEPTED_WITH_RESERVE";           // 相关性不足 → 证明力有限
  if (dup.length) verdict = "REJECTED";                                             // 重复指纹一票否决
  if (ev.scan && ev.scan.planned && (ev.kind === "OPS_TICKET" || ev.kind === "HEARTBEAT_LOG")) verdict = "EXCLUDED"; // 计划内维护 = 除外责任

  ev.score = score;
  ev.verdict = verdict;
  ev.checks = checks;
  ev.conf = R2(verdict === "ACCEPTED" ? .88 + score / 1000 : (verdict === "REJECTED" || verdict === "EXCLUDED" ? .9 : .72));

  const vTxt = { ACCEPTED: "证据采纳", ACCEPTED_WITH_RESERVE: "保留采纳（证明力有限）", REJECTED: "证据驳回（需补证）", EXCLUDED: "命中除外责任" }[verdict];
  aiLog("证据核验Agent", `${verdict} ${score}分`, ev.conf, [
    { s: "指纹与完整性", d: `SHA-256 ${ev.sha256.slice(0, 24)}… · ${(ev.size / 1024).toFixed(1)}KB · 落盘存证`, w: .25 },
    { s: "六维核验", d: checks.map(x => `${x.k}${x.ok ? "✓" : "✗"}`).join(" / "), w: .35 },
    { s: "核验结论", d: `${vTxt}：${rd}`, w: .25 },
    { s: "处置", d: verdict === "EXCLUDED" ? "检出计划内维护，属保单除外责任，本单不予赔付" : (verdict === "REJECTED" ? "不计入证据链，通知补证" : "计入证据链，参与定损与核赔决策"), w: .15 },
  ], [{ k: "evidence.id", v: ev.id }, { k: "kind", v: meta.name }, { k: "sha256", v: ev.sha256.slice(0, 16) + "…" }, { k: "score", v: score }], ev.claimNo);
  audit("EVIDENCE", `证据 ${ev.id}「${meta.name}」${vTxt}（${score} 分）· ${ev.name}`, ev.claimNo);
  return ev;
}

/* ---- 证据对理赔决策的传导 ---- */
function requiredFor(c) {
  // 保险人自主报案：自有监控数据已构成完整证据；人工报案：单证由投保人提供
  return c && c.src === "MANUAL" ? ["HEARTBEAT_LOG", "OPS_TICKET"] : [];
}
function docsOf(c) {
  return DB.evidence.filter(e => e.claimNo === c.no && (e.verdict === "ACCEPTED" || e.verdict === "ACCEPTED_WITH_RESERVE"));
}
function missingDocs(c) {
  const req = requiredFor(c); if (!req.length) return [];
  const got = new Set(docsOf(c).map(e => e.kind));
  return req.filter(k => !got.has(k));
}
const CLAIM_TIMERS = {};   // 挂起计时器（不放进赔案对象，避免序列化循环引用）
function releaseReserve(c) {
  if (c.reserved > 0) {
    DB.pool.reserve = Math.max(0, DB.pool.reserve - c.reserved);
    ledger("赔款支出", "未决赔款准备金", c.reserved, `赔案 ${c.no} 冲回准备金`);
    c.reserved = 0;
  }
}
function applyEvidence(ev, c) {
  queueAnchor(ev);
  if (!c) return;
  c.evList = (c.evList || []).concat(ev.id);
  c.evScore = ev.score;

  // ① 盲区自证：节点在窗口内提交有效在线证据 → 推翻不利推定，撤销立案
  if (ev.kind === "SELF_PROOF" && c.pendingSelfProof && (ev.verdict === "ACCEPTED" || ev.verdict === "ACCEPTED_WITH_RESERVE") && ev.scan && ev.scan.selfOn) {
    c.pendingSelfProof = false;
    c.selfProof = `节点 ${ev.t} 提交《在线自证材料》（${ev.name}），AI 核验 ${ev.score} 分通过 → 不利推定被推翻`;
    c.decision = "DECLINED"; c.why = `节点已提交有效在线自证证据（指纹 ${ev.sha256.slice(0, 12)}…），撤销立案`;
    c.stage = "CLOSED"; c.stageIdx = 6;
    releaseReserve(c);
    audit("SELF_PROOF_OK", `赔案 ${c.no} 自证成立 → 撤销立案，冲回准备金`, c.no);
    aiLog("证据核验Agent", "SELF_PROOF_ACCEPTED", ev.conf,
      [{ s: "自证核验", d: `材料含在线/uptime 记录，指纹唯一且与监控侧时序不冲突，核验 ${ev.score} 分`, w: .5 },
       { s: "法律效果", d: "举证责任倒置下保险人已尽提示义务，节点完成自证 → 不利推定不成立，撤销立案且不计入赔付率", w: .5 }],
      [{ k: "sha256", v: ev.sha256.slice(0, 16) + "…" }, { k: "reserve", v: "冲回" }], c.no);
    return;
  }
  // ② 命中除外责任
  if (ev.verdict === "EXCLUDED") {
    const code = Object.keys(EXCLUSIONS).find(k => EXCLUSIONS[k].kw.test((ev.scan && ev.scan.raw) || "")) || "EX-01";
    c.excludedBy = code;
    c.excluded = `保单除外责任 ${code}「${EXCLUSIONS[code].name}」（依据 ${ev.name}）`;
    audit("EXCLUSION", `赔案 ${c.no} 检出除外事由 ${code}`, c.no);
  }
  // ③ 补证解除挂起 → 重新核赔
  if (c.evHold && !missingDocs(c).length) {
    clearTimeout(CLAIM_TIMERS[c.no]); CLAIM_TIMERS[c.no] = null;
    c.evHold = false;
    audit("DOCS_OK", `赔案 ${c.no} 必要单证齐全 → 恢复核赔流程`, c.no);
    aiLog("单证Agent", "DOCS_COMPLETE", .92,
      [{ s: "单证齐备", d: `已收齐 ${requiredFor(c).map(k => EV_KINDS[k].name).join("、")}，恢复核赔`, w: 1 }],
      docsOf(c).map(e => ({ k: e.kindName, v: e.score + "分" })), c.no);
    setTimeout(() => adjudicate(c), 700);
  }
}
function queueAnchor(ev) {
  EV_BATCH.items.push(ev);
  if (EV_BATCH.items.length >= 3) flushAnchor();
  else if (!EV_BATCH.timer) EV_BATCH.timer = setTimeout(flushAnchor, 45000);
}
function flushAnchor() {
  const items = EV_BATCH.items; if (!items.length) return;
  EV_BATCH.items = []; clearTimeout(EV_BATCH.timer); EV_BATCH.timer = null;
  const root = merkle(items.map(e => e.sha256));
  const tx = "0x" + sha256(Buffer.from(root + Date.now())).slice(0, 40);
  const batch = "BA" + String(++EV_BATCH.seq).padStart(3, "0");
  items.forEach(e => { e.anchor = { batch, root: root.slice(0, 16), tx }; });
  audit("EVIDENCE_ANCHOR", `证据批次 ${batch} 锚定：${items.length} 份 · Merkle Root ${root.slice(0, 16)}… · tx ${tx.slice(0, 12)}…`, batch);
  aiLog("证据存证Agent", "BATCH_ANCHORED", .99, [
    { s: "指纹化", d: `${items.length} 份证据逐一 SHA-256，构造 Merkle 树`, w: .4 },
    { s: "链上锚定", d: `Root 写入 BOT Chain（tx ${tx.slice(0, 14)}…），原文不出域，兼顾取证与隐私`, w: .35 },
    { s: "法律效力", d: "任一证据被篡改即与链上 Root 不符，可作为电子数据举证", w: .25 },
  ], [{ k: "batch", v: batch }, { k: "merkleRoot", v: root.slice(0, 16) + "…" }, { k: "tx", v: tx.slice(0, 14) + "…" }], "");
}

/* ============ 被保节点 ============ */
function seedNodes() {
  DB.nodes = [
    { id: "aegis-node-01", name: "主网算力节点 A01", stake: 60000, real: true, up: true, risk: 12, latency: 0, claims12m: 1, avail: 99.6, premium: 0, incNet: 0, suspended: false },
    { id: "gpu-cluster-07", name: "GPU 集群 B07", stake: 45000, real: false, up: true, risk: 34, latency: 120, claims12m: 2, avail: 96.1, premium: 0, incNet: 0, suspended: false },
    { id: "edge-node-12", name: "边缘节点 C12", stake: 18000, real: false, up: true, risk: 58, latency: 260, claims12m: 4, avail: 91.4, premium: 0, incNet: 0, suspended: false },
  ];
}
seedNodes();

/* 存量业务：让组合初具规模（保费基数决定赔付率是否合理） */
function seedBusiness() {
  const seeds = [
    { nodeId: "aegis-node-01", product: "DOWNTIME", sumInsured: 50000, days: 90 },
    { nodeId: "aegis-node-01", product: "LATENCY", sumInsured: 30000, days: 90 },
    { nodeId: "aegis-node-01", product: "DOWNTIME", sumInsured: 40000, days: 180 },
    { nodeId: "aegis-node-01", product: "HASHRATE", sumInsured: 25000, days: 90 },
    { nodeId: "aegis-node-01", product: "DOWNTIME", sumInsured: 60000, days: 365 },
    { nodeId: "gpu-cluster-07", product: "DOWNTIME", sumInsured: 40000, days: 90 },
    { nodeId: "gpu-cluster-07", product: "HASHRATE", sumInsured: 20000, days: 90 },
    { nodeId: "gpu-cluster-07", product: "DOWNTIME", sumInsured: 35000, days: 180 },
    { nodeId: "gpu-cluster-07", product: "LATENCY", sumInsured: 28000, days: 180 },
    { nodeId: "gpu-cluster-07", product: "DOWNTIME", sumInsured: 45000, days: 365 },
    { nodeId: "edge-node-12", product: "DOWNTIME", sumInsured: 15000, days: 90 },
    { nodeId: "edge-node-12", product: "LATENCY", sumInsured: 12000, days: 90 },
    { nodeId: "edge-node-12", product: "DOWNTIME", sumInsured: 10000, days: 180 },
    { nodeId: "edge-node-12", product: "HASHRATE", sumInsured: 8000, days: 90 },
    { nodeId: "edge-node-12", product: "DOWNTIME", sumInsured: 16000, days: 365 },
    { nodeId: "aegis-node-01", product: "LATENCY", sumInsured: 20000, days: 365 },
  ];
  seeds.forEach(s => {
    const node = DB.nodes.find(n => n.id === s.nodeId);
    const q = price(s.nodeId, s.product, s.sumInsured, s.days);
    const p = {
      no: "PL" + (++DB.seq.policy), ...s, premium: q.premium, deductible: q.deductible,
      inception: new Date().toISOString(), status: "IN_FORCE", claimNo: null, conditions: "标准条款 · 战争/不可抗力除外",
    };
    DB.policies.unshift(p);
    DB.pool.written += p.premium;
    DB.pool.earned += p.premium * 0.92;         // 保单已生效较久，已赚比例高（未到期责任 8%）
    DB.pool.reserve += p.premium * 0.30;
    node.premium += p.premium * 0.92;
    ledger("银行存款", "保费收入", p.premium, `保单 ${p.no} 出单`);
  });
  // 历史已结赔案 3 笔（真实组合里总有已发生损失）
  /* 历史赔案的金额必须跟着定价走。
     早先赔款是写死的常数，而保费用实证标定重算后降了约 60% → 种子赔付率飙到 200%+，
     一开局三个节点全部越过 110% 停售红线，演示直接卡死在「买不了保险」。
     这里改为按「目标赔付率」反推赔款，保证种子业务处在健康区间（且按风险分递增）。 */
  const TARGET_LR = { "aegis-node-01": 0.42, "gpu-cluster-07": 0.58, "edge-node-12": 0.72 };
  [
    { nodeId: "gpu-cluster-07", product: "DOWNTIME", hours: 4.5 },
    { nodeId: "edge-node-12", product: "DOWNTIME", hours: 3.2 },
    { nodeId: "aegis-node-01", product: "LATENCY", hours: 2.8 },
  ].forEach(h => {
    const node = DB.nodes.find(n => n.id === h.nodeId);
    const gross = money(Math.max(1, node.premium * (TARGET_LR[h.nodeId] || 0.6) / (1 - ACT.cession)));
    const pol = DB.policies.find(p => p.nodeId === h.nodeId && p.product === h.product) || DB.policies[0];
    const ceded = money(gross * ACT.cession), net = money(gross - ceded), rec = money(net * ACT.recovery);
    const c = {
      no: "CL" + (++DB.seq.claim), policyNo: pol.no, nodeId: h.nodeId, product: h.product,
      reportedAt: nowISO(), stage: "CLOSED", stageIdx: 6, src: "MANUAL", hours: h.hours,
      gross, loss: gross, payable: gross, ceded, net, recovered: rec, netLoss: money(net - rec),
      decision: "APPROVED", fraud: 10, conf: 0.9, why: "历史赔案（已结案）", subrogation: rec,
    };
    DB.claims.unshift(c);
    DB.pool.gross += c.gross; DB.pool.ceded += ceded; DB.pool.netClaims += net; DB.pool.recovered += rec;
    DB.pool.capital -= net; DB.pool.capital += rec;
    const n = DB.nodes.find(x => x.id === h.nodeId); n.incNet += net;
    ledger("赔款支出", "银行存款", net, `历史赔案 ${c.no}（自留）`);
    ledger("银行存款", "追偿收入", rec, `历史赔案 ${c.no} 追偿`);
  });
  DB.pool.expenses = DB.pool.written * ACT.expenseRatio * 0.72;
  audit("SEED", `存量业务载入：${seeds.length} 张有效保单 · 3 笔历史结案赔案`, "");
}

/* ============ 精算定价 ============ */
// 公式本体在 server/pricing.js（纯函数）；这里只做「节点 → 定价入参」的解析。
function price(nodeId, product, sumInsured, days) {
  const node = DB.nodes.find(n => n.id === nodeId);
  return PRICING.priceQuote({
    risk: node ? node.risk : 40,
    nodePremium: node ? node.premium : 0,
    nodeIncNet: node ? node.incNet : 0,
    product, sumInsured, days,
  });
}

/* ---- 停售复核：条件触发，条件消失后自动解除 ----
   停售不是终身监禁。赔付率随续保加费、追偿回收、资本补充而回落后，资质即应恢复；
   解除线比触发线低 10%（滞回），避免临界值反复抖动。 */
function reviewSuspension(node) {
  if (!node || !node.suspended) return false;
  const lr = node.premium > 0 ? node.incNet / node.premium : 0;
  const cleared = lr <= ACT.stopLoss * 0.9 && node.risk < 70;
  if (!cleared) return false;
  node.suspended = false;
  const was = node.suspendReason || "—";
  node.suspendReason = null; node.suspendedAt = null;
  audit("RESUME", `节点 ${node.id} 停售复核通过，恢复承保（赔付率 ${(lr * 100).toFixed(0)}% · 风险分 ${node.risk} · 原由：${was}）`, "");
  return true;
}

/* ============ AI 核保 Agent ============ */
function underwrite(req) {
  const node = DB.nodes.find(n => n.id === req.nodeId);
  const sum = Math.max(0, +req.sumInsured || 0), days = +req.days || 30;
  const prod = PRODUCTS[req.product] || PRODUCTS.DOWNTIME;
  if (!node) return { decision: "DECLINE", premium: 0, deductible: 0, product: prod && req.product, nodeId: req.nodeId, sumInsured: sum, days, conf: 0, freq: 0, reasons: [{ s: "核保结论", d: `未知节点 ${req.nodeId || "(空)"}，拒绝承保`, w: 1 }], ev: [] };
  if (!sum) return { decision: "DECLINE", premium: 0, deductible: 0, product: req.product, nodeId: node.id, sumInsured: 0, days, conf: 0, freq: 0, reasons: [{ s: "核保结论", d: "保额无效，拒绝承保", w: 1 }], ev: [] };
  const pr = price(req.nodeId, req.product, sum, days);
  let deductible = req.deductible == null ? pr.deductible : +req.deductible;
  const reasons = [], ev = [];

  reasons.push({ s: "标的风险评估", d: `节点 ${node.id} 风险分 ${node.risk}，历史可用率 ${node.avail}%，近12月赔案 ${node.claims12m} 次`, w: 0.3 });
  ev.push({ k: "NodeRegistry.riskScore", v: node.risk });

  const concentration = sum / Math.max(1, DB.pool.capital);
  reasons.push({ s: "承保能力校验", d: `保额占资本金 ${(concentration * 100).toFixed(1)}%（红线 20%）`, w: 0.15 });
  ev.push({ k: "RiskPool.capital", v: DB.pool.capital });

  // 精算定价
  reasons.push({
    s: "精算定价",
    d: `年化出险频率 ${pr.freq} 次 × 单次赔付率 ${pr.sev}% → 期望净损失 ${money(pr.expNetLoss)}＋期望理赔费用 ${money(pr.expLae)}（含第三方定损），费率 ${(pr.premium / sum * 100).toFixed(2)}%`,
    w: 0.25,
  });
  reasons.push({
    s: "盈利校验",
    d: `保费 ${money(pr.premium)} 中：赔款 ${money(pr.expNetLoss)}、理赔费用 ${money(pr.expLae)}、费用 ${(ACT.expenseRatio * 100).toFixed(0)}%、目标利润 ${(ACT.profitMargin * 100).toFixed(0)}%、风险边际 ${ACT.riskMargin}× → 综合成本率 ${(((pr.expNetLoss + pr.expLae) / Math.max(1, pr.premium) + ACT.expenseRatio) * 100).toFixed(1)}%`,
    w: 0.15,
  });
  ev.push({ k: "再保险分出", v: (ACT.cession * 100) + "%" }, { k: "代位追偿率", v: (ACT.recovery * 100) + "%" });

  // 节点组合风控：赔付率红线 → 停售
  const nodeLR = node.premium > 0 ? node.incNet / node.premium : 0;
  reviewSuspension(node);                     // 先复核：条件已消失则解除停售
  reasons.push({ s: "组合风控", d: `该节点历史赔付率 ${(nodeLR * 100).toFixed(0)}%（停售红线 ${(ACT.stopLoss * 100).toFixed(0)}%）`, w: 0.2 });
  ev.push({ k: "node.lossRatio", v: (nodeLR * 100).toFixed(0) + "%" });

  /* 停售判定分两层，别混为一谈：
     · 节点级停售（持久）：赔付率破红线 / 风险分超限 —— 这是节点自身资质问题，记入 suspended；
     · 逐单承保能力（不持久）：本单保额占资本金超 20% —— 只拒这一单，保额降下来就能买。
     早先把集中度也算进持久停售，结果资本被几轮压测赔案消耗后三个节点全部永久停售，
     谁也买不了保险、演示彻底卡死。承保能力是逐单约束，不是节点的终身标签。 */
  const overCap = concentration > 0.2;
  const nodeBanned = nodeLR > ACT.stopLoss || node.risk >= 75;
  let decision = "ACCEPT", loading = pr.renewalLoad;
  if (node.suspended || nodeBanned || overCap) {
    decision = "DECLINE";
    if (nodeBanned) {
      node.suspended = true;
      node.suspendReason = nodeLR > ACT.stopLoss
        ? `赔付率 ${(nodeLR * 100).toFixed(0)}% 超红线 ${(ACT.stopLoss * 100).toFixed(0)}%`
        : `风险分 ${node.risk} ≥ 75`;
      node.suspendedAt = nowISO();
    }
    reasons.push({
      s: "核保结论",
      d: nodeBanned ? `触发节点级停售：${node.suspendReason}`
        : `本单超出承保能力（保额占资本金 ${(concentration * 100).toFixed(1)}%，红线 20%）—— 降低保额或待资本金补充后可再投保`,
      w: 0.3,
    });
  } else if (node.risk >= 45 || nodeLR > 0.8) {
    decision = "ACCEPT_WITH_LOADING";
    loading = R2(Math.max(1.15, pr.renewalLoad));
    pr.premium = R2(pr.premium * loading / Math.max(1, pr.renewalLoad) * loading);
    deductible = Math.max(deductible, sum * 0.03);
    reasons.push({ s: "核保结论", d: `加费承保：加费系数 ${loading}×，免赔额上调至保额 3%`, w: 0.3 });
  } else {
    reasons.push({ s: "核保结论", d: "标准体承保，适用精算费率", w: 0.3 });
  }
  const conf = R2(0.84 + Math.min(0.12, reasons.length * 0.02));
  aiLog("核保Agent", decision, conf, reasons, ev, "");
  audit("UNDERWRITE", `${decision} · ${node.id} · 保额 ${sum} · 保费 ${pr.premium}`, "");
  return { decision, premium: pr.premium, loading, deductible: R2(deductible), product: req.product, nodeId: req.nodeId, sumInsured: sum, days, conf, freq: pr.freq,
    expNetLoss: pr.expNetLoss, expLae: pr.expLae, expCombined: R2(((pr.expNetLoss + pr.expLae) / Math.max(1, pr.premium) + ACT.expenseRatio) * 100),
    reasons, ev, nodeRisk: node.risk, nodeAvail: node.avail, nodeClaims12m: node.claims12m,
    cession: ACT.cession, recovery: ACT.recovery,
    targetCombined: R2(((1 - ACT.expenseRatio - ACT.profitMargin) / ACT.riskMargin + ACT.expenseRatio) * 100),
  };
}

function issuePolicy(q) {
  const p = {
    no: "PL" + (++DB.seq.policy), nodeId: q.nodeId, product: q.product,
    sumInsured: q.sumInsured, premium: q.premium, deductible: q.deductible, days: q.days,
    inception: new Date().toISOString(), status: "IN_FORCE", claimNo: null,
    conditions: q.decision === "ACCEPT_WITH_LOADING" ? "加费承保 · 免赔额上调 · 计划内维护除外" : "标准条款 · 战争/不可抗力除外",
  };
  DB.policies.unshift(p);
  DB.pool.written += p.premium; DB.pool.earned += p.premium * 0.5; DB.pool.reserve += p.premium * 0.3;
  const n = DB.nodes.find(x => x.id === p.nodeId); n.premium += p.premium * 0.5;
  ledger("银行存款", "保费收入", p.premium, `保单 ${p.no} 出单`);
  audit("POLICY_ISSUED", `保单 ${p.no} 生效 · 保额 ${p.sumInsured} · 保费 ${p.premium}`, p.no);
  return p;
}

/* ============ 报案（FNOL） ============ */
function reportClaim(nodeId, product, evidence, src) {
  const pol = DB.policies.find(p => p.nodeId === nodeId && p.status === "IN_FORCE" && p.product === product)
    || DB.policies.find(p => p.nodeId === nodeId && p.status === "IN_FORCE");
  const c = {
    no: "CL" + (++DB.seq.claim), policyNo: pol ? pol.no : "—", nodeId, product,
    reportedAt: nowISO(), ts: Date.now(), stage: "REPORTED", stageIdx: 0, src: src || "AUTO",
    stages: ["REPORTED", "INVESTIGATING", "ADJUSTED", "ADJUDICATED", "PAID", "RECOVERED"],
    evidence: evidence || [], evList: [], gross: 0, loss: 0, payable: 0, ceded: 0, net: 0, recovered: 0, netLoss: 0,
    fraud: 0, decision: "", conf: 0, why: "", subrogation: 0, reserved: 0,
    delayMin: src === "AUTO" ? 1 : Math.floor(Math.random() * 300 + 5),
  };
  DB.claims.unshift(c);
  if (pol) { pol.claimNo = c.no; pol.status = "CLAIMED"; }
  c.reserved = money((pol ? pol.sumInsured : 10000) * 0.08);
  DB.pool.reserve += c.reserved;
  ledger("未决赔款准备金", "赔款支出", c.reserved, `赔案 ${c.no} 立案提取准备金`);
  audit("FNOL", `赔案 ${c.no} 报案 · ${nodeId} · ${PRODUCTS[product].name} · 来源 ${c.src}`, c.no);

  // 双轨分流：可自动核定的参数化赔案走 STP 直通（决策引擎秒核定），其余走 8 步编排
  c.track = stpEligible(c) ? "STP" : "ORCHESTRATED";
  c.orch = c.track === "STP" ? null : ORCH_PLAN.map((s, i) => ({ id: s.id, name: s.name, svc: s.svc, ms: s.ms, state: i === 0 ? "RUN" : "WAIT" }));
  c.orchIdx = 0;
  c.lae = c.track === "STP" ? ACT.laeSTP : ACT.laeFull;   // 理赔费用（Loss Adjustment Expense）
  DB.pool.lae += c.lae;
  c.evRequired = requiredFor(c);
  if (c.evRequired.length) {
    c.evDeadline = Date.now() + 60000;      // 演示用 60s 补证期（条款实务通常 15~30 日）
    c.evHold = false;
    audit("DOCS_REQUIRED", `赔案 ${c.no} 发出《补充单证通知书》：${c.evRequired.map(k => EV_KINDS[k].name).join("、")}`, c.no);
    aiLog("单证Agent", "DOCS_REQUIRED", .9,
      [{ s: "举证责任", d: "人工报案且无保险人侧独立监控数据，依条款由投保人提供事故证明", w: .4 },
       { s: "单证清单", d: `需提交 ${c.evRequired.map(k => EV_KINDS[k].name).join("、")}，逾期未补齐按单证不全处理`, w: .35 },
       { s: "防渗漏", d: "单证不全不予赔付，是控制赔付率与道德风险的核心闸门", w: .25 }],
      [{ k: "deadline", v: "60s（演示）" }, { k: "require", v: c.evRequired.join(",") }], c.no);
  }
  return c;
}

/* ============ AI 查勘定损 Agent ============ */
function investigate(c) {
  const node = DB.nodes.find(n => n.id === c.nodeId);
  const pol = DB.policies.find(p => p.no === c.policyNo);
  const prod = PRODUCTS[c.product] || PRODUCTS.DOWNTIME;
  const reasons = [], ev = [];

  const hbLost = c.evidence.find(e => e.k === "heartbeatLost");
  // 盲区赔案：使用补录/不利推定确定的时长，不做外推
  let hours = c.hoursOverride || Math.max(0.5, (hbLost ? hbLost.v : 3) * 0.5 + 1.5);
  ev.push({ k: "心跳日志", v: `连续丢失 ${hbLost ? hbLost.v : 3} 次` });
  reasons.push({ s: "事故真实性核验", d: "心跳日志与算力指纹交叉一致，出险事实成立", w: 0.25 });

  // 证据链校验：投保人单证可证明的时长与监控口径冲突时，从低认定（不利外推禁止）
  const evDocs = docsOf(c);
  if (evDocs.length) {
    const hs = evDocs.map(e => e.scan && e.scan.hours).filter(x => x != null && x > 0);
    let d = `已核验单证 ${evDocs.length} 份（均分 ${Math.round(evDocs.reduce((a, b) => a + b.score, 0) / evDocs.length)}），计入证据链`;
    if (hs.length) {
      const evH = Math.min.apply(null, hs);
      if (evH + 0.01 < hours) { hours = Math.max(0.5, evH); d += `；单证可证时长 ${evH}h 低于监控口径，按「可证明最短时长」从低定损 ${evH}h`; }
      else d += `；单证时长 ${evH}h 与监控口径一致`;
    }
    reasons.push({ s: "证据链校验", d, w: 0.15 });
    ev.push({ k: "证据", v: `${evDocs.length} 份已核验` });
  } else if (c.evRequired && c.evRequired.length) {
    reasons.push({ s: "证据链校验", d: `必要单证 ${c.evRequired.map(k => EV_KINDS[k].name).join("、")} 尚未提交，本定损为暂估，核赔将以单证齐全为前置`, w: 0.15 });
  }

  const cause = node.risk > 60 ? "设备老化/运维缺失" : (node.real ? "外部流量攻击导致算力饱和" : "计划外故障");
  reasons.push({ s: "近因判定", d: `近因认定为「${cause}」，属保险责任范围`, w: 0.2 });
  ev.push({ k: "近因", v: cause });

  // 阶梯赔付：免赔期 + 每小时比例 + 单次限额
  const sum = pol ? pol.sumInsured : 10000;
  const billable = Math.max(0, hours - ACT.waitingHours);
  const business = Math.min(sum * prod.hourly * billable, sum * prod.occCap);   // 营业中断（算力收入损失）
  const capped = sum * prod.hourly * billable > sum * prod.occCap;

  /* ---- 损失分项 × 因果强度 × 市场比价（吸收自理赔核定智能体） ----
     不是所有申报都全赔：按「因果置信度」折算，并按市场基准核减虚高报价 */
  const cB = c.src === "MANUAL" ? (hasPassedDoc(c, "HEARTBEAT_LOG") ? .88 : .55) : .93;
  const cR = hasPassedDoc(c, "OPS_TICKET") ? .85 : (c.src === "MANUAL" ? .40 : .70);
  const cV = hasPassedDoc(c, "CLOUD_BILL") ? .80 : (c.src === "MANUAL" ? .30 : .55);
  const items = [
    { id: "IT-01", cat: "business", name: "营业中断 · 算力收入损失", claimed: business, market: business, causation: cB, adj: 0 },
    { id: "IT-02", cat: "response", name: "应急响应与流量清洗", claimed: business * .18, market: business * .12, causation: cR, adj: 0 },
    { id: "IT-03", cat: "recovery", name: "系统恢复与数据重建", claimed: business * .30, market: business * .10, causation: cV, adj: 0 },
  ];
  items.forEach(it => {
    const priced = Math.min(it.claimed, it.market);           // 市场比价核减（申报高于同类基准时取基准）
    it.priced = money(priced);
    it.adj = money(priced * it.causation);                    // 因果强度折算后的核定金额
    it.cut = money(it.claimed - it.adj);
  });
  c.items = items;
  c.claimed = money(items.reduce((a, b) => a + b.claimed, 0));
  c.cut = money(items.reduce((a, b) => a + b.cut, 0));
  c.causation = R2(items.reduce((a, b) => a + b.adj, 0) / Math.max(1, c.claimed));
  c.mainCausation = R2(cB);                                   // 主险项（营业中断）的因果强度，用作直通准入口径
  let loss = money(items.reduce((a, b) => a + b.adj, 0));

  reasons.push({
    s: "损失分项核定",
    d: `营业中断 ${money(business)}（计费 ${billable.toFixed(1)}h × ${(prod.hourly * 100).toFixed(1)}%/h${capped ? "，触及单次限额" : ""}）` +
      ` + 应急响应 + 恢复重建；申报合计 ${money(c.claimed)}`,
    w: 0.25,
  });
  reasons.push({
    s: "因果强度核减",
    d: `按近因强度逐项折算（营业中断 ${(cB * 100).toFixed(0)}% / 应急响应 ${(cR * 100).toFixed(0)}% / 恢复重建 ${(cV * 100).toFixed(0)}%）` +
      `，并对高于市场基准的恢复重建费用做比价核减 → 核减 ${money(c.cut)}，核定 ${money(loss)}`,
    w: 0.22,
  });
  ev.push({ k: "免赔期", v: ACT.waitingHours + "h" }, { k: "单次限额", v: "保额 " + prod.occCap * 100 + "%" },
    { k: "核减率", v: R2(c.cut / Math.max(1, c.claimed) * 100) + "%" });

  const ded = pol ? pol.deductible : 0;
  const payable = Math.max(0, loss - ded);
  reasons.push({ s: "理算", d: `核定损失 ${money(loss)} − 免赔额 ${money(ded)} = 应付 ${money(payable)}`, w: 0.2 });

  const ceded = money(payable * ACT.cession), net = money(payable - ceded);
  reasons.push({ s: "再保险摊回", d: `比例再保险分出 ${ACT.cession * 100}% → 摊回 ${money(ceded)}，公司自留 ${money(net)}`, w: 0.1 });

  c.hours = R2(hours); c.loss = money(loss); c.payable = money(payable);
  c.ceded = ceded; c.net = net;
  c.stage = "INVESTIGATING"; c.stageIdx = 1;
  // 职责分离：金额由第三方定损机构签出，核赔 Agent 无权修改，争议须提请独立复核
  c.adjuster = { id: "ADJ-01", name: ADJUSTERS["ADJ-01"].name, license: ADJUSTERS["ADJ-01"].license, operator: ADJUSTERS["ADJ-01"].operator, signedAt: nowISO() };
  // 定损后复核轨道：金额大或因果强度低 → 从直通降级为编排（交给第三方与复核）
  const track = (c.track === "ORCHESTRATED" || c.net > STP.maxNet || c.mainCausation < STP.minCausation)
    ? "ORCHESTRATED" : "STP";
  if (track !== c.track) {
    audit("TRACK", `赔案 ${c.no} 轨道调整：${c.track} → ${track}（自留 ${money(c.net)} / 因果强度 ${c.causation}）`, c.no);
    c.track = track;
  }
  const laeNew = c.track === "STP" ? ACT.laeSTP : ACT.laeFull;
  if (laeNew !== c.lae) { DB.pool.lae += laeNew - c.lae; c.lae = laeNew; }
  aiLog("查勘定损Agent", `LOSS_ADJUSTED ${money(payable)}（自留 ${money(net)}）`, R2(0.84 + Math.random() * 0.1), reasons, ev, c.no);
  audit("ADJUST", `赔案 ${c.no} 定损：申报 ${money(c.claimed)} → 核减 ${money(c.cut)} → 应付 ${money(payable)}（分出 ${money(ceded)}，自留 ${money(net)}）· 第三方 ${ADJUSTERS["ADJ-01"].name} 签出`, c.no);
  if (!DRY) setTimeout(() => adjudicate(c), 2200);
  return c;
}

/* ---- 除外责任引擎：保险人主张除外须举证，举证不足则除外不成立，仍须赔付 ---- */
function checkExclusions(c) {
  const hits = [];
  for (const [code, ex] of Object.entries(EXCLUSIONS)) {
    // 命中来源：任一已提交证据的文本检出该条款关键词
    const matched = DB.evidence.filter(e => e.claimNo === c.no && e.scan && ex.kw.test(e.scan.raw || ""));
    if (!matched.length && c.excludedBy !== code && !(c.excluded && ex.kw.test(c.excluded))) continue;
    // 举证要件：对应类型单证已提交且非「驳回」（因内容命中除外而标记为 EXCLUDED 的，仍属已提交且真实）
    const proven = ex.requires.every(k =>
      DB.evidence.some(e => e.claimNo === c.no && e.kind === k && e.verdict !== "REJECTED"));
    hits.push({
      code, name: ex.name, requires: ex.requires.map(k => EV_KINDS[k].name),
      proven, thirdParty: !!ex.thirdParty,
      outcome: proven ? "EXCLUSION_APPLIED" : "EXCLUSION_UNPROVEN",
      detail: proven
        ? `已取得 ${ex.requires.map(k => EV_KINDS[k].name).join("、")} 佐证 → 除外成立，本单拒赔`
        : `举证要件 ${ex.requires.map(k => EV_KINDS[k].name).join("、")} 未齐备 → 举证不足，除外不成立，仍须赔付`,
    });
  }
  return hits;
}

/* ============ AI 核赔 Agent（反欺诈 + Critic 复核） ============ */
function adjudicate(c) {
  const node = DB.nodes.find(n => n.id === c.nodeId);
  const reasons = [], ev = [];
  let fraud = 8;
  if (c.delayMin > 120) { fraud += 22; ev.push({ k: "报案时效", v: `延迟 ${c.delayMin} 分钟` }); }
  if (node.claims12m >= 4) { fraud += 18; ev.push({ k: "出险频率", v: `近12月 ${node.claims12m} 次` }); }
  if (c.src === "MANUAL") { fraud += 10; ev.push({ k: "报案来源", v: "人工报案，加强核验" }); }
  if (c.product === "HASHRATE") { fraud += 6; ev.push({ k: "险种风险", v: "算力不足险主观性较强" }); }
  fraud = Math.min(100, fraud);
  reasons.push({ s: "反欺诈筛查", d: `欺诈评分 ${fraud}/100（阈值 70）`, w: 0.3 });

  // 证据链：权重最高的反欺诈维度（单证齐全降欺诈分，驳回/缺失升欺诈分）
  const evs = DB.evidence.filter(e => e.claimNo === c.no);
  const okEv = evs.filter(e => e.verdict === "ACCEPTED" || e.verdict === "ACCEPTED_WITH_RESERVE");
  const badEv = evs.filter(e => e.verdict === "REJECTED");
  const miss = missingDocs(c);
  if (evs.length) {
    if (okEv.length) { fraud = Math.max(0, fraud - 8); ev.push({ k: "证据核验", v: `${okEv.length} 份通过 · 均分 ${Math.round(okEv.reduce((a, b) => a + b.score, 0) / okEv.length)}` }); }
    if (badEv.length) { fraud += 20; ev.push({ k: "无效证据", v: `${badEv.length} 份未通过核验` }); }
    fraud = Math.min(100, fraud);
  }
  if (miss.length) fraud = Math.min(100, fraud + 15);
  if (c.excluded) fraud = Math.max(fraud, 72);
  reasons.push({
    s: "证据链核验",
    d: evs.length
      ? `共 ${evs.length} 份，采纳 ${okEv.length} 份${badEv.length ? `、驳回 ${badEv.length} 份` : ""}${miss.length ? `、仍缺 ${miss.map(k => EV_KINDS[k].name).join("/")}` : "、单证齐全"}`
      : (miss.length ? `未提交必要单证：${miss.map(k => EV_KINDS[k].name).join("、")}` : "保险人自有监控数据构成完整证据链，无需投保人补充单证"),
    w: 0.3,
  });

  const inForce = DB.policies.find(p => p.no === c.policyNo);
  const covered = !!inForce;
  reasons.push({ s: "条款校验", d: covered ? `保单 ${inForce.no} 在有效期内，事故属保险责任` : "未找到有效保单", w: 0.25 });

  /* 除外责任引擎：保险人主张除外，举证责任在保险人；举证不足则除外不成立，仍须赔付 */
  const exHits = checkExclusions(c);
  c.exclusions = exHits;
  const exApplied = exHits.filter(h => h.outcome === "EXCLUSION_APPLIED");
  const exUnproven = exHits.filter(h => h.outcome === "EXCLUSION_UNPROVEN");
  if (exHits.length) {
    reasons.push({
      s: "除外条款比对",
      d: exHits.map(h => `${h.code}「${h.name}」→ ${h.outcome === "EXCLUSION_APPLIED" ? "除外成立" : "举证不足，除外不成立"}`).join("；"),
      w: 0.3,
    });
    ev.push({ k: "除外命中", v: exHits.map(h => h.code).join(",") });
    if (exUnproven.length) {
      aiLog("合规Agent", "EXCLUSION_UNPROVEN", .88,
        [{ s: "法律原则", d: "保险人主张除外责任，举证责任在保险人一方", w: .5 },
         { s: "本案判定", d: `${exUnproven.map(h => h.code + "「" + h.name + "」").join("、")} 缺乏 ${exUnproven.map(h => h.requires.join("/")).join("、")} 佐证 → 除外不成立，仍须赔付`, w: .5 }],
        [{ k: "unproven", v: exUnproven.map(h => h.code).join(",") }], c.no);
      audit("COMPLIANCE", `赔案 ${c.no} 除外举证不足：${exUnproven.map(h => h.code).join(",")} → 除外不成立，仍须赔付`, c.no);
    }
  }

  let decision, why, conf;
  if (exApplied.length) { decision = "DECLINED"; why = `除外责任成立：${exApplied.map(h => h.code + "「" + h.name + "」").join("、")}（举证要件齐备）`; conf = 0.93; }
  else if (fraud >= 70) { decision = "DECLINED"; why = `欺诈评分 ${fraud} 触发拒赔，移交特别调查组（SIU）`; conf = 0.88; }
  else if (!covered) { decision = "DECLINED"; why = "无有效保单，保险责任不成立"; conf = 0.95; }
  else if (miss.length && Date.now() < (c.evDeadline || 0)) {
    decision = "PENDING_EVIDENCE";
    why = `缺少必要单证（${miss.map(k => EV_KINDS[k].name).join("、")}），已发出《补充单证通知书》，截止 ${new Date(c.evDeadline).toISOString().slice(11, 19)} 前补齐后自动恢复核赔，逾期按单证不全拒赔`;
    conf = 0.86;
  }
  else if (miss.length) { decision = "DECLINED"; why = `超过补证期限，必要单证仍不齐（${miss.map(k => EV_KINDS[k].name).join("、")}），按单证不全拒赔`; conf = 0.9; }
  else if (c.net > 15000) { decision = "REFERRED"; why = `自留赔款 ${money(c.net)} 超授权阈值，需二级核赔人复核`; conf = 0.8; }
  else { decision = "APPROVED"; why = `证据链完整、无欺诈嫌疑，核定赔付 ${money(c.payable)}（自留 ${money(c.net)}）`; conf = 0.88 + Math.random() * 0.08; }
  reasons.push({ s: "核赔决策", d: why, w: 0.3 });

  // 挂起等待补证：到期复核
  if (decision === "PENDING_EVIDENCE") {
    c.evHold = true;
    clearTimeout(CLAIM_TIMERS[c.no]);
    if (!DRY) CLAIM_TIMERS[c.no] = setTimeout(() => {
      if (c.stage === "CLOSED" || !missingDocs(c).length) return;
      c.evHold = false; c.decision = "DECLINED";
      c.why = `超过补证期限（${new Date(c.evDeadline).toISOString().slice(11, 19)}），必要单证未补齐 → 单证不全拒赔`;
      c.stage = "CLOSED"; c.stageIdx = 6;
      releaseReserve(c);
      audit("CLOSE", `赔案 ${c.no} 单证不全拒赔结案`, c.no);
      aiLog("核赔Agent", "DECLINED(NO_DOCS)", 0.9,
        [{ s: "期限届满", d: "补证通知发出后投保人未在期限内提交必要单证", w: .5 },
         { s: "核赔结论", d: "依条款第 12 条（投保人举证义务）拒赔，冲回未决准备金；该拒赔不计入赔付率，保护承保利润", w: .5 }],
        [{ k: "missing", v: missingDocs(c).map(k => EV_KINDS[k].name).join("/") }], c.no);
    }, Math.max(1200, (c.evDeadline || 0) - Date.now()));
  }

  const critic = { agree: true, note: "" };
  if (decision === "APPROVED" && node.risk > 55) { critic.agree = false; critic.note = `复核意见：节点历史风险偏高（${node.risk}），建议加查运维日志并上调续保费率`; }
  if (decision === "PENDING_EVIDENCE") critic.note = "复核意见：同意挂起，金额与责任暂无法确认，先补证再核定";
  else if (decision === "REFERRED") critic.note = "复核意见：同意升级，证据链完整但金额超授权";
  else if (decision === "DECLINED") critic.note = "复核意见：同意拒赔，规则命中明确";
  else critic.note = "复核通过，无异议";
  reasons.push({ s: "Critic 复核", d: critic.note, w: 0.15 });

  c.fraud = fraud; c.decision = decision; c.why = why; c.conf = R2(conf); c.critic = critic;
  c.stage = "ADJUSTED"; c.stageIdx = 2;
  aiLog("核赔Agent", decision, R2(conf), reasons, ev, c.no);
  audit("ADJUDICATE", `赔案 ${c.no} 核赔：${decision}（欺诈分 ${fraud}）`, c.no);

  const settle = () => {
    // 干跑（实验室）：保留「升级复核中」状态展示授权闸门，不自动放行
    if (c.decision === "REFERRED" && !DRY) {
      c.decision = "APPROVED"; c.why += "｜二级核赔人复核通过";
      aiLog("二级核赔Agent", "APPROVED(ESCALATED)", 0.93,
        [{ s: "升级复核", d: "金额超授权但证据链完整、欺诈评分低，予以放行", w: 1 }],
        [{ k: "复核人", v: "Chief Underwriter (AI)" }], c.no);
      audit("ESCALATE", `赔案 ${c.no} 升级复核通过`, c.no);
    }
    c.stage = "ADJUDICATED"; c.stageIdx = 3;
    if (c.decision === "APPROVED") {
      if (c.track === "STP") {
        aiLog("直通引擎Agent", "STP_SETTLED", 0.94,
          [{ s: "直通准入", d: `参数化赔案 · 自留 ${money(c.net)} ≤ ${STP.maxNet} · 因果强度 ${c.causation} ≥ ${STP.minCausation} · 证据齐备`, w: .5 },
           { s: "降本效果", d: `免第三方定损与多级复核，单均理赔费用 ${ACT.laeSTP} BOT（编排件 ${ACT.laeFull} BOT）→ 直接压低综合成本率`, w: .5 }],
          [{ k: "track", v: "STP" }, { k: "lae", v: ACT.laeSTP }], c.no);
        if (!DRY) setTimeout(() => pay(c), 900);
      } else {
        if (!DRY) setTimeout(() => runOrchestration(c, () => pay(c)), 400);
      }
    }
    else if (c.decision === "PENDING_EVIDENCE") { /* 挂起等待补证，到期由定时器复核 */ }
    else if (c.decision === "REFERRED" && DRY) { c.stage = "ADJUDICATED"; audit("ESCALATE", `赔案 ${c.no} 升级二级核赔人复核中（实验室干跑，不自动放行）`, c.no); }
    else { c.stage = "CLOSED"; audit("CLOSE", `赔案 ${c.no} 拒赔结案`, c.no); }
  };
  if (DRY) settle(); else setTimeout(settle, 2400);
  return c;
}

/* ---- 编排调度：复杂件按 8 步计划推进（顺序 / 超时 / 重试 / 降级 / 幂等） ---- */
function runOrchestration(c, done) {
  if (!c.orch) return done();
  audit("ORCH_START", `赔案 ${c.no} 进入编排调度（${c.orch.length} 步）`, c.no);
  let i = 0;
  (function step() {
    if (i > 0) c.orch[i - 1].state = "OK";
    if (i >= c.orch.length) { audit("ORCH_DONE", `赔案 ${c.no} 编排完成 → 进入赔付执行`, c.no); return done(); }
    const s = c.orch[i];
    s.state = "RUN"; c.orchIdx = i;
    audit("ORCH", `赔案 ${c.no} 步骤 ${i + 1}/${c.orch.length} · ${s.name}（${s.svc}）`, c.no);
    i++;
    setTimeout(step, Math.min(600, s.ms));
  })();
}

/* ============ 支付 ============ */
function pay(c) {
  DB.pool.capital -= c.net;
  DB.pool.gross += c.payable; DB.pool.ceded += c.ceded; DB.pool.netClaims += c.net;
  DB.pool.reserve = Math.max(0, DB.pool.reserve - c.reserved);
  c.stage = "PAID"; c.stageIdx = 4; c.paidAt = nowISO();
  const node = DB.nodes.find(n => n.id === c.nodeId);
  node.incNet += c.net; node.claims12m++;
  ledger("赔款支出", "银行存款", c.net, `赔案 ${c.no} 支付（自留）`);
  if (c.ceded > 0) ledger("应收分保款", "摊回分保赔款", c.ceded, `赔案 ${c.no} 再保摊回`);
  audit("PAY", `赔案 ${c.no} 赔付 ${money(c.payable)}（自留 ${money(c.net)}，再保摊回 ${money(c.ceded)}）`, c.no);
  aiLog("支付Agent", `PAID ${money(c.payable)}`, 0.99,
    [{ s: "支付执行", d: `全额 ${money(c.payable)} 划付投保人，其中自留 ${money(c.net)}、再保承担 ${money(c.ceded)}`, w: 1 }],
    [{ k: "tx", v: "0x" + hash(c.no + Date.now()) + "…" }], c.no);
  setTimeout(() => subrogate(c), 2200);
  return c;
}

/* ============ 代位追偿（Slashing） ============ */
function subrogate(c) {
  const node = DB.nodes.find(n => n.id === c.nodeId);
  const rec = Math.min(node.stake, money(c.net * ACT.recovery));
  node.stake -= rec; node.risk = Math.min(100, node.risk + 10);
  node.avail = Math.max(80, node.avail - 0.5);
  DB.pool.capital += rec; DB.pool.recovered += rec;
  c.subrogation = rec; c.recovered = rec; c.netLoss = money(c.net - rec);
  c.stage = "RECOVERED"; c.stageIdx = 5;
  // 第三方责任人识别：上游基础设施故障 → 向责任第三方（云厂商/机房/运营商）追偿
  const third = (c.exclusions || []).filter(h => h.thirdParty);
  if (third.length) {
    const tRec = money(c.net * 0.35);
    DB.pool.capital += tRec; DB.pool.recovered += tRec;
    c.subrogation += tRec; c.recovered += tRec; c.netLoss = money(c.net - c.recovered);
    c.thirdPartyClaim = { code: third[0].code, name: third[0].name, amount: tRec };
    ledger("银行存款", "追偿收入", tRec, `赔案 ${c.no} 向责任第三方追偿`);
    audit("SUBROGATE_3RD", `赔案 ${c.no} 识别第三方责任 ${third[0].code}「${third[0].name}」→ 追偿 ${money(tRec)}`, c.no);
    aiLog("追偿Agent", "THIRD_PARTY_RECOVERY", 0.86,
      [{ s: "责任识别", d: `事故定性为上游基础设施故障，责任主体为云厂商/机房/运营商，非节点自身过失`, w: .5 },
       { s: "追偿依据", d: `依保险法第六十条代位求偿权，向造成保险标的损害的第三方追偿 ${money(tRec)}（SLA 违约）`, w: .5 }],
      [{ k: "thirdParty", v: third[0].code }, { k: "amount", v: money(tRec) }], c.no);
  }
  ledger("银行存款", "追偿收入", rec, `赔案 ${c.no} 向 ${node.id} 代位追偿`);
  audit("SUBROGATE", `赔案 ${c.no} 代位追偿 ${money(rec)}（节点质押罚没，追偿率 ${ACT.recovery * 100}%）`, c.no);
  aiLog("追偿Agent", `RECOVERED ${money(rec)}`, 0.9,
    [{ s: "追偿决策", d: `依代位求偿权向违约节点追偿 ${ACT.recovery * 100}%，质押余额 ${money(node.stake)}`, w: 0.5 },
     { s: "盈利保护", d: `本单最终净损失 ${money(c.netLoss)}，占已赚保费比重可控；节点续保费率将上调`, w: 0.5 }],
    [{ k: "NodeRegistry.slash", v: money(rec) }], c.no);

  // 组合风控：节点赔付率越线 → 自动停售
  const lr = node.premium > 0 ? node.incNet / node.premium : 0;
  if (lr > ACT.stopLoss && !node.suspended) {
    node.suspended = true;
    node.suspendReason = `赔付率 ${(lr * 100).toFixed(0)}% 超红线 ${(ACT.stopLoss * 100).toFixed(0)}%`;
    node.suspendedAt = nowISO();
    audit("RISK_CONTROL", `节点 ${node.id} 赔付率 ${(lr * 100).toFixed(0)}% 越线 → 自动停售`, "");
    aiLog("风控Agent", "SUSPEND_UNDERWRITING", 0.91,
      [{ s: "组合风控", d: `该节点赔付率 ${(lr * 100).toFixed(0)}% 超过 ${(ACT.stopLoss * 100).toFixed(0)}% 红线，暂停承保以守住承保利润`, w: 1 }],
      [{ k: "node.lossRatio", v: (lr * 100).toFixed(0) + "%" }], "");
  }
  setTimeout(() => {
    c.stage = "CLOSED"; c.stageIdx = 6;
    const pol = DB.policies.find(p => p.no === c.policyNo);
    if (pol) pol.status = "SETTLED";
    audit("CLOSE", `赔案 ${c.no} 结案（毛 ${money(c.payable)} / 自留 ${money(c.net)} / 追偿 ${money(rec)} / 净损失 ${money(c.netLoss)}）`, c.no);
  }, 1600);
  return c;
}

seedBusiness();

/* ============ 自主监控 Agent ============ */
function httpGet(url, ms) {
  return new Promise((res) => {
    try {
      const r = http.get(url, { timeout: ms || 2500 }, (x) => { let b = ""; x.on("data", d => b += d); x.on("end", () => res(b)); });
      r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
    } catch (e) { res(null); }
  });
}
/* ---- 观察者网络：去中心化监控，避免单点故障 ---- */
const OBS = [
  { id: "OB-1", name: "主观察者 · 华东", url: NODE_SRV + "/health", ok: true, lat: 0, last: "" },
  { id: "OB-2", name: "备用观察者 · 新加坡", url: NODE_SRV + "/observer2", ok: true, lat: 0, last: "" },
  { id: "OB-3", name: "链上心跳锚点", url: NODE_SRV + "/metrics", ok: true, lat: 0, last: "" },
];
const CANARY = "http://127.0.0.1:" + PORT + "/api/state";   // 独立于被保节点的参照物（金丝雀）
const MON = { status: "HEALTHY", blind: null, blindTotal: 0, blindCount: 0, ticks: 0, okTicks: 0, blackoutUntil: 0, quorum: 2 };

/* 被保标的自描述：若节点侧实现了 /info（靶机适配层有），则在状态里透出，
   让界面能说明「监控的到底是什么系统」，而不是一句抽象的 nodeId。 */
let TARGET_INFO = null;
async function refreshTargetInfo() {
  const raw = await httpGet(NODE_SRV + "/info", 1500);
  let j = null; try { j = raw ? JSON.parse(raw) : null; } catch (e) { }
  TARGET_INFO = (j && j.adapter) ? j : null;
}
setInterval(refreshTargetInfo, 10000);
refreshTargetInfo();

/* 铁律：监控中断 ≠ 节点正常。看不到的时候不做任何出险判定。 */
function enterBlind(reason) {
  if (!MON.blind) {
    MON.blind = { start: Date.now(), startISO: nowISO(), reason, ms: 0 };
    MON.blindCount++;
    audit("BLIND_START", `监控盲区开始：${reason} —— 期间不做出险判定（监控中断 ≠ 节点正常）`, "");
    aiLog("监控Agent", "BLIND_WINDOW", 0.95,
      [{ s: "故障域判定", d: "观察者与金丝雀同时不可达 → 判定为保险人侧监控链路故障，而非节点出险", w: 0.55 },
       { s: "处置原则", d: "盲区期间：不认定出险、不计算报案时效；恢复后启动数据补录，补录无果则举证责任倒置", w: 0.45 }],
      [{ k: "canary", v: "unreachable" }], "");
  }
  MON.status = "BLIND";
  MON.blind.ms = Date.now() - MON.blind.start;
}
function exitBlind() {
  if (MON.blind) {
    const b = MON.blind;
    b.ms = Date.now() - b.start;
    MON.blindTotal += b.ms;
    audit("BLIND_END", `监控恢复，盲区持续 ${(b.ms / 1000).toFixed(0)}s → 启动数据补录`, "");
    setTimeout(() => backfill(b), 900);
    MON.blind = null;
  }
}

/* 盲区结束后：向节点侧日志补拉数据；补不到则举证责任倒置 */
async function backfill(b) {
  const node = DB.nodes.find(n => n.real);
  const raw = await httpGet(NODE_SRV + "/history?from=" + (b.start - 4000), 2500);
  let info = null; try { info = raw ? JSON.parse(raw) : null; } catch (e) { }
  const proven = info && info.hasData ? (info.provenDownSeconds || 0) : 0;
  // 恢复后先确认节点当前状态，避免无证据时误赔
  const cur = await httpGet(NODE_SRV + "/health", 2000);
  let curOk = false; try { const j = cur ? JSON.parse(cur) : null; curOk = !!(j && j.status === "ok"); } catch (e) { }

  if (proven > 30) {
    // ① 补录成功：按「可证明的最短时长」保守定损
    const c = reportClaim(node.id, "DOWNTIME",
      [{ k: "heartbeatLost", v: Math.ceil(proven / 60) }, { k: "补录证据", v: `节点日志 ${info.downSamples} 条离线样本` }], "BACKFILL");
    c.blind = true; c.provenHours = R2(proven / 3600); c.hoursOverride = R2(Math.max(0.5, proven / 3600));
    c.delayMin = 0;   // 时效中止
    aiLog("监控Agent", "BACKFILL_OK", 0.9,
      [{ s: "数据补录", d: `从节点侧日志回拉到 ${info.downSamples} 条离线样本，可证离线 ${(proven / 60).toFixed(1)} 分钟`, w: 0.6 },
       { s: "保守定损", d: "按可证明的最短时长核定，不做不利外推，避免多赔", w: 0.4 }],
      [{ k: "history.downSamples", v: info.downSamples }], c.no);
    audit("BACKFILL", `赔案 ${c.no} 由盲区补录立案，可证离线 ${(proven / 60).toFixed(1)} 分钟`, c.no);
    setTimeout(() => investigate(c), 1500);
  } else if (!curOk) {
    // ② 补录无果 + 节点恢复后仍离线：举证责任倒置，按不利推定立案
    const c = reportClaim(node.id, "DOWNTIME",
      [{ k: "监控盲区", v: `${(b.ms / 1000).toFixed(0)}s 无观测数据` }], "BLIND");
    c.blind = true; c.pendingSelfProof = true; c.hoursOverride = 2.5; c.delayMin = 0;
    c.selfProofUntil = Date.now() + 45000;
    c.why = "监控盲区：举证责任倒置，按保单约定默认时长 2.5h 立案，待节点自证在线";
    aiLog("理赔Agent", "BURDEN_OF_PROOF_SHIFT", 0.86,
      [{ s: "证据状态", d: "节点侧日志亦无该时段记录，无法证明在线或离线", w: 0.4 },
       { s: "法律逻辑", d: "监控是保险人义务，保险人未尽监控义务应承担不利后果 → 举证责任倒置给节点", w: 0.35 },
       { s: "处置", d: "按保单约定默认时长 2.5h 立案，给节点自证窗口；期限内未自证则赔付生效", w: 0.25 }],
      [{ k: "blindSeconds", v: (b.ms / 1000).toFixed(0) }, { k: "默认时长", v: "2.5h" }], c.no);
    audit("BACKFILL", `赔案 ${c.no} 举证责任倒置立案（默认 2.5h），等待节点自证`, c.no);
    // 节点自证窗口（演示 45s）：期间可在「证据中心」上传《在线自证材料》推翻不利推定
    setTimeout(() => {
      const proved = DB.evidence.some(e => e.claimNo === c.no && e.kind === "SELF_PROOF"
        && (e.verdict === "ACCEPTED" || e.verdict === "ACCEPTED_WITH_RESERVE") && e.scan && e.scan.selfOn);
      if (proved || !c.pendingSelfProof) return;      // 已自证成立 / 已撤销
      c.selfProof = "节点未在期限内提交在线证据 → 不利推定成立，定损生效";
      aiLog("理赔Agent", "SELF_PROOF_FAILED", 0.88,
        [{ s: "自证结果", d: "节点未提交心跳/在线证据，不利推定成立，按默认时长 2.5h 进入查勘定损", w: 1 }],
        [{ k: "selfProof", v: "none" }], c.no);
      investigate(c);
    }, 45000);
  } else {
    // ③ 无离线证据 + 节点当前在线 → 核实为无出险，不予立案（避免误赔）
    audit("BACKFILL", "盲区补录完成：无离线证据且节点当前在线 → 核实为无出险，不予立案", "");
    aiLog("监控Agent", "BLIND_NO_LOSS", 0.83,
      [{ s: "补录结果", d: "节点侧日志无该时段离线记录", w: 0.4 },
       { s: "现状确认", d: "节点当前在线，盲区期间未发生保险事故", w: 0.35 },
       { s: "结论", d: "不予立案，避免无证据误赔；盲区时长已计入监控可用率考核", w: 0.25 }],
      [{ k: "history.samples", v: info ? info.samples.length : 0 }, { k: "node", v: "online" }], "");
  }
}

async function observe() {
  MON.ticks++;
  const blackout = Date.now() < MON.blackoutUntil;      // 模拟保险人系统下线（演示用）
  // 金丝雀：判断到底是节点挂了，还是我们自己的监控链路挂了
  const canaryRaw = blackout ? null : await httpGet(CANARY + "?probe=1", 2000);
  const canaryOk = !!canaryRaw;

  const votes = await Promise.all(OBS.map(async o => {
    if (blackout) { o.ok = false; o.lat = 0; return false; }
    const t0 = Date.now();
    const raw = await httpGet(o.url, 2200);
    let ok = false;
    try {
      const j = raw ? JSON.parse(raw) : null;
      // 被观察者若显式上报 status，以 status 为准（避免「有 reqs 字段就算存活」的误判）；
      // 只有未提供 status 的简易心跳端点才退回宽松判定。
      if (j && typeof j.status === "string") ok = (j.status === "ok");
      else if (j) ok = (typeof j.heartbeats === "number" || typeof j.reqs === "number");
    } catch (e) { }
    o.ok = ok; o.lat = Date.now() - t0; o.last = nowISO();
    return ok;
  }));
  const upCount = votes.filter(Boolean).length;
  if (canaryOk) MON.okTicks++;

  if (!canaryOk) { enterBlind(blackout ? "保险人系统下线（演练）" : "监控链路/金丝雀不可达"); return; }
  exitBlind();

  const node = DB.nodes.find(n => n.real);
  if (upCount >= MON.quorum) {                          // ≥2/3 观察者确认在线
    DB.nodeUp = true; DB.nodeFails = 0; node.up = true;
    MON.status = upCount === OBS.length ? "HEALTHY" : "DEGRADED";
    // 风险分取自主观察者
    const raw = await httpGet(NODE_SRV + "/health", 2000);
    let d = null; try { d = raw ? JSON.parse(raw) : null; } catch (e) { }
    if (d && d.status === "ok") {
      node.risk = d.risk; node.latency = d.avgLatency;
      if (d.risk > 45 && !node.warned) {
        node.warned = true;
        aiLog("监控Agent", "EARLY_WARNING", 0.8,
          [{ s: "预测性预警", d: `节点延迟 ${d.avgLatency}ms、风险分 ${d.risk}，出险概率上升；已通知投保人减损并预留准备金`, w: 1 }],
          [{ k: "health.latency", v: d.avgLatency }, { k: "health.risk", v: d.risk }], "");
        audit("WARNING", `预测性预警：${node.id} 风险分 ${d.risk}`, "");
      }
      if (d.risk < 35) node.warned = false;
    }
  } else {                                              // ≥2/3 观察者认定离线
    DB.nodeUp = false; DB.nodeFails++; node.up = false;
    node.risk = Math.min(100, node.risk + 6);
    MON.status = "DOWN_CONFIRMED";
    if (DB.auto && DB.nodeFails === 2 && !DB.claims.some(c => c.nodeId === node.id && c.stage !== "CLOSED")) {
      const c = reportClaim(node.id, "DOWNTIME",
        [{ k: "heartbeatLost", v: 3 }, { k: "观察者投票", v: `${upCount}/${OBS.length} 在线` }], "AUTO");
      aiLog("监控Agent", "AUTO_FNOL", 0.93,
        [{ s: "多观察者共识", d: `${OBS.length - upCount}/${OBS.length} 个观察者判定离线，金丝雀正常 → 排除监控侧故障`, w: 0.5 },
         { s: "自主决策", d: "依保单条款自动立案，无需投保人申请", w: 0.5 }],
        [{ k: "quorum", v: `${upCount}/${OBS.length}` }, { k: "canary", v: "ok" }], c.no);
      setTimeout(() => investigate(c), 1800);
    }
  }
}
setInterval(observe, 3000);
setInterval(() => {
  const p = DB.pool;
  const cap = p.written * 0.98;                 // 未到期责任下限 2%，避免已赚保费无限漂移
  if (p.earned < cap) p.earned = Math.min(cap, p.earned + p.written * 0.006);
  p.expenses = p.written * ACT.expenseRatio * 0.92;
}, 5000);

/* ============ 经营指标 ============ */
const issueRequests = new Map();
let sessionId = require('node:crypto').randomUUID();
function summary() {
  return { sessionId, asOf: new Date().toISOString(), capital: money(DB.pool.capital),
    activePolicies: DB.policies.filter(p => p.status === 'IN_FORCE').length,
    totalPolicies: DB.policies.length, nodes: DB.nodes.length,
    grossPaid: money(DB.pool.gross), openClaims: DB.claims.filter(c => c.stage !== 'CLOSED').length };
}
function applicationError(p) {
  if (!PRODUCTS[p.product]) return '请选择有效险种';
  if (!DB.nodes.some(n => n.id === p.nodeId)) return '请选择有效节点';
  if (!Number.isFinite(+p.sumInsured) || +p.sumInsured <= 0) return '保额须为大于 0 的数字';
  if (!Number.isInteger(+p.days) || +p.days < 1 || +p.days > 3650) return '期间须为 1–3650 天的整数';
  if (p.deductible == null || p.deductible === '' || !Number.isFinite(+p.deductible) || +p.deductible < 0 || +p.deductible >= +p.sumInsured) return '免赔额须大于等于 0 且小于保额';
  if (p.requestId != null && (typeof p.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(p.requestId))) return '提交标识无效';
  return '';
}
function applicationSignature(p) {
  return JSON.stringify([p.nodeId, p.product, +p.sumInsured, +p.days, +p.deductible, p.expectedPremium, p.expectedDeductible]);
}
function metrics() {
  const p = DB.pool;
  const netLoss = p.netClaims - p.recovered;                 // 净损失 = 自留赔款 − 追偿（行业口径）
  const all = DB.claims.filter(c => c.track);
  const stpCount = all.filter(c => c.track === "STP").length;
  const stpRate = all.length ? stpCount / all.length : 0;
  const cutRate = DB.claims.filter(c => c.claimed).reduce((a, c) => a + c.cut, 0) /
    Math.max(1, DB.claims.filter(c => c.claimed).reduce((a, c) => a + c.claimed, 0));
  // 费用率 = 管理费佣金 + 理赔费用(LAE)；直通率越高，单均 LAE 越低
  const lossRatio = p.earned ? netLoss / p.earned : 0;       // 赔付率（净）
  const expenseRatio = p.earned ? (p.expenses + p.lae) / p.earned : 0;
  const recoveryRatio = p.netClaims ? p.recovered / p.netClaims : 0;

  /* 自留口径（更严格）：比例再保要同时分出保费，再保人返还分保佣金。
     只把赔款分出、保费不分出，等于凭空多赚——所以这里再算一套「净自留」指标，
     两个口径都披露，避免用总保费口径把利润做得好看。 */
  const cededPremium = p.earned * ACT.cession;
  const cedingComm = cededPremium * ACT.cedingComm;
  const netEarned = p.earned - cededPremium + cedingComm;          // 净自留已赚保费
  const netExpense = Math.max(0, p.expenses - cedingComm);         // 分保佣金冲减费用
  const combinedNet = netEarned ? (netLoss + p.lae + netExpense) / netEarned : 0;

  return {
    capital: money(p.capital), written: money(p.written), earned: money(p.earned),
    gross: money(p.gross), ceded: money(p.ceded), netClaims: money(p.netClaims), recovered: money(p.recovered),
    netLoss: money(netLoss), reserve: money(p.reserve), expenses: money(p.expenses), lae: money(p.lae),
    lossRatio: R2(lossRatio * 100), expenseRatio: R2(expenseRatio * 100),
    laeRatio: R2((p.earned ? p.lae / p.earned : 0) * 100),
    stpRate: R2(stpRate * 100), cutRate: R2(cutRate * 100),
    exclusions: Object.keys(EXCLUSIONS).length, adjusters: ADJUSTERS,
    combinedRatio: R2((lossRatio + expenseRatio) * 100), recoveryRatio: R2(recoveryRatio * 100),
    /* 自留口径：分出保费 − 分保佣金后的真实综合成本率（更严格，通常高于总保费口径） */
    netEarned: money(netEarned), cededPremium: money(cededPremium), cedingComm: money(cedingComm),
    combinedNetRatio: R2(combinedNet * 100), uwProfitNet: money(netEarned - netLoss - p.lae - netExpense),
    uwProfit: money(p.earned - netLoss - p.expenses),
    margin: R2((p.earned ? (p.earned - netLoss - p.expenses) / p.earned : 0) * 100),
    solvency: R2((p.capital / Math.max(1, p.reserve)) * 100),
    openClaims: DB.claims.filter(c => c.stage !== "CLOSED").length,
    actuarial: ACT,
  };
}

/* ============ 智能体实验室：全链路干跑 ============
 * 用途：给定场景，完整跑一遍「受理分诊 → 单证核验 → 除外核查 → 查勘定损 → 核赔决策 → 追偿预判」，
 *       返回每个 Agent 的决策、置信度、推理链与证据。
 * 铁律：DRY 期间不调度定时器、证据原文不落盘；结束后整库回滚快照 —— 实验室只推演，不入经营账。
 */
const LAB_DOC_TPL = {
  HEARTBEAT_LOG:
    "[2026-10-07 16:02:11] ERROR heartbeat lost, node unreachable\n" +
    "[2026-10-07 16:02:12] ERROR rpc endpoint timeout, service down\n" +
    "[2026-10-07 16:07:40] WARN  workload dropped 98%, outage ongoing\n" +
    "[2026-10-07 19:05:02] INFO  service recovered after failover\n" +
    "心跳连续丢失 3 次，服务 down 3h，算力输出中断。\n",
  OPS_TICKET:
    "运维工单 OP-5512\n现象：节点突发宕机，heartbeat 连续丢失，服务 down，算力输出中断。\n" +
    "处置：值班工程师 5 分钟响应，执行故障切换，29 分钟后恢复。\n结论：突发硬件故障，已处置并复测通过。down 3h\n",
  CLOUD_BILL:
    "云厂商对账单 2026-10 · 实例 c5.8xlarge × 1 · 计费 720h · 单价 3.2 BOT/h\n" +
    "事故期间 3h 未产出有效算力，损失可量化对账。down 3h\n",
  CHAIN_PROOF: "tx 0x8a1f9c2b...c92 · BOT Chain · heartbeat anchor @ block 1284732 · status: ok\n",
  SELF_PROOF: "节点自证：16:02-16:09 heartbeat: ok · status: ok · 200 OK · uptime 99.98%\n",
  AUDIT_REPORT: "第三方审计报告：未发现已知未修复故障；运维流程合规，无人为误操作。\n",
  SCREENSHOT: "monitoring-screenshot-meta: 1920x1080 png\n",
};

function labSim(s) {
  s = s || {};
  const snap = JSON.stringify(DB);
  const snapEv = JSON.stringify({ items: EV_BATCH.items, seq: EV_BATCH.seq });
  const snapLae = DB.pool.lae, snapRes = DB.pool.reserve;
  let out;
  DRY = true;
  try {
    const node = DB.nodes.find(n => n.id === s.nodeId) || DB.nodes[0];
    const product = PRODUCTS[s.product] ? s.product : "DOWNTIME";
    const sumInsured = Math.max(1000, Math.min(500000, Number(s.sumInsured) || 20000));
    const pol = {
      no: "PL-LAB", nodeId: node.id, product, sumInsured, days: Number(s.days) || 30,
      premium: 0, deductible: Math.max(0, Number(s.deductible) || 0),
      status: "IN_FORCE", hourly: PRODUCTS[product].hourly, from: nowISO(), to: nowISO(),
    };
    DB.policies.unshift(pol);

    const c = reportClaim(node.id, product, [{ k: "heartbeatLost", v: 3 }], s.src || "AUTO");
    if (Number(s.hours) > 0) c.hoursOverride = Number(s.hours);

    // 单证：实验室代传，走与线上完全相同的六维核验
    const docs = [];
    const note = String(s.note || "");
    for (const k of (s.docs || [])) {
      if (!EV_KINDS[k]) continue;
      const txt = (LAB_DOC_TPL[k] || "") + (note ? "\n" + note + "\n" : "");
      const ev = addEvidence({ claimNo: c.no, nodeId: node.id, kind: k, name: `lab-${k.toLowerCase()}.txt`, text: txt, submitter: "智能体实验室" });
      verifyEvidence(ev, c);
      docs.push({
        id: ev.id, kind: k, kindName: ev.kindName, sha256: ev.sha256, size: ev.size,
        score: ev.score, verdict: ev.verdict, conf: ev.conf,
        checks: ev.checks.map(x => ({ k: x.k, ok: !!x.ok, d: x.d })),
        hours: ev.scan ? ev.scan.hours : null, planned: !!(ev.scan && ev.scan.planned),
      });
    }

    investigate(c);
    adjudicate(c);

    const agents = DB.ai.filter(r => r.claimNo === c.no).slice().reverse()
      .map(r => ({ agent: r.agent, decision: r.decision, conf: r.confidence, reasoning: r.reasoning || [], evidence: r.evidence || [], t: r.t }));
    const third = (c.exclusions || []).filter(h => h.thirdParty);
    const rec = Math.min(node.stake, money((c.net || 0) * ACT.recovery));
    const tRec = third.length ? money((c.net || 0) * 0.35) : 0;

    out = {
      ok: true, dryRun: true,
      claim: {
        no: c.no, nodeId: c.nodeId, product, track: c.track, stage: c.stage,
        decision: c.decision, conf: c.conf, why: c.why, fraud: c.fraud,
        hours: c.hours, claimed: c.claimed, cut: c.cut, causation: c.causation,
        payable: c.payable, ceded: c.ceded, net: c.net, lae: c.lae,
        adjuster: c.adjuster, critic: c.critic,
        items: (c.items || []).map(i => ({ name: i.name, claimed: i.claimed, market: i.market, causation: i.causation, adj: i.adj, cut: i.cut })),
        exclusions: (c.exclusions || []).map(h => ({ code: h.code, name: h.name, requires: h.requires, outcome: h.outcome, detail: h.detail, thirdParty: !!h.thirdParty })),
      },
      docs,
      agents,
      recovery: { node: rec, thirdParty: tRec, netLoss: money(Math.max(0, (c.net || 0) - rec - tRec)) },
      compare: {
        stp: { lae: ACT.laeSTP, steps: 0, note: "决策引擎直核，免第三方定损与多级复核" },
        orch: { lae: ACT.laeFull, steps: ORCH_PLAN.length, ms: ORCH_PLAN.reduce((a, b) => a + b.ms, 0), note: "8 步编排（顺序/超时/重试/降级/幂等）" },
        track: c.track,
      },
      stpGate: { maxNet: STP.maxNet, minCausation: STP.minCausation },
    };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  } finally {
    DRY = false;
    Object.assign(DB, JSON.parse(snap));
    const e = JSON.parse(snapEv); EV_BATCH.items = e.items; EV_BATCH.seq = e.seq;
    DB.pool.lae = snapLae; DB.pool.reserve = snapRes;
  }
  return out;
}

/* ============ HTTP ============ */
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { ...CORS, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) });
  res.end(b);
}
const server = http.createServer((req, res) => {
  let requestPath;
  try { requestPath = new URL(req.url, "http://localhost").pathname; }
  catch { return send(res, 400, { ok: false, error: "无效请求地址。" }); }
  if (handleModelRoutes(req, res, requestPath)) return;
  if (requestPath === "/api/verification" || requestPath.startsWith("/api/reports/")) {
    if (req.method !== "GET") return send(res, 405, { ok: false, error: "仅支持 GET。" });
    try {
      res.setHeader("Cache-Control", "no-store");
      if (requestPath === "/api/verification") return send(res, 200, getVerification());
      const id = requestPath.slice("/api/reports/".length);
      const { report, sha256 } = readReport(id);
      res.setHeader("X-Report-SHA256", sha256);
      return send(res, 200, report);
    } catch (error) { return send(res, error.status || 500, { ok: false, error: error.status ? error.message : "报告读取失败。" }); }
  }
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
   try {
    const u = new URL(req.url, "http://x");
    let p = {}; try { p = body ? JSON.parse(body) : {}; } catch (e) { p = {}; }

    /* ---- 证据原文（受控下载，仅本地证据库） ---- */
    if (u.pathname.startsWith("/uploads/")) {
      const fp = path.join(UPLOAD_DIR, path.basename(u.pathname));
      if (!fp.startsWith(UPLOAD_DIR) || !fs.existsSync(fp)) return send(res, 404, { error: "not found" });
      const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" }[extOf(fp)] || "text/plain; charset=utf-8";
      const b = fs.readFileSync(fp);
      res.writeHead(200, { ...CORS, "Content-Type": mime, "Content-Length": b.length });
      return res.end(b);
    }
    /* ---- 证据上传入口（投保人 / 节点运营方） ---- */
    if (u.pathname === "/api/evidence/upload") {
      try {
        if (!EV_KINDS[p.kind]) return send(res, 400, { ok: false, error: "未知单证类型：" + p.kind });
        const b64 = String(p.dataBase64 || "").split(",").pop();
        const buf = Buffer.from(b64, "base64");
        if (!buf.length) return send(res, 400, { ok: false, error: "空文件" });
        if (buf.length > MAX_UPLOAD) return send(res, 413, { ok: false, error: `单份证据上限 ${MAX_UPLOAD / 1048576}MB，当前 ${(buf.length / 1048576).toFixed(2)}MB` });
        const c = p.claimNo ? DB.claims.find(x => x.no === p.claimNo) : null;
        if (p.claimNo && !c) return send(res, 404, { ok: false, error: "赔案不存在：" + p.claimNo });
        const ev = addEvidence({ claimNo: p.claimNo || "", nodeId: p.nodeId || (c ? c.nodeId : ""), kind: p.kind, name: p.name || "evidence.bin", buf, submitter: p.submitter || "投保人" });
        verifyEvidence(ev, c);
        applyEvidence(ev, c);
        return send(res, 200, { ok: true, evidence: ev, missing: c ? missingDocs(c) : [] });
      } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
    }
    if (u.pathname === "/api/evidence/list") {
      const list = p.claimNo ? DB.evidence.filter(e => e.claimNo === p.claimNo) : DB.evidence;
      return send(res, 200, { ok: true, evidence: list.slice(0, 80), kinds: EV_KINDS, batches: EV_BATCH.seq });
    }
    if (u.pathname === "/api/evidence/anchor") { flushAnchor(); return send(res, 200, { ok: true, batches: EV_BATCH.seq }); }

    if (u.pathname === "/api/lab/sim") return send(res, 200, labSim(p));
    if (u.pathname === "/api/summary") return send(res, 200, summary());
    if (u.pathname === "/api/state") {
      return send(res, 200, {
        summary: summary(), nodes: DB.nodes, policies: DB.policies.slice(0, 24), claims: DB.claims.slice(0, 20),
        metrics: metrics(), audit: DB.audit.slice(-30), ai: DB.ai.slice(0, 25), ledger: DB.ledger.slice(0, 16),
        series: ledgerSeries(),
        auto: DB.auto, nodeUp: DB.nodeUp, nodeFails: DB.nodeFails, products: PRODUCTS,
        evidence: DB.evidence.slice(0, 40), evKinds: EV_KINDS, evBatches: EV_BATCH.seq,
        exclusions: Object.entries(EXCLUSIONS).map(([code, e]) => ({ code, name: e.name, requires: e.requires.map(k => EV_KINDS[k].name), thirdParty: !!e.thirdParty })),
        mon: { status: MON.status, blind: MON.blind, blindCount: MON.blindCount, blindTotal: MON.blindTotal,
               uptime: MON.ticks ? R2(MON.okTicks / MON.ticks * 100) : 100, quorum: MON.quorum, blackout: Date.now() < MON.blackoutUntil },
        observers: OBS,
        insured: TARGET_INFO ? {
          kind: TARGET_INFO.adapter, url: TARGET_INFO.target,
          label: "链安保险靶机 insure-target",
          okRate: TARGET_INFO.okRate, samples: TARGET_INFO.samples,
        } : null,
      });
    }
    if (u.pathname === "/api/quote" || u.pathname === "/api/issue") {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: '请使用 POST 提交' });
      const error = applicationError(p);
      if (error) return send(res, 400, { ok: false, error });
    }
    if (u.pathname === "/api/quote") return send(res, 200, underwrite(p));
    if (u.pathname === "/api/issue") {
      if (p.sessionId != null && p.sessionId !== sessionId) return send(res, 409, { ok: false, code: 'SESSION_CHANGED', error: '服务会话已变化，无法核对旧申请，请重新报价' });
      const signature = applicationSignature(p), cached = p.requestId && issueRequests.get(p.requestId);
      if (cached) {
        if (cached.signature !== signature) return send(res, 409, { ok: false, code: 'REQUEST_CONFLICT', error: '提交标识已用于其他投保内容，请重新报价' });
        return send(res, 200, cached.result);
      }
      const q = underwrite(p);
      if (q.decision === 'DECLINE') return send(res, 200, { ok: false, reason: '核保拒保：触发停售或承保限额，请调整后重新报价' });
      if ((p.expectedPremium != null && +p.expectedPremium !== q.premium) || (p.expectedDeductible != null && +p.expectedDeductible !== q.deductible))
        return send(res, 409, { ok: false, code: 'QUOTE_CHANGED', error: '风险或承保条件已变化，请重新报价并确认' });
      const result = { ok: true, policy: issuePolicy(q), quote: q };
      if (p.requestId) issueRequests.set(p.requestId, { signature, result });
      return send(res, 200, result);
    }
    if (u.pathname === "/api/claim/manual") {
      const c = reportClaim(p.nodeId, p.product || "DOWNTIME", [{ k: "heartbeatLost", v: 3 }], "MANUAL");
      setTimeout(() => investigate(c), 1500);
      return send(res, 200, { ok: true, claim: c });
    }
    // 演练：模拟保险人自身系统下线（监控盲区），验证业务连续性处置
    if (u.pathname === "/api/blackout") {
      const sec = +p.seconds || 30;
      MON.blackoutUntil = Date.now() + sec * 1000;
      audit("DRILL", `演练：模拟保险人系统下线 ${sec}s（监控盲区）`, "");
      return send(res, 200, { ok: true, seconds: sec });
    }
    if (u.pathname === "/api/auto") { DB.auto = !!p.on; audit("CONFIG", `自主闭环 ${DB.auto ? "开启" : "关闭"}`, ""); return send(res, 200, { auto: DB.auto }); }
    if (u.pathname === "/api/attack") {
      const concur = Math.max(1, Math.min(24, Number(p.concur) || 12));
      const msEach = Math.max(1000, Math.min(8000, Number(p.ms) || 6000));
      for (let i = 0; i < concur; i++) httpGet(NODE_SRV + "/work?ms=" + msEach, 9000);
      audit("ATTACK", `压测流量注入被保节点（${concur} 并发 × ${msEach / 1000}s）`, "");
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/reset") {
      issueRequests.clear();
      sessionId = require('node:crypto').randomUUID();
      DB.policies = []; DB.claims = []; DB.audit = []; DB.ai = []; DB.ledger = []; DB.evidence = []; DB.evSeq = 0;
      Object.keys(CLAIM_TIMERS).forEach(k => { clearTimeout(CLAIM_TIMERS[k]); delete CLAIM_TIMERS[k]; });
      EV_BATCH.items = []; EV_BATCH.seq = 0;
      DB.pool = { capital: 500000, written: 0, earned: 0, expenses: 0, lae: 0, gross: 0, ceded: 0, netClaims: 0, recovered: 0, reserve: 0 };
      DB.seq = { policy: 2400, claim: 800 }; seedNodes(); seedBusiness();
      return send(res, 200, { ok: true });
    }
    // Brand homepage and nested assets share the same local service.
    if (require("./static-files")(req, res, u.pathname, path.join(__dirname, "..", "frontend"))) return;
    return send(res, 404, { error: "not found" });
    } catch (e) {
      // 兜底：任何路由异常都退回 JSON 500，绝不让进程崩溃（演示/线上可用性优先）
      console.error("[api] " + u.pathname + " →", e && e.stack ? e.stack.split("\n")[0] : e);
      try { send(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch (_) { try { res.end(); } catch (__) {} }
    }
  });
});
/* 最后一道防线：未捕获异常不再终止进程，避免演示中途服务消失 */
process.on("uncaughtException", e => console.error("[uncaught]", e && e.stack ? e.stack.split("\n")[0] : e));
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e && e.message ? e.message : e));
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Aegis 保险核心] http://127.0.0.1:${PORT}`);
  audit("BOOT", "保险核心系统启动，精算引擎与 AI Agent 集群接管全流程", "");
});
