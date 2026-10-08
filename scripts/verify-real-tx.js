/* Aegis 神盾 · 真实交易可行性验证
 * ------------------------------------------------------------
 * 回答一个具体问题：我们能不能在 BOT Chain 上发出真实交易？
 * 不花一分钱就能验证到最后一公里 —— eth_estimateGas 会让节点**真实执行一遍 EVM**
 * 来给交易定价：字节码若不被该链接受（opcode 不支持 / 立即 revert）会直接报错，
 * 返回 gas 数字则说明「这笔部署交易在这条链上确实可执行」。
 *
 * 用法：
 *   node scripts/verify-real-tx.js                 # 探测主网 + 测试网
 *   node scripts/verify-real-tx.js --new-key       # 生成测试网专用密钥并写入 .env
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* ethers 可能装在靶机工程里，做一次兜底解析 */
function loadEthers() {
  const tries = ['ethers', path.join(__dirname, '..', '..', 'insure-target', 'node_modules', 'ethers')];
  for (const t of tries) { try { return require(t); } catch (e) { } }
  return null;
}
const ethers = loadEthers();

const CHAINS = [
  { id: 677, net: 'botchain', name: 'BOT Chain 主网', rpc: 'https://rpc.botchain.ai', scan: 'https://scan.botchain.ai' },
  { id: 968, net: 'bohr', name: 'BOT Chain 测试网 (Bohr)', rpc: 'https://rpc.bohr.life', scan: 'https://scan.bohr.life' },
];

async function rpc(url, method, params) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
    });
    const j = await r.json();
    if (j.error) return { err: j.error.message || JSON.stringify(j.error) };
    return { result: j.result };
  } catch (e) { return { err: String(e.message || e) }; }
  finally { clearTimeout(to); }
}

/* 构造部署交易 data：无参构造直接用 bytecode，有参则用 Interface 编码 */
function deployData(art, ctorArgs) {
  const bc = art.bytecode;
  if (!ctorArgs || !ctorArgs.length) return bc;
  if (!ethers) return null;
  const iface = new ethers.Interface(art.abi || []);
  return bc + iface.encodeDeploy(ctorArgs).slice(2);
}

