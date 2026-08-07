export const GRAVARC_DEPOSIT_ABI = [
  {
    type: "function", name: "deposit", stateMutability: "payable", outputs: [],
    inputs: [{
      name: "p", type: "tuple", components: [
        { name: "pA", type: "uint256[2]" },
        { name: "pB", type: "uint256[2][2]" },
        { name: "pC", type: "uint256[2]" },
        { name: "newRoot", type: "uint256" },
        { name: "depositLeaf", type: "uint256" },
        { name: "totalAmount", type: "uint256" },
        { name: "token", type: "address" },
        { name: "tier", type: "uint8" },
      ],
    }],
  },
  {
    type: "event", name: "Deposit", anonymous: false,
    inputs: [
      { name: "newRoot", type: "uint256", indexed: true },
      { name: "leafIndex", type: "uint256", indexed: false },
      { name: "depositLeaf", type: "uint256", indexed: false },
      { name: "totalAmount", type: "uint256", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "tier", type: "uint8", indexed: false },
    ],
  },
] as const;

export const GRAVARC_WITHDRAW_ABI = [{
  type: "function", name: "withdraw", stateMutability: "nonpayable", outputs: [],
  inputs: [{
    name: "p", type: "tuple", components: [
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
      { name: "nullifierHash", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "claimedAmount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "tier", type: "uint8" },
      { name: "depositRoot", type: "uint256" },
      { name: "expectedAmount", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "relayer", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  }],
}] as const;

export const GRAVARC_REFUND_ABI = [{
  type: "function", name: "refund", stateMutability: "nonpayable", outputs: [],
  inputs: [{
    name: "p", type: "tuple", components: [
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
      { name: "depositRoot", type: "uint256" },
      { name: "nullifierHash", type: "bytes32[]" },
      { name: "token", type: "address" },
      { name: "refundAmount", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "relayer", type: "address" },
      { name: "refunder", type: "address" },
      { name: "tier", type: "uint8" },
    ],
  }],
}] as const;
