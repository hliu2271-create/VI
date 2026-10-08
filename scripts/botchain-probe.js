/**
 * BOT Chain RPC 探测 · 部署前确认链参数与 EVM 版本
 * ------------------------------------------------------------
 * 零依赖（Node 18+ 内置 fetch），回答三件事：
 *   1. chainId 是否与配置一致（主网 677 / 测试网 968）
 *   2. 这条链支持到哪个 EVM 版本（决定 solidity 的 evmVersion 该怎么设）
 *   3. 部署账户余额够不够、gasPrice 多少
 *
 * 用法：
 *   node scripts/botchain-probe.js
 *   node scripts/botchain-probe.js --rpc https://rpc.bohr.life            # 测试网
 *   node scripts/botchain-probe.js --addr 0xYourAddress                   # 查余额
 */
const RPC = arg("--rpc") || "https://rpc.botchain.ai";
const ADDR = arg("--addr");
const CHAINS = {
  677: { name: "BOT Chain 主网", scan: "https://scan.botchain.ai", token: "BOT" },
  968: { name: "BOT Chain 测试网 (Bohr)", scan: "https://scan.bohr.life", token: "BOT(test)" },
};
function arg(k) { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; }

let n = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params: params || [] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

(async () => {
  console.log(`\n探测 ${RPC}\n${"-".repeat(52)}`);
  let chainId;
  try {
    chainId = parseInt(await rpc("eth_chainId"), 16);
  } catch (e) {
    console.error("连接失败：", e.message);
    console.error("若公司网络走代理，请在直连环境下运行，或改用 --rpc 指定可达节点。\n");
    process.exit(1);
  }

  const meta = CHAINS[chainId];
  console.log("Chain ID        :", chainId, meta ? `→ ${meta.name}` : "→ ⚠ 非已知 BOT Chain，请核对 RPC");
  if (meta) console.log("区块浏览器      :", meta.scan);

  const [block, gas, bn] = await Promise.all([
    rpc("eth_getBlockByNumber", ["latest", false]),
    rpc("eth_gasPrice"),
    rpc("eth_blockNumber"),
  ]);
  console.log("当前区块        :", parseInt(bn, 16));
  console.log("Gas Price       :", (parseInt(gas, 16) / 1e9).toFixed(4), "Gwei");

  // EVM 版本判定：靠区块头里是否出现各版本新增字段
  const hasBlob = "blobGasUsed" in block || "excessBlobGas" in block;         // Cancun (EIP-4844)
  const hasWithdrawals = "withdrawalsRoot" in block;                          // Shanghai (EIP-4895)
  const hasBaseFee = "baseFeePerGas" in block;                                // London (EIP-1559)
  let evm = "Paris（合并前/合并后基础版）";
  if (hasBlob) evm = "Cancun";
  else if (hasWithdrawals) evm = "Shanghai";
  else if (hasBaseFee) evm = "London";
  console.log("区块头字段      :", [
    hasBaseFee ? "baseFeePerGas(London)" : null,
    hasWithdrawals ? "withdrawalsRoot(Shanghai)" : null,
    hasBlob ? "blobGasUsed(Cancun)" : null,
  ].filter(Boolean).join(" · ") || "仅基础字段");
  console.log("推定 EVM 版本   :", evm);

  const suggest = hasBlob ? "cancun" : (hasWithdrawals ? "shanghai" : "paris");
  console.log("建议 evmVersion :", suggest, `（node scripts/evm-compat-check.js ${suggest}）`);
  if (!hasWithdrawals) console.log("  ⚠ 该链不支持 PUSH0，务必用 paris，否则部署 revert。");

  if (ADDR) {
    const bal = parseInt(await rpc("eth_getBalance", [ADDR, "latest"]), 16) / 1e18;
    console.log("账户余额        :", ADDR, "→", bal.toFixed(4), (meta ? meta.token : ""));
    if (bal < 0.5) console.log("  ⚠ 余额偏低，部署四合约约需 0.1~0.5 BOT；测试网请到 https://faucet.botchain.ai 领水。");
    const nonce = parseInt(await rpc("eth_getTransactionCount", [ADDR, "latest"]), 16);
    console.log("nonce           :", nonce);
  }
  console.log("-".repeat(52), "\n");
})();
