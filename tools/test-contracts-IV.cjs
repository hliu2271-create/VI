/* Isolated in-process EVM. Never connects to a public RPC or uses a funded wallet. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');process.env.HARDHAT_CONFIG=path.join(__dirname,'hardhat-IV.config.cjs');
const solc=require('solc'),E=require('ethers');
const report={version:'IV',kind:'local-contract-verification',status:'running',createdAt:new Date().toISOString(),network:'in-process Hardhat',chainId:31337,checks:[],txs:[],sourceHashes:{}};
report.compiler=solc.version();
assert(report.compiler.startsWith('0.8.26+'),'Verification requires exact solc 0.8.26');
const sources={};for(const name of fs.readdirSync(path.join(root,'contracts')).filter(n=>n.endsWith('.sol'))){const content=fs.readFileSync(path.join(root,'contracts',name),'utf8');sources[name]={content};report.sourceHashes[name]=crypto.createHash('sha256').update(content).digest('hex')}
sources['TestReceiver.sol']={content:`pragma solidity ^0.8.20;
interface IP { function deposit() external payable; function withdraw(uint256,address payable) external; function shares(address) external view returns(uint256); }
contract TestReceiver { IP public pool; bool public attempt; bool public blocked; constructor(address p){pool=IP(p);} function fund() external payable {pool.deposit{value:msg.value}();} function exit(uint256 n) external {attempt=true;pool.withdraw(n,payable(address(this)));} receive() external payable {if(attempt){attempt=false;try pool.withdraw(1,payable(address(this))){}catch{blocked=true;}}} }`};
const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
let provider;
async function tx(name,promise){const r=await(await promise).wait();report.txs.push({step:name,hash:r.hash,blockNumber:r.blockNumber,status:r.status===1?'SUCCESS':'FAILED',gasUsed:String(r.gasUsed)});return r}
function check(name,condition){assert(condition,name);report.checks.push(name)}
async function rejected(name,fn,reason){let bad=false;try{await(await fn()).wait()}catch(error){bad=true;if(reason)assert(String(error).includes(reason),name+': unexpected revert: '+error)}check(name,bad)}
async function tick(seconds){await provider.send('evm_increaseTime',[seconds]);await provider.send('evm_mine',[])}
(async()=>{try{
 const errors=(out.errors||[]).filter(e=>e.severity==='error');assert.equal(errors.length,0,errors.map(e=>e.formattedMessage).join('\n'));
 const poolABI=out.contracts['RiskPool.sol'].RiskPool.abi;
 assert(poolABI.some(x=>x.name==='withdraw'),'RiskPool must support bounded LP withdrawal');
 assert(poolABI.some(x=>x.name==='reservedCoverage'),'RiskPool must reserve aggregate policy coverage');
 const hre=require('hardhat');provider=new E.BrowserProvider(hre.network.provider,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
 const accounts=await Promise.all(Array.from({length:9},(_,i)=>provider.getSigner(i)));const [admin,lp,node,buyer,reporter,arbiter,stranger,lp2]=accounts;
 const addresses=await Promise.all(accounts.map(a=>a.getAddress()));const [A,L,N,B,R,J,O,L2]=addresses;
 const artifact=n=>Object.values(out.contracts).find(c=>c[n])?.[n];
 async function deploy(n,args=[]){const art=artifact(n),c=await new E.ContractFactory(art.abi,'0x'+art.evm.bytecode.object,admin).deploy(...args);await c.waitForDeployment();await tx('deploy '+n,Promise.resolve(c.deploymentTransaction()));return c}
 const registry=await deploy('NodeRegistry'),pool=await deploy('RiskPool'),pricing=await deploy('AIReporterMock');
 const core=await deploy('ComputeShieldCore',[await registry.getAddress(),await pool.getAddress(),await pricing.getAddress(),await pricing.getAddress()]);
 report.contracts={NodeRegistry:await registry.getAddress(),RiskPool:await pool.getAddress(),AIReporter:await pricing.getAddress(),ComputeShieldCore:await core.getAddress()};
 await tx('bind registry',registry.setCore(await core.getAddress()));await tx('bind pool',pool.setCore(await core.getAddress()));
 await tx('set distinct evidence reporter and arbitrator',core.setAuthorities(R,J));
 await rejected('Authorities cannot be silently replaced',()=>core.setAuthorities(O,J));
 await rejected('Pool core cannot be replaced after binding',()=>pool.setCore(O));
 await tx('LP deposit',pool.connect(lp)['deposit()']({value:E.parseEther('1000')}));
 check('Initial LP shares use twenty-seven decimal precision',await pool.shares(L)===E.parseUnits('1000',27));
 check('Initial deposit preview matches minted shares',await pool.previewDeposit(E.parseEther('1'))===E.parseUnits('1',27));
 await rejected('Zero deposits rejected',()=>pool.connect(lp)['deposit()']({value:0n}),'zero deposit');
 const protectedQuote=await pool.previewDeposit(10n),beforeProtectedAssets=await pool.totalDeposits(),beforeProtectedShares=await pool.shares(O);
 await rejected('Minimum-share deposit prevents slippage',()=>pool.connect(stranger)['deposit(uint256)'](protectedQuote+1n,{value:10n}),'deposit slippage');
 check('Failed slippage deposit leaves assets and shares unchanged',await pool.totalDeposits()===beforeProtectedAssets&&await pool.shares(O)===beforeProtectedShares);
 await tx('Protected deposit accepts exact share quote',pool.connect(stranger)['deposit(uint256)'](protectedQuote,{value:10n}));
 check('Protected deposit mints the quoted shares',await pool.shares(O)===protectedQuote);
 await tx('Protected depositor exits',pool.connect(stranger).withdraw(protectedQuote,O));
 await rejected('Zero-share withdrawal rejected',()=>pool.connect(lp).withdraw(0n,L),'invalid withdrawal');
 await rejected('Zero recipient withdrawal rejected',()=>pool.connect(lp).withdraw(1n,E.ZeroAddress),'invalid withdrawal');
 const owned=await pool.shares(L);await rejected('LP cannot burn more shares than owned',()=>pool.connect(lp).withdraw(owned+1n,L),'invalid withdrawal');
 await tx('node collateral',registry.connect(node).register({value:E.parseEther('1000')}));
 // Regression: premium-induced NAV growth plus repeated floor rounding previously
 // let an incumbent take one wei from a subsequent five-wei deposit.
 const tinyPool=await deploy('RiskPool');
 const tinyCore=await deploy('ComputeShieldCore',[await registry.getAddress(),await tinyPool.getAddress(),await pricing.getAddress(),await pricing.getAddress()]);
 await tx('Bind rounding-regression pool',tinyPool.setCore(await tinyCore.getAddress()));
 await tx('Bind rounding-regression authorities',tinyCore.setAuthorities(R,J));
 await tx('Attacker seeds twenty wei',tinyPool.connect(stranger)['deposit()']({value:20n}));
 const initialTinyShares=await tinyPool.shares(O);
 await tx('Tiny policy earns one wei premium',tinyCore.connect(buyer).buyPolicy(N,20n,120,30,{value:1n}));
 await tick(121);await tx('Tiny policy expires',tinyCore.expire(1));
 await tx('Attacker withdraws nineteen twentieths',tinyPool.connect(stranger).withdraw(initialTinyShares*19n/20n,O));
 const beforeRoundTrip=await tinyPool.shares(O);
 await tx('Attacker deposits three wei',tinyPool.connect(stranger)['deposit()']({value:3n}));
 await tx('Attacker redeems new shares',tinyPool.connect(stranger).withdraw((await tinyPool.shares(O))-beforeRoundTrip,O));
 await tx('Victim deposits five wei',tinyPool.connect(lp2)['deposit()']({value:5n}));
 await tx('Attacker exits before victim',tinyPool.connect(stranger).withdraw(await tinyPool.shares(O),O));
 const victimUnits=await tinyPool.shares(L2);
 check('Premium and floor-rounding attack cannot steal victim principal',await tinyPool.previewRedeem(victimUnits)>=5n);
 await tx('Victim exits regression pool',tinyPool.connect(lp2).withdraw(victimUnits,L2));
 await tx('Restore free capital for duration boundary',tinyPool.connect(stranger)['deposit()']({value:20n}));
 await rejected('Policy duration must allow evidence above SLA before expiry',()=>tinyCore.connect(buyer).buyPolicy(N,20n,31,30,{value:1n}),'bad params');
 if(process.argv.includes('--regression-only')){report.status='passed';report.summary={passed:report.checks.length,failed:0,total:report.checks.length};return;}
 await tx('short local challenge window',core.setChallengeWindow(60));
 const prem=amount=>pricing.quotePremium(E.parseEther(amount),0);
 async function buy(amount,duration=20000){const premium=await prem(amount);await tx('buy '+amount,core.connect(buyer).buyPolicy(N,E.parseEther(amount),duration,30,{value:premium}));return Number(await core.policyCount())}
 const id1=await buy('600');check('First policy reserves full coverage',await pool.reservedCoverage()===E.parseEther('600'));
 await rejected('Concurrent policy cannot reuse locked capital',()=>core.connect(buyer).buyPolicy(N,E.parseEther('500'),20000,30,{value:E.parseEther('25')}));
 const id2=await buy('300');check('Two policies reserve their aggregate coverage',await pool.reservedCoverage()===E.parseEther('900'));
 check('Unsettled premiums excluded from withdrawable cash',await pool.availableCapital()===E.parseEther('100'));
 await rejected('LP cannot withdraw backing active policies',()=>pool.connect(lp).withdraw(E.parseUnits('500',27),L));
 await tx('Partial free-capital withdrawal',pool.connect(lp).withdraw(E.parseUnits('50',27),L));
 check('Backing remains after permitted withdrawal',await pool.totalDeposits()>=await pool.reservedCoverage()+await pool.pendingPremium());
 await rejected('Stranger cannot claim for another payer',()=>core.connect(stranger).reportViolation(id1,60));
 await tx('Payer submits an unverified incident request',core.connect(buyer).reportViolation(id1,60));
 check('Self-report alone does not trigger claim',Number((await core.getPolicy(id1)).status)===1);
 await rejected('Unverified request cannot pay',()=>core.resolve(id1));
 await tick(61);const digest=E.id('signed monitoring sample set');
 await rejected('Unauthorized party cannot confirm evidence',()=>core.connect(stranger).confirmViolation(id1,60,digest));
 await rejected('Empty evidence digest rejected',()=>core.connect(reporter).confirmViolation(id1,60,E.ZeroHash));
 await tx('Authorized reporter confirms evidence',core.connect(reporter).confirmViolation(id1,60,digest));
 const deadline=await core.challengeDeadline(id1);await tx('Change window for future incidents only',core.setChallengeWindow(1));check('Existing challenge deadline is immutable',await core.challengeDeadline(id1)===deadline);
 await rejected('Cannot settle inside challenge window',()=>core.resolve(id1));
 await tick(61);await tx('First policy settlement',core.resolve(id1));
 check('Settlement releases only its own reserve',await pool.reservedCoverage()===E.parseEther('300'));
 await rejected('No duplicate settlement',()=>core.resolve(id1));
 await tx('Second policy evidence',core.connect(reporter).confirmViolation(id2,60,E.id('second incident')));await tick(2);await tx('Second policy settlement',core.resolve(id2));
 check('Both concurrent insured amounts paid',await pool.totalPayout()===E.parseEther('900'));
 check('All settled reserves and premiums released',await pool.reservedCoverage()===0n&&await pool.pendingPremium()===0n);
 check('Actual balance matches pool accounting',BigInt(await provider.send('eth_getBalance',[await pool.getAddress(),'latest']))===await pool.totalDeposits());
 await tx('Second LP enters at current net asset value',pool.connect(lp2)['deposit()']({value:E.parseEther('1000')}));
 await tx('Reset future window for challenge scenarios',core.setChallengeWindow(60));
 const id3=await buy('200');await tick(61);await tx('Confirmed disputed incident',core.connect(reporter).confirmViolation(id3,60,E.id('challenged evidence')));await tx('Node challenges',core.connect(node).challenge(id3,'Maintenance window documented'));
 await tick(61);await rejected('Challenged incident requires separate arbitration',()=>core.resolve(id3));
 await rejected('Reporter cannot self-arbitrate',()=>core.connect(reporter).adjudicate(id3,true,E.id('unauthorized decision')));
 await tx('Arbitrator rejects disputed claim',core.connect(arbiter).adjudicate(id3,false,E.id('review evidence and exclusion')));await tx('Rejected claim releases backing',core.resolve(id3));
 check('Rejected state and reserve release',Number((await core.getPolicy(id3)).status)===5&&await pool.reservedCoverage()===0n);
 const id4=await buy('200',120);await tick(121);await tx('Untriggered policy expires',core.expire(id4));check('Expiration releases coverage',await pool.reservedCoverage()===0n);
 const id5=await buy('200');await tick(61);await tx('Incident awaiting arbitration',core.connect(reporter).confirmViolation(id5,60,E.id('unresolved incident')));await tx('Challenge unresolved incident',core.connect(node).challenge(id5,'Missing logs'));await tick(8*86400);
 await tx('Close unanswered arbitration and credit premium refund',core.closeUnresolved(id5));check('Timed out arbitration frees reserve',await pool.reservedCoverage()===0n);check('Unanswered arbitration refunds premium',await pool.refunds(B)===await prem('200'));
 await tx('Payer collects premium refund',pool.connect(buyer).withdrawRefund(B));check('Refund consumed once',await pool.refunds(B)===0n);
 const receiver=await deploy('TestReceiver',[await pool.getAddress()]);await tx('Reentrant receiver deposits',receiver.fund({value:E.parseEther('10')}));await tx('Reentrant receiver withdraws',receiver.exit(await pool.shares(await receiver.getAddress())));check('Nested withdrawal blocked',await receiver.blocked());
 await tx('First LP exits remaining shares',pool.connect(lp).withdraw(await pool.shares(L),L));await tx('Second LP exits remaining shares',pool.connect(lp2).withdraw(await pool.shares(L2),L2));
 const residual=await pool.totalDeposits();check('All LP shares redeem with bounded rounding residual',await pool.totalShares()===0n&&residual<=10n);
 report.roundingResidualWei=String(residual);
 report.status='passed';report.summary={passed:report.checks.length,failed:0,total:report.checks.length};
 console.log(JSON.stringify({status:report.status,checks:report.checks.length,transactions:report.txs.length}));
 }catch(error){report.status='failed';report.error=error.stack;report.summary={passed:report.checks.length,failed:1,total:report.checks.length+1};console.error(error.stack);process.exitCode=1}
 finally{fs.writeFileSync(path.join(root,'reports/contract-verification-IV.json'),JSON.stringify(report,null,2));if(provider)provider.destroy();}
})();

