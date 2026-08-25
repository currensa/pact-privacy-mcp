/** GravArc contract ABI (deposit / withdraw / refund + view helpers), matching the web app. */
export const GRAVARC_ABI = [
    {
        name: 'deposit',
        type: 'function',
        inputs: [
            {
                name: 'p',
                type: 'tuple',
                components: [
                    { name: 'pA', type: 'uint256[2]' },
                    { name: 'pB', type: 'uint256[2][2]' },
                    { name: 'pC', type: 'uint256[2]' },
                    { name: 'newRoot', type: 'uint256' },
                    { name: 'depositLeaf', type: 'uint256' },
                    { name: 'totalAmount', type: 'uint256' },
                    { name: 'token', type: 'address' },
                    { name: 'tier', type: 'uint8' },
                ],
            },
        ],
        outputs: [],
        stateMutability: 'payable',
    },
    {
        name: 'nullifierHashes',
        type: 'function',
        inputs: [{ name: '', type: 'bytes32' }],
        outputs: [
            { name: 'claimed', type: 'uint256' },
            { name: 'nextNonce', type: 'uint256' },
        ],
        stateMutability: 'view',
    },
    {
        name: 'refundedNullifierHashes',
        type: 'function',
        inputs: [{ name: '', type: 'bytes32' }],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'view',
    },
    {
        name: 'withdraw',
        type: 'function',
        inputs: [
            {
                name: 'p',
                type: 'tuple',
                components: [
                    { name: 'pA', type: 'uint256[2]' },
                    { name: 'pB', type: 'uint256[2][2]' },
                    { name: 'pC', type: 'uint256[2]' },
                    { name: 'nullifierHash', type: 'bytes32' },
                    { name: 'recipient', type: 'address' },
                    { name: 'claimedAmount', type: 'uint256' },
                    { name: 'token', type: 'address' },
                    { name: 'tier', type: 'uint8' },
                    { name: 'depositRoot', type: 'uint256' },
                    { name: 'expectedAmount', type: 'uint256' },
                    { name: 'fee', type: 'uint256' },
                    { name: 'relayer', type: 'address' },
                    { name: 'nonce', type: 'uint256' },
                ],
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        name: 'refund',
        type: 'function',
        inputs: [
            {
                name: 'p',
                type: 'tuple',
                components: [
                    { name: 'pA', type: 'uint256[2]' },
                    { name: 'pB', type: 'uint256[2][2]' },
                    { name: 'pC', type: 'uint256[2]' },
                    { name: 'depositRoot', type: 'uint256' },
                    { name: 'nullifierHash', type: 'bytes32[]' },
                    { name: 'token', type: 'address' },
                    { name: 'refundAmount', type: 'uint256' },
                    { name: 'fee', type: 'uint256' },
                    { name: 'relayer', type: 'address' },
                    { name: 'refunder', type: 'address' },
                    { name: 'tier', type: 'uint8' },
                ],
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
] as const;

export const ERC20_ABI = [
    {
        name: 'approve',
        type: 'function',
        inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
    },
    {
        name: 'allowance',
        type: 'function',
        inputs: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
    },
] as const;
