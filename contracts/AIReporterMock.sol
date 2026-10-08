// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AIReporterMock - AI Agent 预言机（Mock 实现）
/// @notice 对应脑图"系统组件"：AI定价Agent、AI理赔审核Agent。
///         黑客松 Day2 可替换为真实 LLM/链下模型推理结果上链的 Reporter。
contract AIReporterMock {
    address public admin;
    mapping(address => uint256) public riskScoreOf;   // 0(最安全) - 100(最高危)

    event RiskScoreUpdated(address indexed node, uint256 score);
    event ClaimAudited(uint256 indexed policyId, bool approve, string reason);

    modifier onlyAdmin() { require(msg.sender == admin, "only admin"); _; }

    constructor() { admin = msg.sender; }

    /// @notice 风控Agent 实时评估后写入节点风险分
    function setRiskScore(address node, uint256 score) external onlyAdmin {
        require(score <= 100, "score out of range");
        riskScoreOf[node] = score;
        emit RiskScoreUpdated(node, score);
    }

    /// @dev AI定价Agent（链上简化费率）
    ///     演示费率 = 5% 基础 + 风险分 × 0.2%（年化口径，对应 30 天期短期险）
    ///     生产环境：完整精算定价（出险频率 × 单次赔付率 × 再保分出 × 代位追偿
    ///     ÷ (1 − 费用率 − 目标利润率) × 风险边际）由链下精算引擎计算后经本合约上链，
    ///     链上只做校验与执行，保证链上链下定价口径一致。
    function quotePremium(uint256 coverage, uint256 riskScore) public pure returns (uint256) {
        uint256 rateBps = 500 + riskScore * 20;          // 万分之
        return (coverage * rateBps) / 10000;
    }

    /// @dev AI理赔审核Agent：依据 SLA 与实际宕机时长裁决
    function auditClaim(
        uint256 /*policyId*/,
        uint256 downtimeSeconds,
        uint256 slaSeconds,
        bool challenged
    ) external pure returns (bool approve, string memory reason) {
        if (downtimeSeconds > slaSeconds) {
            if (challenged) {
                return (true, "AI Audit: downtime exceeded SLA, evidence verified, payout approved despite challenge");
            }
            return (true, "AI Audit: downtime exceeded SLA, auto-approved");
        }
        return (false, "AI Audit: downtime within SLA tolerance, claim rejected");
    }
}
