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
