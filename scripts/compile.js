/**
 * 免 Hardhat 编译 · 用 solc 直接产出 BOT Chain 可部署产物
 * ------------------------------------------------------------
 * 为什么单独准备它：环境里不一定装得下 hardhat 全套依赖，而黑客松现场
 * 常常只需要「快速产出 ABI + bytecode」。本脚本与 hardhat.config.js 的
 * solidity 设置保持一致（0.8.26 / optimizer 200 / evmVersion paris）。
 *
 * 用法：
 *   npm i -D solc@0.8.26      （或 NODE_PATH 指向已有 solc）
 *   node scripts/compile.js
 * 产物：artifacts/<Contract>.json  { abi, bytecode, deployedBytecode, compiler, evmVersion }
 */
const fs = require("fs");
const path = require("path");

const EVM = process.env.EVM_VERSION || "paris";
const DIR = path.join(__dirname, "..", "contracts");
const OUT = path.join(__dirname, "..", "artifacts");
const FILES = ["NodeRegistry.sol", "RiskPool.sol", "AIReporterMock.sol", "ComputeShieldCore.sol"];

let solc;
try { solc = require("solc"); }
catch (e) { console.error("未找到 solc：npm i -D solc@0.8.26"); process.exit(1); }
if (!solc.version().startsWith('0.8.26+')) { console.error('需要精确版本 solc 0.8.26，当前：' + solc.version()); process.exit(1); }

const sources = {};
FILES.forEach(f => { sources[f] = { content: fs.readFileSync(path.join(DIR, f), "utf8") }; });

const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: EVM,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
})));

let failed = false;
(out.errors || []).forEach(e => {
  console.error(e.formattedMessage.trim());
  if (e.severity === "error") failed = true;
});
if (failed) process.exit(1);

fs.mkdirSync(OUT, { recursive: true });
console.log(`\n编译器 ${solc.version()} · evmVersion ${EVM}\n`);

for (const [, cs] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(cs)) {
    const bc = c.evm.bytecode.object;
    if (!bc) continue;                     // interface 无字节码
    const size = bc.length / 2;
    fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify({
      contractName: name,
      abi: c.abi,
      bytecode: "0x" + bc,
      deployedBytecode: "0x" + c.evm.deployedBytecode.object,
      compiler: solc.version(),
      evmVersion: EVM,
      target: "BOT Chain (mainnet 677 / testnet 968)",
    }, null, 2));
    console.log(`  ${name.padEnd(20)} ${String(size).padStart(6)} B  → artifacts/${name}.json`);
  }
}
console.log(`\n编译完成（evmVersion=${EVM}）。编译产物不代表目标链已部署。\n`);