const ART_DIR = path.join(__dirname, '..', 'artifacts');
const TARGETS = [
  { name: 'RiskPool', file: 'RiskPool', args: [] },
  { name: 'NodeRegistry', file: 'NodeRegistry', args: [] },
  { name: 'AIReporterMock', file: 'AIReporterMock', args: [] },
  { name: 'ComputeShieldCore', file: 'ComputeShieldCore', args: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003', '0x0000000000000000000000000000000000000004'] },
];

(async () => {
  /* 1) 密钥：优先读 .env，否则 --new-key 生成测试网专用新密钥 */
  const envPath = path.join(__dirname, '..', '.env');
  let key = (process.env.PRIVATE_KEY || '').trim();
  if (!key && fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^\s*PRIVATE_KEY\s*=\s*(\S+)/m);
    if (m) key = m[1];
  }
  let generated = false;
  if ((!key || key === '0x') && process.argv.includes('--new-key')) {
    if (!ethers) { console.error('缺少 ethers，无法生成密钥'); process.exit(1); }
    key = ethers.Wallet.createRandom().privateKey;
    generated = true;
    fs.writeFileSync(envPath, `# BOT Chain 测试网专用密钥（本地生成，勿提交）\nPRIVATE_KEY=${key}\n`);
  }
  let addr = null;
  if (key && key.startsWith('0x') && ethers) {
    try { addr = new ethers.Wallet(key).address; } catch (e) { addr = null; }
  }
  const from = addr || '0x0000000000000000000000000000000000000001';

  console.log('\n══════ Aegis 神盾 · 真实交易可行性验证 ══════');
  console.log(`部署账户：${addr || '(未配置 PRIVATE_KEY，用占位地址做 estimateGas)'}`);
  if (generated) console.log(`  （已生成测试网专用新密钥并写入 .env，该文件已被 .gitignore 忽略）`);

  const out = { at: new Date().toISOString(), from: addr, chains: [] };

  for (const c of CHAINS) {
    console.log(`\n── ${c.name}  ${c.rpc}`);
    const rec = { net: c.net, chainId: c.id, rpc: c.rpc, scan: c.scan, reachable: false };

    const id = await rpc(c.rpc, 'eth_chainId', []);
    if (id.err) {
      console.log(`  ✗ 不可达：${id.err}`);
      rec.error = id.err; out.chains.push(rec); continue;
    }
    rec.reachable = true;
    rec.chainIdGot = parseInt(id.result, 16);
    console.log(`  ✓ Chain ID ${rec.chainIdGot}${rec.chainIdGot === c.id ? '（与配置一致）' : ' ⚠ 与配置不一致'}`);

    const bn = await rpc(c.rpc, 'eth_blockNumber', []);
    rec.block = bn.result ? parseInt(bn.result, 16) : null;
    const gp = await rpc(c.rpc, 'eth_gasPrice', []);
    rec.gasPriceGwei = gp.result ? Number(BigInt(gp.result) / 1000000000n).toFixed(4) : null;
    console.log(`  ✓ 当前区块 ${rec.block} · gasPrice ${rec.gasPriceGwei} Gwei`);

    if (addr) {
      const bal = await rpc(c.rpc, 'eth_getBalance', [addr, 'latest']);
      rec.balanceWei = bal.result || '0x0';
      rec.balance = ethers ? ethers.formatEther(BigInt(rec.balanceWei)) : String(BigInt(rec.balanceWei));
      const non = await rpc(c.rpc, 'eth_getTransactionCount', [addr, 'latest']);
      rec.nonce = non.result ? parseInt(non.result, 16) : null;
      console.log(`  账户余额 ${rec.balance} · nonce ${rec.nonce}`);
    }

    /* 核心验证：让节点真实执行一遍部署字节码并报价 */
    console.log('  部署交易 estimateGas（节点会真实跑一遍 EVM）：');
    rec.contracts = [];
    for (const t of TARGETS) {
      const fp = path.join(ART_DIR, t.file + '.json');
      if (!fs.existsSync(fp)) { console.log(`    - ${t.name}（无编译产物，跳过）`); continue; }
      const art = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const data = deployData(art, t.args);
      if (!data) { console.log(`    - ${t.name}（缺少 ethers 无法编码构造参数，跳过）`); continue; }
      const g = await rpc(c.rpc, 'eth_estimateGas', [{ from, data }]);
      if (g.err) {
        console.log(`    ✗ ${t.name.padEnd(18)} 被拒绝：${String(g.err).slice(0, 90)}`);
        rec.contracts.push({ name: t.name, ok: false, error: String(g.err).slice(0, 200) });
      } else {
        const gas = parseInt(g.result, 16);
        const cost = rec.gasPriceGwei ? (BigInt(gas) * BigInt(Math.round(Number(rec.gasPriceGwei) * 1e9))) : 0n;
        const costStr = ethers ? ethers.formatEther(cost) : cost.toString();
        console.log(`    ✓ ${t.name.padEnd(18)} gas=${gas}  约 ${Number(costStr).toFixed(6)} BOT`);
        rec.contracts.push({ name: t.name, ok: true, gas, costETH: costStr });
      }
    }
    out.chains.push(rec);
  }

  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'real-tx-readiness.json'), JSON.stringify(out, null, 2));

  console.log('\n══════ 结论 ══════');
  for (const r of out.chains) {
    if (!r.reachable) { console.log(`  ${r.net}：RPC 不可达 → 本环境无法验证/发出真实交易`); continue; }
    const ok = (r.contracts || []).filter(c => c.ok).length;
    const total = (r.contracts || []).length;
    const funded = r.balanceWei && BigInt(r.balanceWei) > 0n;
    console.log(`  ${r.net}：链可达 · 字节码 ${ok}/${total} 被接受${funded ? ' · 账户有余额 → 可以立即发真实交易' : ' · 账户余额为 0 → 领水后即可发真实交易'}`);
  }
  console.log(`\n  报告：${path.join(outDir, 'real-tx-readiness.json')}\n`);
})();
