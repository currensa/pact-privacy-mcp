import { JsonRpcProvider, Wallet } from "ethers";
import { TronWeb } from "tronweb";
import type { ChainDetails } from "../core/types.js";
import { LocalSigner } from "../wallet/local-signer.js";

export type EvmRuntime = { family: "evm"; provider: JsonRpcProvider; wallet: Wallet };
export type TronRuntime = { family: "tron"; tronWeb: TronWeb };
export type ChainRuntime = EvmRuntime | TronRuntime;

export function createChainRuntime(
  chain: ChainDetails,
  signer: LocalSigner,
  options: { tronProApiKey?: string } = {},
): ChainRuntime {
  const rpcUrl = chain.rpcUrls?.[0];
  if (!rpcUrl) throw new Error(`Chain ${chain.chainId} has no wallet RPC URL`);
  if (chain.family === "evm") {
    const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { staticNetwork: true });
    return { family: "evm", provider, wallet: signer.evmWallet.connect(provider) };
  }
  const tronOptions = {
    fullHost: rpcUrl,
    privateKey: signer.privateKey.slice(2),
    ...(options.tronProApiKey ? { headers: { "TRON-PRO-API-KEY": options.tronProApiKey } } : {}),
  };
  return {
    family: "tron",
    tronWeb: new TronWeb(tronOptions),
  };
}
