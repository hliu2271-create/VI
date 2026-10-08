// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title NodeRegistry - 节点注册表（被保方：DePIN 算力节点）
/// @notice 节点质押注册、心跳上报、违约 slashing。质押即承保信用。
contract NodeRegistry {
    struct Node {
        uint256 stake;          // 质押金额（原生 BOT）
        uint64  lastHeartbeat;  // 最近一次心跳
        uint32  uptimeReports;  // 在线心跳数
        uint32  downtimeReports;// 离线心跳数
        bool    registered;
    }

    mapping(address => Node) public nodes;
    address[] public nodeList;

    address public admin;
    address public reporter;                 // 链下风控Agent / 预言机（上报心跳）
    address public core;                     // ComputeShieldCore（执行 slashing）
    uint256 public constant MIN_STAKE = 1000 ether;

    event NodeRegistered(address indexed operator, uint256 stake);
    event Heartbeat(address indexed operator, uint64 at);
    event HeartbeatReported(address indexed operator, bool up, uint32 uptime, uint32 downtime);
    event NodeSlashed(address indexed operator, uint256 amount, string reason);
    event ReporterUpdated(address indexed oldReporter, address indexed newReporter);

    modifier onlyAdmin()    { require(msg.sender == admin, "only admin"); _; }
    modifier onlyReporter() { require(msg.sender == reporter, "only reporter"); _; }

    constructor() {
        admin = msg.sender;
        reporter = msg.sender; // 演示环境默认部署者即风控Agent
    }

    function setReporter(address r) external onlyAdmin {
        emit ReporterUpdated(reporter, r);
        reporter = r;
    }

    function setCore(address c) external onlyAdmin {
        require(core == address(0) && c.code.length > 0, "core must be bound once to a contract");
        core = c;
    }

    /// @notice 节点质押注册（质押 = 承保保证金，违约时被 slashing）
    function register() external payable {
        require(msg.value >= MIN_STAKE, "stake < MIN_STAKE");
        require(!nodes[msg.sender].registered, "already registered");
        nodes[msg.sender] = Node({
            stake: msg.value,
            lastHeartbeat: uint64(block.timestamp),
            uptimeReports: 0,
            downtimeReports: 0,
            registered: true
        });
        nodeList.push(msg.sender);
        emit NodeRegistered(msg.sender, msg.value);
    }

    /// @notice 节点自主心跳
    function heartbeat() external {
        Node storage n = nodes[msg.sender];
        require(n.registered, "not registered");
        n.lastHeartbeat = uint64(block.timestamp);
        emit Heartbeat(msg.sender, uint64(block.timestamp));
    }

    /// @notice 链下风控Agent批量上报心跳结果（在线/离线）
    function reportHeartbeat(address node, bool up) external onlyReporter {
        Node storage n = nodes[node];
        require(n.registered, "unknown node");
        if (up) {
            n.uptimeReports++;
            n.lastHeartbeat = uint64(block.timestamp);
        } else {
            n.downtimeReports++;
        }
        emit HeartbeatReported(node, up, n.uptimeReports, n.downtimeReports);
    }

    /// @notice 违约 slashing（仅 Core 或风控Reporter 调用）
    function slash(address node, uint256 amount, string calldata reason) external {
        require(msg.sender == core || msg.sender == reporter, "no auth");
        Node storage n = nodes[node];
        require(n.registered, "unknown node");
        if (amount > n.stake) amount = n.stake;
        n.stake -= amount;
        emit NodeSlashed(node, amount, reason);
    }

    // ---- views ----
    function nodeListLength() external view returns (uint256) { return nodeList.length; }
    function isRegistered(address node) external view returns (bool) { return nodes[node].registered; }
    function stakeOf(address node) external view returns (uint256) { return nodes[node].stake; }
}
