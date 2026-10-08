/* ============================================================
   Aegis 神盾 · 链上接入层（BOT Chain）
   ------------------------------------------------------------
   · BOT Chain 主网 677 / 测试网 968 / Hardhat 本地链 31337
   · 钱包：BO Wallet / MetaMask（EIP-1193），未安装或链不对时引导切换/添加
   · 真实合约调用： register / deposit / buyPolicy / reportViolation
                    / challenge / resolve
   · 未配置合约地址或未连钱包时自动回落「演示模式」，不影响既有演示
   ethers 从随包本地模块加载（失败即保持演示模式）
   ============================================================ */

const NETWORKS = {
  botchain: { id: 677, name: "BOT Chain 主网", rpc: "https://rpc.botchain.ai", scan: "https://scan.botchain.ai", symbol: "BOT" },
  bohr: { id: 968, name: "BOT Chain 测试网", rpc: "https://rpc.bohr.life", scan: "https://scan.bohr.life", symbol: "BOT" },
  localhost: { id: 31337, name: "Hardhat 本地链", rpc: "http://127.0.0.1:8545", scan: "", symbol: "ETH" },
};

/* IV compiled ABI: functions and events. */
const ABI = {"registry":[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"operator","type":"address"},{"indexed":false,"internalType":"uint64","name":"at","type":"uint64"}],"name":"Heartbeat","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"operator","type":"address"},{"indexed":false,"internalType":"bool","name":"up","type":"bool"},{"indexed":false,"internalType":"uint32","name":"uptime","type":"uint32"},{"indexed":false,"internalType":"uint32","name":"downtime","type":"uint32"}],"name":"HeartbeatReported","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"operator","type":"address"},{"indexed":false,"internalType":"uint256","name":"stake","type":"uint256"}],"name":"NodeRegistered","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"operator","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"},{"indexed":false,"internalType":"string","name":"reason","type":"string"}],"name":"NodeSlashed","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"oldReporter","type":"address"},{"indexed":true,"internalType":"address","name":"newReporter","type":"address"}],"name":"ReporterUpdated","type":"event"},{"inputs":[],"name":"MIN_STAKE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"admin","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"core","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"heartbeat","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"node","type":"address"}],"name":"isRegistered","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"nodeList","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"nodeListLength","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"nodes","outputs":[{"internalType":"uint256","name":"stake","type":"uint256"},{"internalType":"uint64","name":"lastHeartbeat","type":"uint64"},{"internalType":"uint32","name":"uptimeReports","type":"uint32"},{"internalType":"uint32","name":"downtimeReports","type":"uint32"},{"internalType":"bool","name":"registered","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"register","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"node","type":"address"},{"internalType":"bool","name":"up","type":"bool"}],"name":"reportHeartbeat","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"reporter","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"c","type":"address"}],"name":"setCore","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"r","type":"address"}],"name":"setReporter","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"node","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"string","name":"reason","type":"string"}],"name":"slash","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"node","type":"address"}],"name":"stakeOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}],"pool":[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"policyId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"CapitalReleased","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"policyId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"CapitalReserved","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"oldCore","type":"address"},{"indexed":true,"internalType":"address","name":"newCore","type":"address"}],"name":"CoreUpdated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"lp","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"LPDeposit","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"lp","type":"address"},{"indexed":true,"internalType":"address","name":"recipient","type":"address"},{"indexed":false,"internalType":"uint256","name":"shares","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"LPWithdrawal","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"policyId","type":"uint256"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"Payout","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"policyId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"PremiumIncome","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"policyId","type":"uint256"},{"indexed":true,"internalType":"address","name":"payer","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"PremiumRefund","type":"event"},{"inputs":[],"name":"SHARE_DECIMALS","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"VIRTUAL_ASSETS","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"VIRTUAL_SHARES","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"addPremium","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"admin","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"availableCapital","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"address","name":"payer","type":"address"}],"name":"cancel","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"core","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"minShares","type":"uint256"}],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"lp","type":"address"}],"name":"deposits","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"lpCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"pay","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"pendingPremium","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"assets","type":"uint256"}],"name":"previewDeposit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"units","type":"uint256"}],"name":"previewRedeem","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"refundLiability","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"refunds","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"release","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"reservations","outputs":[{"internalType":"uint256","name":"coverage","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"bool","name":"created","type":"bool"},{"internalType":"bool","name":"settled","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"reserve","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"reservedCoverage","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"c","type":"address"}],"name":"setCore","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"shares","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalAssets","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalDeposits","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalPayout","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalPremiumIncome","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalShares","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"units","type":"uint256"},{"internalType":"address payable","name":"recipient","type":"address"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address payable","name":"to","type":"address"}],"name":"withdrawRefund","outputs":[],"stateMutability":"nonpayable","type":"function"}],"ai":[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"policyId","type":"uint256"},{"indexed":false,"internalType":"bool","name":"approve","type":"bool"},{"indexed":false,"internalType":"string","name":"reason","type":"string"}],"name":"ClaimAudited","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"node","type":"address"},{"indexed":false,"internalType":"uint256","name":"score","type":"uint256"}],"name":"RiskScoreUpdated","type":"event"},{"inputs":[],"name":"admin","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"},{"internalType":"uint256","name":"downtimeSeconds","type":"uint256"},{"internalType":"uint256","name":"slaSeconds","type":"uint256"},{"internalType":"bool","name":"challenged","type":"bool"}],"name":"auditClaim","outputs":[{"internalType":"bool","name":"approve","type":"bool"},{"internalType":"string","name":"reason","type":"string"}],"stateMutability":"pure","type":"function"},{"inputs":[{"internalType":"uint256","name":"coverage","type":"uint256"},{"internalType":"uint256","name":"riskScore","type":"uint256"}],"name":"quotePremium","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"pure","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"riskScoreOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"node","type":"address"},{"internalType":"uint256","name":"score","type":"uint256"}],"name":"setRiskScore","outputs":[],"stateMutability":"nonpayable","type":"function"}],"core":[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":false,"internalType":"bool","name":"approved","type":"bool"},{"indexed":false,"internalType":"bytes32","name":"decisionHash","type":"bytes32"}],"name":"Adjudicated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"reporter","type":"address"},{"indexed":true,"internalType":"address","name":"arbiter","type":"address"}],"name":"AuthoritiesBound","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"oldSeconds","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"newSeconds","type":"uint256"}],"name":"ChallengeWindowUpdated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":true,"internalType":"address","name":"challenger","type":"address"},{"indexed":false,"internalType":"string","name":"reason","type":"string"}],"name":"Challenged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":false,"internalType":"bytes32","name":"evidenceHash","type":"bytes32"},{"indexed":true,"internalType":"address","name":"reporter","type":"address"}],"name":"EvidenceConfirmed","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":true,"internalType":"address","name":"payer","type":"address"},{"indexed":false,"internalType":"uint32","name":"downtimeSeconds","type":"uint32"}],"name":"IncidentRequested","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":true,"internalType":"address","name":"payer","type":"address"},{"indexed":true,"internalType":"address","name":"node","type":"address"},{"indexed":false,"internalType":"uint256","name":"coverage","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"premium","type":"uint256"},{"indexed":false,"internalType":"uint32","name":"slaSeconds","type":"uint32"},{"indexed":false,"internalType":"uint32","name":"durationSeconds","type":"uint32"}],"name":"PolicyCreated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"}],"name":"PolicyExpired","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":false,"internalType":"enum ComputeShieldCore.Status","name":"status","type":"uint8"},{"indexed":false,"internalType":"bool","name":"paid","type":"bool"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"},{"indexed":false,"internalType":"string","name":"reason","type":"string"}],"name":"PolicyResolved","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"id","type":"uint256"},{"indexed":false,"internalType":"uint32","name":"downtimeSeconds","type":"uint32"},{"indexed":false,"internalType":"uint64","name":"challengeDeadline","type":"uint64"}],"name":"ViolationReported","type":"event"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"bool","name":"approve","type":"bool"},{"internalType":"bytes32","name":"digest","type":"bytes32"}],"name":"adjudicate","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"adjudication","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"admin","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"aiAudit","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"aiPricing","outputs":[{"internalType":"contract IAIPricing","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"arbiter","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"arbitrationDeadline","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"arbitrationWindow","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"node","type":"address"},{"internalType":"uint256","name":"coverage","type":"uint256"},{"internalType":"uint32","name":"duration","type":"uint32"},{"internalType":"uint32","name":"slaSeconds","type":"uint32"}],"name":"buyPolicy","outputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"string","name":"reason","type":"string"}],"name":"challenge","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"challengeDeadline","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"challengeWindow","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"closeUnresolved","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"uint32","name":"downtimeSeconds","type":"uint32"},{"internalType":"bytes32","name":"digest","type":"bytes32"}],"name":"confirmViolation","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"decisionHash","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"evidenceHash","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"evidenceReporter","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"expire","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"getPolicy","outputs":[{"components":[{"internalType":"address","name":"payer","type":"address"},{"internalType":"address","name":"node","type":"address"},{"internalType":"uint256","name":"coverage","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"uint64","name":"start","type":"uint64"},{"internalType":"uint64","name":"end","type":"uint64"},{"internalType":"uint64","name":"triggerAt","type":"uint64"},{"internalType":"uint32","name":"slaSeconds","type":"uint32"},{"internalType":"uint32","name":"downtimeSeconds","type":"uint32"},{"internalType":"enum ComputeShieldCore.Status","name":"status","type":"uint8"}],"internalType":"struct ComputeShieldCore.Policy","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"incidentRequests","outputs":[{"internalType":"uint32","name":"","type":"uint32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"nextPolicyId","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"policies","outputs":[{"internalType":"address","name":"payer","type":"address"},{"internalType":"address","name":"node","type":"address"},{"internalType":"uint256","name":"coverage","type":"uint256"},{"internalType":"uint256","name":"premium","type":"uint256"},{"internalType":"uint64","name":"start","type":"uint64"},{"internalType":"uint64","name":"end","type":"uint64"},{"internalType":"uint64","name":"triggerAt","type":"uint64"},{"internalType":"uint32","name":"slaSeconds","type":"uint32"},{"internalType":"uint32","name":"downtimeSeconds","type":"uint32"},{"internalType":"enum ComputeShieldCore.Status","name":"status","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"policyCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"pool","outputs":[{"internalType":"contract IRiskPool","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"protocolVersion","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"pure","type":"function"},{"inputs":[],"name":"registry","outputs":[{"internalType":"contract INodeRegistry","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"uint32","name":"downtimeSeconds","type":"uint32"}],"name":"reportViolation","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"}],"name":"resolve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"id","type":"uint256"},{"internalType":"address","name":"recipient","type":"address"}],"name":"resolveTo","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"reporter_","type":"address"},{"internalType":"address","name":"arbiter_","type":"address"}],"name":"setAuthorities","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"seconds_","type":"uint256"}],"name":"setChallengeWindow","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"slashBps","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]};

const CHAIN = {
  net: "bohr",
  addr: { core: "", pool: "", registry: "", ai: "" },
  account: null, chainId: null, mode: "demo",
  _ethers: null, _provider: null, _signer: null, _c: null,
  listeners: [],
  verifiedKey: null, verificationError: "",
  key() { return JSON.stringify([this.account,this.chainId,this.net,this.addr]); },
  onChange(fn) { this.listeners.push(fn); },
  _emit() { this.listeners.forEach(f => { try { f(); } catch (e) { } }); },
  netCfg() { return NETWORKS[this.net] || NETWORKS.bohr; },
  short(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; },
  explorerTx(h) { const s = this.netCfg().scan; return s ? s + "/tx/" + h : ""; },
  explorerAddr(a) { const s = this.netCfg().scan; return s ? s + "/address/" + a : ""; },

  /* ---------- 配置持久化 ---------- */
  load() {
    try {
      const j = JSON.parse(localStorage.getItem("aegis.chain") || "{}");
      if (j.net && NETWORKS[j.net]) this.net = j.net;
      Object.keys(this.addr).forEach(k => { if (j.addr && j.addr[k]) this.addr[k] = j.addr[k]; });
    } catch (e) { }
    this.refresh();
    return this;
  },
  save(net, addr) {
    if (net && NETWORKS[net]) this.net = net;
    Object.keys(this.addr).forEach(k => { if (addr && addr[k] != null) this.addr[k] = String(addr[k]).trim(); });
    try { localStorage.setItem("aegis.chain", JSON.stringify({ net: this.net, addr: this.addr })); } catch (e) { }
    this._c = null; this.verifiedKey = null;
    this.refresh();
    if (this.account) this.verifyContracts().catch(() => {});
    return this;
  },
  configured() { return Object.values(this.addr).every(a => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)); },
  refresh() {
    this.mode = (this.account && this.configured() && this.chainId === this.netCfg().id && this.verifiedKey === this.key()) ? "chain" : "demo";
    this._emit();
  },

  async verifyContracts() {
    const key = this.key(), account=this.account, addr={...this.addr}, chainId=this.chainId; this.verifiedKey = null; this.verificationError = ''; this.refresh();
    if (!this.account || !this.configured() || this.chainId !== this.netCfg().id) return false;
    try {
      const E = await this.ethers(); const provider = new E.BrowserProvider(this.inject());
      const actualNetwork = await provider.getNetwork();
      if (Number(actualNetwork.chainId) !== chainId) throw Error('钱包网络已变化，请重新连接');
      const signer = await provider.getSigner(account);
      const codes = await Promise.all(Object.values(addr).map(a => provider.getCode(a)));
      if (codes.some(code => code === '0x')) throw Error('配置地址未发现合约字节码');
      const core = new E.Contract(addr.core,ABI.core,provider), pool = new E.Contract(addr.pool,ABI.pool,provider), registry = new E.Contract(addr.registry,ABI.registry,provider);
      const [version,poolAddress,registryAddress,pricingAddress,poolCore,registryCore,reporter,arbiter] = await Promise.all([core.protocolVersion(),core.pool(),core.registry(),core.aiPricing(),pool.core(),registry.core(),core.evidenceReporter(),core.arbiter()]);
      const equal=(x,y)=>x.toLowerCase()===y.toLowerCase();
      if (Number(version)!==4 || !equal(poolAddress,addr.pool) || !equal(registryAddress,addr.registry) || !equal(pricingAddress,addr.ai) || !equal(poolCore,addr.core) || !equal(registryCore,addr.core) || reporter===E.ZeroAddress || arbiter===E.ZeroAddress || equal(reporter,arbiter)) throw Error('合约版本、绑定关系或证据角色不匹配');
      if (this.key()!==key) return false;
      this._provider=provider; this._signer=signer; this.verifiedKey=key; this._c=null; this.refresh(); return true;
    } catch(error) { if (this.key()===key) {this.verificationError=error.shortMessage||error.message;this.refresh();} return false; }
  },

  /* ---------- ethers 按需加载 ---------- */
  async ethers() {
    if (this._ethers) return this._ethers;
    const urls = [new URL("vendor/ethers.min.js", location.href).href];
    for (const u of urls) {
      try { const m = await import(u); this._ethers = m; return m; } catch (e) { }
    }
    return null;
  },
  inject() {
    let p = window.ethereum;
    if (!p && window.bitkeep && window.bitkeep.ethereum) p = window.bitkeep.ethereum;   // BO Wallet / Bitget 系
    if (!p && Array.isArray(window.ethereum && window.ethereum.providers)) p = window.ethereum.providers[0];
    return p || null;
  },

  /* ---------- 连接钱包 ---------- */
  async connect() {
    const E = await this.ethers();
    if (!E) throw new Error("ethers 加载失败（离线？），已保持演示模式");
    const p = this.inject();
    if (!p) throw new Error("未检测到钱包，请安装 BO Wallet 或 MetaMask");
    const accounts = await p.request({ method: "eth_requestAccounts" });
    this.account = accounts[0];
    this._provider = new E.BrowserProvider(p);
    this._signer = await this._provider.getSigner();
    const net = await this._provider.getNetwork();
    this.chainId = Number(net.chainId);
    const want = this.netCfg().id;
    if (this.chainId !== want) await this.switchTo(want);
    this._c = null;
    await this.verifyContracts();
    return this.account;
  },
  async switchTo(id) {
    const p = this.inject(); if (!p) return;
    const cfg = Object.values(NETWORKS).find(n => n.id === id);
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + id.toString(16) }] });
    } catch (e) {
      const code = e && (e.code === 4902 || e.code === -32603 || /Unrecognized chain/i.test(e.message || ""));
      if (code && cfg) {
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x" + id.toString(16), chainName: cfg.name,
            rpcUrls: [cfg.rpc], nativeCurrency: { name: cfg.symbol, symbol: cfg.symbol, decimals: 18 },
            blockExplorerUrls: cfg.scan ? [cfg.scan] : [],
          }],
        });
      } else throw e;
    }
    this._provider = new this._ethers.BrowserProvider(p);
    this._signer = await this._provider.getSigner(this.account);
    const net = await this._provider.getNetwork();
    this.chainId = Number(net.chainId);
  },
  async balance() {
    if (!this.account || !this._provider) return null;
    const b = await this._provider.getBalance(this.account);
    const E = this._ethers;
    return Number(E.formatEther(b));
  },

  /* ---------- 合约实例 ---------- */
  async contracts() {
    if (this.mode!=="chain" || this.verifiedKey!==this.key()) throw new Error("请先校验 IV 合约与网络");
    if (this._c) return this._c;
    const key=this.key(), E = await this.ethers();
    if(this.mode!=="chain"||this.verifiedKey!==key||this.key()!==key)throw Error("钱包状态已变化，请重新校验");
    if (!E || !this._signer) throw new Error("钱包未连接");
    if (!this.configured()) throw new Error("合约地址未配置");
    this._c = {
      core: new E.Contract(this.addr.core, ABI.core, this._signer),
      pool: new E.Contract(this.addr.pool, ABI.pool, this._signer),
      registry: new E.Contract(this.addr.registry, ABI.registry, this._signer),
      ai: this.addr.ai ? new E.Contract(this.addr.ai, ABI.ai, this._signer) : null,
    };
    return this._c;
  },
  async wait(t, label) {
    const r = await t.wait();
    return { hash: t.hash, receipt: r, label, gas: Number(r.gasUsed || 0) };
  },
  /* 从回执里解出保单号（PolicyCreated 事件） */
  policyIdFromReceipt(receipt) {
    try {
      const E = this._ethers, iface = new E.Interface(ABI.core);
      for (const l of receipt.logs || []) {
        try { const p = iface.parseLog(l); if (p && p.name === "PolicyCreated") return Number(p.args.id); } catch (e) { }
      }
    } catch (e) { }
    return null;
  },
  async riskOf(nodeAddr) {
    const c = await this.contracts();
    if (!c.ai) return null;
    try { return Number(await c.ai.riskScoreOf(nodeAddr)); } catch (e) { return null; }
  },

  /* ---------- 写操作 ---------- */
  async register(stakeBOT) {
    const c = await this.contracts(), E = this._ethers;
    const tx = await c.registry.register({ value: E.parseEther(String(stakeBOT)) });
    return this.wait(tx, "NodeRegistry.register");
  },
  async deposit(amtBOT) {
    const c = await this.contracts(), E = this._ethers;
    const assets=E.parseEther(String(amtBOT));
    const minimum=await c.pool.previewDeposit(assets);
    if(minimum===0n)throw Error("存入金额无法生成有效份额");
    const tx = await c.pool["deposit(uint256)"](minimum,{ value: assets });
    return this.wait(tx, "RiskPool.deposit");
  },
  async quote(coverage, risk) {
    const c = await this.contracts(), E = this._ethers;
    if (!c.ai) return null;
    const v = await c.ai.quotePremium(E.parseEther(String(coverage)), risk);
    return Number(E.formatEther(v));
  },
  async buyPolicy(nodeAddr, coverage, duration, sla, premium) {
    const c = await this.contracts(), E = this._ethers;
    const tx = await c.core.buyPolicy(nodeAddr, E.parseEther(String(coverage)), duration, sla, { value: E.parseEther(String(premium)) });
    return this.wait(tx, "ComputeShieldCore.buyPolicy");
  },
  async reportViolation(id, downtime) {
    const c = await this.contracts();
    const tx = await c.core.reportViolation(id, downtime);
    return this.wait(tx, "Core.reportViolation");
  },
  async challenge(id, reason) {
    const c = await this.contracts();
    const tx = await c.core.challenge(id, reason);
    return this.wait(tx, "Core.challenge");
  },
  async resolve(id) {
    const c = await this.contracts();
    const tx = await c.core.resolve(id);
    return this.wait(tx, "Core.resolve");
  },

  async withdraw(units) {const c=await this.contracts();return this.wait(await c.pool.withdraw(this._ethers.parseUnits(String(units),27),this.account),'RiskPool.withdraw');},
  async confirmViolation(id,seconds,digest) {const c=await this.contracts();return this.wait(await c.core.confirmViolation(id,seconds,digest),'Core.confirmViolation');},
  async adjudicate(id,approve,digest) {const c=await this.contracts();return this.wait(await c.core.adjudicate(id,approve,digest),'Core.adjudicate');},
  async expirePolicy(id) {const c=await this.contracts();return this.wait(await c.core.expire(id),'Core.expire');},
  async closeUnresolved(id) {const c=await this.contracts();return this.wait(await c.core.closeUnresolved(id),'Core.closeUnresolved');},
  async withdrawRefund() {const c=await this.contracts();return this.wait(await c.pool.withdrawRefund(this.account),'RiskPool.withdrawRefund');},
  async policyState(id) {const c=await this.contracts();const [p,deadline]=await Promise.all([c.core.getPolicy(id),c.core.challengeDeadline(id)]);return {status:['None','Active','Triggered','Challenged','Paid','Rejected','Expired'][Number(p.status)],deadline:Number(deadline),payer:p.payer};},
  /* ---------- 读操作 ---------- */
  async readState() {
    const c = await this.contracts(), E = this._ethers;
    const [dep, prem, pay, win, cnt, reserved, free, shares, pending, refund] = await Promise.all([
      c.pool.totalDeposits(), c.pool.totalPremiumIncome(), c.pool.totalPayout(),
      c.core.challengeWindow(), c.core.policyCount(),c.pool.reservedCoverage(),c.pool.availableCapital(),c.pool.shares(this.account),c.pool.pendingPremium(),c.pool.refunds(this.account),
    ]);
    return {
      deposits: Number(E.formatEther(dep)), premium: Number(E.formatEther(prem)),
      payout: Number(E.formatEther(pay)), window: Number(win), policies: Number(cnt),reserved:Number(E.formatEther(reserved)),free:Number(E.formatEther(free)),shares:E.formatUnits(shares,27),pending:Number(E.formatEther(pending)),refund:E.formatEther(refund),
    };
  },
};
CHAIN.load();
if (typeof window !== "undefined") {
  const inj = CHAIN.inject();
  if (inj) {
    inj.on && inj.on("accountsChanged", (a) => { CHAIN.account = a[0] || null; CHAIN._c = null; CHAIN.verifiedKey=null; CHAIN.refresh(); CHAIN.verifyContracts().catch(()=>{}); });
    inj.on && inj.on("chainChanged", (h) => { CHAIN.chainId = parseInt(h, 16); CHAIN._c = null; CHAIN.verifiedKey=null; CHAIN.refresh(); CHAIN.verifyContracts().catch(()=>{}); });
  }
}
