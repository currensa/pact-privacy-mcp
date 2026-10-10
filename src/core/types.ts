export type ChainFamily = "evm" | "tron";

export type CanonicalAddress = `0x${string}`;

export type ChainSummary = {
  chainId: number;
  chainName: string;
  family: ChainFamily;
  rpcUrl?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  rpcUrls?: string[];
  blockExplorerUrls?: string[];
};

export type ChainDetails = ChainSummary & {
  capabilities?: { deposit: boolean; withdraw: boolean; refund: boolean; defi: boolean; relayed: boolean };
  gravArc: CanonicalAddress;
  erc20Tokens: { symbol: string; name: string; address: CanonicalAddress }[];
  pureRouter?: CanonicalAddress;
  pactPrivacyDefiRouter?: CanonicalAddress;
  defiProtocols: Array<{
    name: string;
    type?: string;
    outputBehavior?: "fixed" | "variable";
    address: CanonicalAddress;
    "help-contracts"?: Record<string, CanonicalAddress>;
  }>;
};

export type AccountRecord = {
  found: boolean;
  secretHash: string | null;
  encryptedSecret: string | null;
  encPubkey: string | null;
};

export type RegisteredReceiver = {
  memberId?: string;
  address: string;
  secretHash: string;
  encPubkey: string;
};

export type DepositionRecord = {
  org_id?: string;
  batch_id?: string;
  leaf_index: number;
  address: string;
  chain_id: string;
  enc_content: string | null;
  can_refund: 0 | 1;
  is_refunded: boolean | 0 | 1;
  deposit_info: string | null;
  message_count: number;
};

export type EncryptedAllocation = {
  id: string;
  content: string;
  token: string;
  tier: number;
  leafIndex: number;
  depositLeaf: string;
  recipient: string;
  encryptedSecret: string;
  source: "payroll" | "defi";
  batchId?: string;
};
