// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ERC-8183 `IACPHook` — the hook contract interface the core escrow calls. Normative text:
/// https://eips.ethereum.org/EIPS/eip-8183#hooks-optional (fetched 2026-09-18; two functions,
/// nothing else is normative). `contracts/src/SlaHook.sol` declares the same interface inline
/// because it compiles standalone; this file exists so the reference implementation's
/// `import "./interfaces/IACPHook.sol"` resolves.
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
