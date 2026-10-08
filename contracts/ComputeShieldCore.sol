// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface INodeRegistry {
    function nodes(address) external view returns(uint256,uint64,uint32,uint32,bool);
    function slash(address,uint256,string calldata) external;
}
interface IRiskPool {
    function availableCapital() external view returns(uint256);
    function reserve(uint256,uint256) external;
    function addPremium(uint256) external payable;
    function release(uint256) external;
    function cancel(uint256,address) external;
    function pay(uint256,address,uint256) external;
}
interface IAIPricing {
    function riskScoreOf(address) external view returns(uint256);
    function quotePremium(uint256,uint256) external view returns(uint256);
}
/// @notice Permissioned evidence/capital prototype; a model never authorizes payment.
contract ComputeShieldCore {
    enum Status {None,Active,Triggered,Challenged,Paid,Rejected,Expired}
    struct Policy {
        address payer; address node; uint256 coverage; uint256 premium;
        uint64 start; uint64 end; uint64 triggerAt;
        uint32 slaSeconds; uint32 downtimeSeconds; Status status;
    }
    address public immutable admin;
    INodeRegistry public immutable registry;
    IRiskPool public immutable pool;
    IAIPricing public immutable aiPricing;
    address public immutable aiAudit; // Legacy ABI only: mock audit never authorizes settlement.
    address public evidenceReporter;
    address public arbiter;
    uint256 public nextPolicyId=1;
    uint256 public challengeWindow=24 hours;
    uint256 public constant arbitrationWindow=7 days;
    uint256 public constant slashBps=1000;
    mapping(uint256=>Policy) public policies;
    mapping(uint256=>uint32) public incidentRequests;
    mapping(uint256=>bytes32) public evidenceHash;
    mapping(uint256=>uint256) public challengeDeadline;
    mapping(uint256=>uint256) public arbitrationDeadline;
    mapping(uint256=>uint8) public adjudication;
    mapping(uint256=>bytes32) public decisionHash;
    bool private entered;
    modifier onlyAdmin(){require(msg.sender==admin,"only admin");_;}
    modifier nonReentrant(){require(!entered,"reentrant");entered=true;_;entered=false;}
    event PolicyCreated(uint256 indexed id,address indexed payer,address indexed node,uint256 coverage,uint256 premium,uint32 slaSeconds,uint32 durationSeconds);
    event IncidentRequested(uint256 indexed id,address indexed payer,uint32 downtimeSeconds);
    event ViolationReported(uint256 indexed id,uint32 downtimeSeconds,uint64 challengeDeadline);
    event EvidenceConfirmed(uint256 indexed id,bytes32 evidenceHash,address indexed reporter);
    event Challenged(uint256 indexed id,address indexed challenger,string reason);
    event Adjudicated(uint256 indexed id,bool approved,bytes32 decisionHash);
    event PolicyResolved(uint256 indexed id,Status status,bool paid,uint256 amount,string reason);
    event PolicyExpired(uint256 indexed id);
    event ChallengeWindowUpdated(uint256 oldSeconds,uint256 newSeconds);
    event AuthoritiesBound(address indexed reporter,address indexed arbiter);
    constructor(address registry_,address pool_,address pricing_,address audit_){
        require(registry_.code.length>0&&pool_.code.length>0&&pricing_.code.length>0,"invalid dependencies");
        admin=msg.sender;registry=INodeRegistry(registry_);pool=IRiskPool(pool_);aiPricing=IAIPricing(pricing_);aiAudit=audit_;
    }
    function setAuthorities(address reporter_,address arbiter_) external onlyAdmin {
        require(evidenceReporter==address(0),"authorities already bound");
        require(reporter_!=address(0)&&arbiter_!=address(0)&&reporter_!=arbiter_,"distinct authorities required");
        evidenceReporter=reporter_;arbiter=arbiter_;emit AuthoritiesBound(reporter_,arbiter_);
    }
    function buyPolicy(address node,uint256 coverage,uint32 duration,uint32 slaSeconds) external payable nonReentrant returns(uint256 id){
        require(evidenceReporter!=address(0),"evidence roles not configured");
        (,,,,bool registered)=registry.nodes(node);require(registered,"node not registered");
        require(coverage>0&&coverage<=pool.availableCapital(),"coverage exceeds free capital");
        // Evidence needs downtime > SLA and must be confirmed strictly before end.
        require(uint256(duration)>uint256(slaSeconds)+1,"bad params");
        uint256 risk=aiPricing.riskScoreOf(node);require(risk<=100,"invalid risk score");
        uint256 premium=aiPricing.quotePremium(coverage,risk);require(premium>0&&msg.value>=premium,"insufficient premium");
        id=nextPolicyId++;policies[id]=Policy(msg.sender,node,coverage,premium,uint64(block.timestamp),uint64(block.timestamp+duration),0,slaSeconds,0,Status.Active);
        pool.reserve(id,coverage);pool.addPremium{value:premium}(id);
        if(msg.value>premium){(bool ok,)=msg.sender.call{value:msg.value-premium}("");require(ok,"refund failed");}
        emit PolicyCreated(id,msg.sender,node,coverage,premium,slaSeconds,duration);
    }
    /// A payer assertion creates a request only; it never starts a settlement clock.
    function reportViolation(uint256 id,uint32 downtimeSeconds) external {
        Policy storage p=policies[id];require(p.status==Status.Active&&block.timestamp<p.end,"not active");require(msg.sender==p.payer,"only payer may request");
        require(downtimeSeconds>p.slaSeconds&&downtimeSeconds<=p.end-p.start,"invalid reported duration");
        incidentRequests[id]=downtimeSeconds;emit IncidentRequested(id,msg.sender,downtimeSeconds);
    }
    function confirmViolation(uint256 id,uint32 downtimeSeconds,bytes32 digest) external {
        require(msg.sender==evidenceReporter,"only evidence reporter");Policy storage p=policies[id];
        require(p.status==Status.Active&&block.timestamp<p.end,"not active");
        require(digest!=bytes32(0)&&downtimeSeconds>p.slaSeconds&&downtimeSeconds<=block.timestamp-p.start,"invalid evidence");
        p.downtimeSeconds=downtimeSeconds;p.triggerAt=uint64(block.timestamp);p.status=Status.Triggered;evidenceHash[id]=digest;
        challengeDeadline[id]=block.timestamp+challengeWindow;arbitrationDeadline[id]=challengeDeadline[id]+arbitrationWindow;
        emit EvidenceConfirmed(id,digest,msg.sender);emit ViolationReported(id,downtimeSeconds,uint64(challengeDeadline[id]));
    }
    function challenge(uint256 id,string calldata reason) external {
        Policy storage p=policies[id];require(p.status==Status.Triggered&&block.timestamp<=challengeDeadline[id],"challenge closed");
        require(bytes(reason).length>0&&bytes(reason).length<=1024,"reason required");p.status=Status.Challenged;emit Challenged(id,msg.sender,reason);
    }
    function adjudicate(uint256 id,bool approve,bytes32 digest) external {
        require(msg.sender==arbiter,"only arbiter");require(policies[id].status==Status.Challenged&&adjudication[id]==0,"not pending arbitration");
        require(block.timestamp>challengeDeadline[id]&&block.timestamp<=arbitrationDeadline[id],"arbitration timing");
        require(digest!=bytes32(0),"decision evidence required");adjudication[id]=approve?1:2;decisionHash[id]=digest;emit Adjudicated(id,approve,digest);
    }
    function resolve(uint256 id) external nonReentrant returns(bool){return settle(id,policies[id].payer);}
    function resolveTo(uint256 id,address recipient) external nonReentrant returns(bool){require(msg.sender==policies[id].payer&&recipient!=address(0),"only payer recipient");return settle(id,recipient);}
    function settle(uint256 id,address recipient) private returns(bool paid){
        Policy storage p=policies[id];require(p.status==Status.Triggered||p.status==Status.Challenged,"not resolvable");
        require(block.timestamp>challengeDeadline[id],"challenge window open");require(evidenceHash[id]!=bytes32(0),"no evidence");
        if(p.status==Status.Challenged){require(adjudication[id]!=0,"arbitration required");paid=adjudication[id]==1;}else paid=true;
        if(paid){p.status=Status.Paid;registry.slash(p.node,p.coverage*slashBps/10000,"verified SLA violation");pool.pay(id,recipient,p.coverage);}
        else {p.status=Status.Rejected;pool.release(id);}
        emit PolicyResolved(id,p.status,paid,paid?p.coverage:0,paid?"Verified evidence; challenge rules satisfied":"Independent arbitration rejected claim");
    }
    function closeUnresolved(uint256 id) external nonReentrant {
        Policy storage p=policies[id];require(p.status==Status.Challenged&&adjudication[id]==0&&block.timestamp>arbitrationDeadline[id],"not timed out");
        p.status=Status.Rejected;pool.cancel(id,p.payer);emit PolicyResolved(id,p.status,false,0,"Arbitration timed out; premium refundable");
    }
    function expire(uint256 id) external nonReentrant {
        Policy storage p=policies[id];require(p.status==Status.Active&&block.timestamp>=p.end,"not expired");p.status=Status.Expired;pool.release(id);emit PolicyExpired(id);
    }
    function setChallengeWindow(uint256 seconds_) external onlyAdmin {
        require(seconds_>0&&seconds_<=7 days,"invalid window");emit ChallengeWindowUpdated(challengeWindow,seconds_);challengeWindow=seconds_;
    }
    function policyCount() external view returns(uint256){return nextPolicyId-1;}
    function protocolVersion() external pure returns(uint256){return 4;}
    function getPolicy(uint256 id) external view returns(Policy memory){return policies[id];}
}
