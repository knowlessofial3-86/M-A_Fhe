pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract MaAFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidBatchId();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => bool) public isBatchClosed;

    struct FinancialData {
        euint32 revenue;
        euint32 ebitda;
        euint32 debt;
        euint32 assets;
    }
    mapping(uint256 => mapping(address => FinancialData)) public batchFinancialData;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event FinancialDataSubmitted(address indexed provider, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 revenue, uint256 ebitda, uint256 debt, uint256 assets);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionRateLimited() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;
        _;
    }

    modifier decryptionRequestRateLimited() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 10; // Default cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        uint256 batchId = currentBatchId;
        isBatchOpen[batchId] = true;
        isBatchClosed[batchId] = false;
        emit BatchOpened(batchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (!isBatchOpen[batchId]) revert BatchClosed();
        isBatchOpen[batchId] = false;
        isBatchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitFinancialData(
        uint256 batchId,
        euint32 encryptedRevenue,
        euint32 encryptedEbitda,
        euint32 encryptedDebt,
        euint32 encryptedAssets
    ) external onlyProvider whenNotPaused submissionRateLimited {
        if (!isBatchOpen[batchId]) revert BatchClosed();
        if (!_isInitialized(encryptedRevenue) || !_isInitialized(encryptedEbitda) || !_isInitialized(encryptedDebt) || !_isInitialized(encryptedAssets)) {
            revert NotInitialized();
        }

        FinancialData storage data = batchFinancialData[batchId][msg.sender];
        data.revenue = encryptedRevenue;
        data.ebitda = encryptedEbitda;
        data.debt = encryptedDebt;
        data.assets = encryptedAssets;

        emit FinancialDataSubmitted(msg.sender, batchId);
    }

    function requestBatchSummaryDecryption(uint256 batchId) external onlyProvider whenNotPaused decryptionRequestRateLimited {
        if (!isBatchClosed[batchId]) revert BatchNotClosed();

        euint32 memory totalRevenue = FHE.asEuint32(0);
        euint32 memory totalEbitda = FHE.asEuint32(0);
        euint32 memory totalDebt = FHE.asEuint32(0);
        euint32 memory totalAssets = FHE.asEuint32(0);
        bool initialized = false;

        address provider = providers(0); // Iterate over providers if a list is maintained, or use a different iteration method
        if (provider == address(0)) revert InvalidBatchId(); // Or handle empty batch

        FinancialData storage data = batchFinancialData[batchId][provider];
        if (_isInitialized(data.revenue)) {
            if (!initialized) {
                totalRevenue = data.revenue;
                totalEbitda = data.ebitda;
                totalDebt = data.debt;
                totalAssets = data.assets;
                initialized = true;
            } else {
                totalRevenue = totalRevenue.add(data.revenue);
                totalEbitda = totalEbitda.add(data.ebitda);
                totalDebt = totalDebt.add(data.debt);
                totalAssets = totalAssets.add(data.assets);
            }
        }
        // Add more providers if iterating

        if (!initialized) {
            revert InvalidBatchId(); // No data submitted for this batch
        }

        bytes32[] memory cts = new bytes32[](4);
        cts[0] = totalRevenue.toBytes32();
        cts[1] = totalEbitda.toBytes32();
        cts[2] = totalDebt.toBytes32();
        cts[3] = totalAssets.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        if (cleartexts.length != 4 * 32) revert InvalidProof(); // Expecting 4 uint256 values

        DecryptionContext storage ctx = decryptionContexts[requestId];
        bytes32[] memory currentCts = new bytes32[](4);
        // Rebuild cts in the exact same order as in requestBatchSummaryDecryption
        // This part needs to re-compute the aggregated ciphertexts for the batch
        // For simplicity, this example assumes the ciphertexts are fetched/recomputed here
        // In a real scenario, this would involve re-calculating the sum of encrypted values for the batch
        // For this example, we'll assume currentCts is correctly populated
        // e.g., by re-fetching and summing the encrypted data for ctx.batchId
        // THIS IS A SIMPLIFICATION. A real implementation must ensure currentCts matches the original request.
        // For this example, we'll directly use the stateHash from storage for verification,
        // assuming the original cts were correctly formed and hashed.
        // The critical part is that the state of the contract (and thus the data used to form cts)
        // has not changed since the decryption was requested.

        bytes32 currentHash = _hashCiphertexts(currentCts); // This hash must match ctx.stateHash
        if (currentHash != ctx.stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 revenue = abi.decode(cleartexts[0:32], (uint256));
        uint256 ebitda = abi.decode(cleartexts[32:64], (uint256));
        uint256 debt = abi.decode(cleartexts[64:96], (uint256));
        uint256 assets = abi.decode(cleartexts[96:128], (uint256));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, revenue, ebitda, debt, assets);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _isInitialized(euint32 val) internal pure returns (bool) {
        return FHE.isInitialized(val);
    }

    // Placeholder for provider iteration if needed
    // function providers(uint256 index) internal view returns (address) {
    //   // Implement logic to get provider by index if maintaining a list
    //   revert(); // Not implemented in this example
    // }
}