// Uses checked-in solc artifacts; never seeds deposits or reduces the challenge window.
const hre=require('hardhat'),fs=require('node:fs'),path=require('node:path');
async function main(){
 const E=hre.ethers,reporter=process.env.REPORTER_ADDRESS,arbiter=process.env.ARBITER_ADDRESS;
 if(!E.isAddress(reporter||'')||!E.isAddress(arbiter||'')||reporter===E.ZeroAddress||arbiter===E.ZeroAddress||reporter.toLowerCase()===arbiter.toLowerCase())throw Error('Set distinct nonzero REPORTER_ADDRESS and ARBITER_ADDRESS before deployment.');
 const [signer]=await E.getSigners();if(!signer)throw Error('No signing account configured.');
 const network=await E.provider.getNetwork(),allowed={bohr:968n,botchain:677n,hardhat:31337n,localhost:31337n};
 if(allowed[hre.network.name]!==network.chainId)throw Error('Unexpected network chain ID.');
 const dir=path.resolve(__dirname,'../reports/deployments');fs.mkdirSync(dir,{recursive:true});
 const output=path.join(dir,Date.now()+'-'+hre.network.name+'.json');
 const record={version:'IV',network:hre.network.name,chainId:String(network.chainId),createdAt:new Date().toISOString(),status:'in-progress',contracts:{},transactions:[],authorities:{reporter,arbiter}};
 const save=()=>fs.writeFileSync(output,JSON.stringify(record,null,2));
 const arts={};for(const name of ['NodeRegistry','RiskPool','AIReporterMock','ComputeShieldCore']){const a=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../artifacts',name+'.json')));if(!a.compiler.startsWith('0.8.26+')||a.evmVersion!=='paris')throw Error('Run npm run compile with solc 0.8.26 / paris first.');arts[name]=a;}save();
 const act=async(label,promise)=>{const receipt=await(await promise).wait();record.transactions.push({label,hash:receipt.hash,status:receipt.status,blockNumber:receipt.blockNumber});save();};
 const deploy=async(name,args=[])=>{const a=arts[name],c=await new E.ContractFactory(a.abi,a.bytecode,signer).deploy(...args);await act('deploy '+name,Promise.resolve(c.deploymentTransaction()));await c.waitForDeployment();record.contracts[name]=await c.getAddress();save();return c;};
 try{
  const registry=await deploy('NodeRegistry'),pool=await deploy('RiskPool'),pricing=await deploy('AIReporterMock');
  const core=await deploy('ComputeShieldCore',[await registry.getAddress(),await pool.getAddress(),await pricing.getAddress(),await pricing.getAddress()]);
  await act('bind registry',registry.setCore(await core.getAddress()));await act('bind pool',pool.setCore(await core.getAddress()));await act('set evidence authorities',core.setAuthorities(reporter,arbiter));
  record.status='deployed';save();console.log(JSON.stringify(record,null,2));console.log('No LP funds, node stake or policy were submitted. Record: '+output);
 }catch(error){record.status='incomplete';record.error=error.shortMessage||error.message;save();throw error;}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
