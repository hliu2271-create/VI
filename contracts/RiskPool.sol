// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Fully collateralized prototype pool. NAV-priced shares; no LP iteration.
/// Unsettled premiums cannot increase underwriting or withdrawal capacity.
/// Shares have 27-decimal precision for 18-decimal ETH. Virtual liquidity
/// prevents a near-empty pool from amplifying deposit rounding against new LPs.
contract RiskPool {
    uint256 public constant VIRTUAL_SHARES=1e9;
    uint256 public constant VIRTUAL_ASSETS=1;
    uint8 public constant SHARE_DECIMALS=27;
    address public immutable admin;
    address public core;
    uint256 public totalDeposits;
    uint256 public totalPremiumIncome;
    uint256 public totalPayout;
    uint256 public totalShares;
    uint256 public reservedCoverage;
    uint256 public pendingPremium;
    uint256 public refundLiability;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public refunds;
    struct Reservation { uint256 coverage; uint256 premium; bool created; bool settled; }
    mapping(uint256 => Reservation) public reservations;
    bool private entered;
    uint256 private holders;
    event LPDeposit(address indexed lp,uint256 amount);
    event LPWithdrawal(address indexed lp,address indexed recipient,uint256 shares,uint256 amount);
    event PremiumIncome(uint256 indexed policyId,uint256 amount);
    event Payout(uint256 indexed policyId,address indexed to,uint256 amount);
    event CapitalReserved(uint256 indexed policyId,uint256 amount);
    event CapitalReleased(uint256 indexed policyId,uint256 amount);
    event PremiumRefund(uint256 indexed policyId,address indexed payer,uint256 amount);
    event CoreUpdated(address indexed oldCore,address indexed newCore);
    modifier onlyCore(){require(msg.sender==core,"only core");_;}
    modifier nonReentrant(){require(!entered,"reentrant");entered=true;_;entered=false;}
    constructor(){admin=msg.sender;}
    function setCore(address c) external {
        require(msg.sender==admin && core==address(0),"core already bound or unauthorized");
        require(c.code.length>0,"core must be a contract");core=c;emit CoreUpdated(address(0),c);
    }
    function totalAssets() public view returns(uint256){return totalDeposits-refundLiability;}
    function availableCapital() public view returns(uint256){return totalAssets()-reservedCoverage-pendingPremium;}
    function deposits(address lp) external view returns(uint256){return previewRedeem(shares[lp]);}
    function lpCount() external view returns(uint256){return holders;}
    function previewDeposit(uint256 assets) public view returns(uint256){return assets*(totalShares+VIRTUAL_SHARES)/(totalAssets()+VIRTUAL_ASSETS);}
    function previewRedeem(uint256 units) public view returns(uint256){return units*(totalAssets()+VIRTUAL_ASSETS)/(totalShares+VIRTUAL_SHARES);}
    function deposit() external payable nonReentrant {
        depositAssets(0);
    }
    /// @notice A caller can protect its quoted share amount from NAV movement.
    function deposit(uint256 minShares) external payable nonReentrant {
        depositAssets(minShares);
    }
    function depositAssets(uint256 minShares) private {
        require(msg.value>0,"zero deposit");uint256 assets=totalAssets();
        require(totalShares==0 || assets>0,"burn depleted shares before recapitalizing");
        uint256 minted=previewDeposit(msg.value);require(minted>0,"deposit rounds to zero");
        require(minted>=minShares,"deposit slippage");
        if(shares[msg.sender]==0)holders++;
        shares[msg.sender]+=minted;totalShares+=minted;totalDeposits+=msg.value;emit LPDeposit(msg.sender,msg.value);
    }
    function withdraw(uint256 units,address payable recipient) external nonReentrant {
        require(recipient!=address(0)&&units>0&&units<=shares[msg.sender],"invalid withdrawal");
        uint256 amount=previewRedeem(units);require(amount<=availableCapital(),"capital backs active policies");
        shares[msg.sender]-=units;totalShares-=units;totalDeposits-=amount;if(shares[msg.sender]==0)holders--;
        if(amount>0){(bool ok,)=recipient.call{value:amount}("");require(ok,"transfer failed");}
        emit LPWithdrawal(msg.sender,recipient,units,amount);
    }
    function reserve(uint256 id,uint256 amount) external onlyCore {
        require(!reservations[id].created&&amount>0,"invalid reservation");require(amount<=availableCapital(),"insufficient free capital");
        reservations[id]=Reservation(amount,0,true,false);reservedCoverage+=amount;emit CapitalReserved(id,amount);
    }
    function addPremium(uint256 id) external payable onlyCore {
        Reservation storage r=reservations[id];require(r.created&&!r.settled&&r.premium==0&&msg.value>0,"invalid premium");
        r.premium=msg.value;pendingPremium+=msg.value;totalDeposits+=msg.value;totalPremiumIncome+=msg.value;emit PremiumIncome(id,msg.value);
    }
    function settleReservation(uint256 id) private returns(uint256 amount,uint256 premium){
        Reservation storage r=reservations[id];require(r.created&&!r.settled&&r.premium>0,"reservation unavailable");
        r.settled=true;amount=r.coverage;premium=r.premium;reservedCoverage-=amount;pendingPremium-=premium;emit CapitalReleased(id,amount);
    }
    function release(uint256 id) external onlyCore {settleReservation(id);}
    function cancel(uint256 id,address payer) external onlyCore {
        require(payer!=address(0),"zero payer");(,uint256 premium)=settleReservation(id);
        refunds[payer]+=premium;refundLiability+=premium;emit PremiumRefund(id,payer,premium);
    }
    function withdrawRefund(address payable to) external nonReentrant {
        uint256 amount=refunds[msg.sender];require(amount>0&&to!=address(0),"no refund");
        refunds[msg.sender]=0;refundLiability-=amount;totalDeposits-=amount;
        (bool ok,)=to.call{value:amount}("");require(ok,"transfer failed");
    }
    function pay(uint256 id,address to,uint256 amount) external onlyCore nonReentrant {
        require(to!=address(0)&&amount==reservations[id].coverage,"invalid payout");
        settleReservation(id);totalDeposits-=amount;totalPayout+=amount;
        (bool ok,)=to.call{value:amount}("");require(ok,"transfer failed");emit Payout(id,to,amount);
    }
}
