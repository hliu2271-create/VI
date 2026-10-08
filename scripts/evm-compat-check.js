/**
 * BOT Chain 部署前自检 · EVM 兼容性 + 合约体积
 * ------------------------------------------------------------
 * 为什么需要它：Solidity 0.8.26 默认 evmVersion = cancun，编译器可能产出
 * PUSH0 / MCOPY / TSTORE 等新 opcode。若目标链 EVM 版本低于 Shanghai/Cancun，
 * 部署会直接 revert。「5 分钟迁移」最容易踩的就是这个坑。
 *
 * 判据：以编译器 evmVersion 为准（solc 保证不会产出高于该版本的 opcode），
 *       不做字节码文本扫描 —— 字符串常量里的字节会被误判成 opcode（例如
 *       revert 字符串 "AI downtime exceeded" 中的 0x49 会被读成 BLOBHASH）。
 *
 * 用法：
 *   node scripts/evm-compat-check.js            # 默认 paris（最保守）
 *   node scripts/evm-compat-check.js shanghai   # 目标链确认支持 PUSH0 时用
 *   node scripts/evm-compat-check.js cancun
 */
const fs = require("fs");
const path = require("path");

const CONTRACTS = ["NodeRegistry.sol", "RiskPool.sol", "AIReporterMock.sol", "ComputeShieldCore.sol"];
const DIR = path.join(__dirname, "..", "contracts");
const EVM = (process.argv[2] || process.env.EVM_VERSION || "paris").toLowerCase();

// 各 EVM 版本新增的 opcode（设成该版本即可能产出）
const NEW_OPS = {
  paris: [],
  shanghai: ["PUSH0"],
  cancun: ["PUSH0", "MCOPY", "TLOAD", "TSTORE", "BLOBHASH", "BLOBBASEFEE"],
};
const EVM_DESC = {
  paris: "合并后版本，无 PUSH0 —— 兼容性最好，gas 略高",
  shanghai: "引入 PUSH0，需节点 ≥ Shanghai",
  cancun: "引入 MCOPY/TSTORE/blob 系列，需节点 ≥ Cancun（多数新公链默认）",
};

let solc;
try { solc = require("solc"); }
catch (e) {
  console.error("未找到 solc，请先安装： npm i -D solc@0.8.26   （或 npx --yes solc@0.8.26）");
  process.exit(1);
}
if (!NEW_OPS[EVM]) {
  console.error("不支持的 evmVersion：" + EVM + "，可选 paris / shanghai / cancun");
  process.exit(1);
}

const sources = {};
CONTRACTS.forEach(f => { sources[f] = { content: fs.readFileSync(path.join(DIR, f), "utf8") }; });

const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: EVM,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
})));

let failed = false;
(out.errors || []).forEach(e => {
  console.error(e.formattedMessage.trim());
  if (e.severity === "error") failed = true;
});
if (failed) process.exit(1);

console.log(`\n编译器 ${solc.version()}  ·  evmVersion = ${EVM}  （${EVM_DESC[EVM]}）\n`);
console.log("合约".padEnd(22), "部署字节码", "  EIP-170 上限 24576B");
console.log("-".repeat(64));

let maxSize = 0;
for (const [, cs] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(cs)) {
    const size = c.evm.bytecode.object.length / 2;
    if (!size) continue;                       // 接口（interface）无字节码
    maxSize = Math.max(maxSize, size);
    const bar = "█".repeat(Math.round(size / 24576 * 20)) || "▏";
    const ok = size <= 24576;
    if (!ok) failed = true;
    console.log(name.padEnd(24), String(size).padStart(6) + " B", " ", bar, ok ? "" : "❌ 超限");
  }
}
console.log("-".repeat(64));
console.log(`最大合约 ${maxSize} B / 24576 B（${(maxSize / 24576 * 100).toFixed(1)}%）`);

const ops = NEW_OPS[EVM];
if (ops.length) {
  console.log(`\n⚠ 该版本可能产出：${ops.join("、")}`);
  console.log("  若 BOT Chain 节点 EVM 版本更低，部署会 revert（常见报错：invalid opcode / execution reverted）。");
  console.log("  稳妥做法：node scripts/botchain-probe.js 先探测目标链，再决定 evmVersion。");
} else {
  console.log("\n✅ 不含 PUSH0/MCOPY/TSTORE/BLOBHASH，可在任意 ≥ Paris 的 EVM 上部署（最保守选择）。");
}
console.log("  提示：先在 scripts/botchain-probe.js 确认链的 EVM 版本；若为 Cancun，可改 shanghai/cancun 省 gas。\n");
process.exit(failed ? 1 : 0);
