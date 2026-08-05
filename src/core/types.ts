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
  gravArc: CanonicalAddress;
  erc20Tokens: { symbol: string; name: string; address: CanonicalAddress }[];
  pureRouter?: CanonicalAddress;
  pactPrivacyDefiRouter?: CanonicalAddress;
  defiProtocols: { name: string; address: CanonicalAddress }[];
};

export type AccountRecord = {
  found: boolean;
  secretHash: string | null;
  encryptedSecret: string | null;
  encPubkey: string | null;
};
