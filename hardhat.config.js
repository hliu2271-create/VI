/* hardhat 生态（toolbox / ethers 插件）装在本工程时直接 require；
   未 npm install 时回落到靶机工程 insure-target 的 node_modules，
   让 npm run real-tx:local / deploy:* 开箱可用（配 NODE_PATH 在 Windows 下不可靠）。 */
const path = require("path");
const tryRequire = (id) => {
  const dirs = [path.join(__dirname, "node_modules"), path.join(__dirname, "..", "insure-target", "node_modules")];
  for (const d of dirs) { try { return require(path.join(d, id)); } catch (e) { } }
  return require(id);   // 最后交给常规解析（NODE_PATH 等），失败则如实报错
};
tryRequire("@nomicfoundation/hardhat-ethers");

/**
 * BOT Chain 网络参数（官方 dev-docs 实测）
 *   主网   Chain ID 677 · RPC https://rpc.botchain.ai       · 浏览器 https://scan.botchain.ai
 *   测试网 Chain ID 968 · RPC https://rpc.bohr.life         · 浏览器 https://scan.bohr.life
 *   原生代币 BOT（总量 1.5 亿），Geth 兼容 JSON-RPC，Hardhat/ethers 直接可用。
 *
 * 部署：
 *   export PRIVATE_KEY=0x...
 *   node scripts/botchain-probe.js --addr $(你的地址)      # 先探测链与余额
 *   node scripts/evm-compat-check.js paris                 # 再确认 EVM 兼容
 *   npx hardhat run scripts/deploy.js --network botchain   # 主网
 *   npx hardhat run scripts/deploy.js --network bohr       # 测试网
 */
const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // BOT Chain 官方未公开 EVM 硬分叉版本，取最保守的 paris：
      // 编译器保证不产出 PUSH0/MCOPY/TSTORE，规避「invalid opcode」部署失败。
      // 用 scripts/botchain-probe.js 确认目标链支持 Shanghai/Cancun 后，可改成 shanghai 省 gas。
      evmVersion: "paris",
    },
  },
  networks: {
    // BOT Chain 主网
    botchain: {
      url: "https://rpc.botchain.ai",
      chainId: 677,
      accounts: PK,
      timeout: 60000,
    },
    // BOT Chain 测试网（Bohr），faucet: https://faucet.botchain.ai
    bohr: {
      url: "https://rpc.bohr.life",
      chainId: 968,
      accounts: PK,
      timeout: 60000,
      gasPrice: 2000000000,   // 2 Gwei，测试网默认 gasPrice 波动大，显式给值避免卡单
    },
    hardhat: {
      // 本地演示：区块时间 1s，方便用 evm_increaseTime 快进 24h 挑战窗口
      chainId: 31337,
    },
  },
  etherscan: {
    // 可选：部署后 npx hardhat verify --network botchain <addr>
    apiKey: { botchain: "not-needed" },
    customChains: [
      {
        network: "botchain",
        chainId: 677,
        urls: { apiURL: "https://scan.botchain.ai/api", browserURL: "https://scan.botchain.ai" },
      },
      {
        network: "bohr",
        chainId: 968,
        urls: { apiURL: "https://scan.bohr.life/api", browserURL: "https://scan.bohr.life" },
      },
    ],
  },
};
