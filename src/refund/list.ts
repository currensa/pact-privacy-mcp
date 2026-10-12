import { formatUnits } from "ethers";
import { normalizeAddress } from "../chain/address.js";
import { deriveEncryptionKeyPair } from "../crypto/account.js";
import { decryptMessage } from "../crypto/messages.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service, type TokenDetails } from "../web3/service.js";
import { parseRefundContent } from "./content.js";
import { refundState } from "./state.js";

type DisplayAmount = { raw: string; formatted: string };

export type RefundableDeposit = {
  chainId: number;
  leafIndex: number;
  token: { address: string; symbol: string; decimals: number };
  tier: number;
  totalAllocated: DisplayAmount;
  totalWithdrawn: DisplayAmount;
  refundableAmount: DisplayAmount;
};

function amount(value: bigint, decimals: number): DisplayAmount {
  return { raw: value.toString(), formatted: formatUnits(value, decimals) };
}

function noLongerRefundable(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "This deposit has already been refunded on-chain"
    || error.message === "Nothing remains to refund"
  );
}

export class RefundDiscoveryService {
  constructor(private readonly client: PactPrivacyClient) {}

  async list(input: { chainId: number; leafIndex?: number }): Promise<RefundableDeposit[]> {
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt refund data");
    const { config, runtime } = await this.client.chain(input.chainId);
    const keyPair = await deriveEncryptionKeyPair(password, this.client.signer, config.family);
    const web3 = new Web3Service(config, runtime);
    const tokenCache = new Map<string, Promise<TokenDetails>>();
    const depositions = (await this.client.backend.depositions(input.chainId)).filter((deposition) => (
      (input.leafIndex === undefined || deposition.leaf_index === input.leafIndex)
      && deposition.can_refund === 1
      && deposition.is_refunded !== true
      && deposition.is_refunded !== 1
      && deposition.enc_content !== null
    ));
    const results: RefundableDeposit[] = [];

    for (const deposition of depositions) {
      const content = parseRefundContent(decryptMessage(deposition.enc_content!, keyPair.secretKey));
      const tokenAddress = normalizeAddress(content.token, config.family);
      let state: Awaited<ReturnType<typeof refundState>>;
      try {
        state = await refundState(web3, content);
      } catch (error) {
        if (noLongerRefundable(error)) continue;
        throw error;
      }
      const native = tokenAddress === "0x0000000000000000000000000000000000000000";
      let symbol: string;
      let decimals: number;
      if (native) {
        symbol = config.nativeCurrency?.symbol ?? "native";
        decimals = config.nativeCurrency?.decimals ?? (config.family === "tron" ? 6 : 18);
      } else {
        let tokenRequest = tokenCache.get(tokenAddress);
        if (!tokenRequest) {
          tokenRequest = web3.token(tokenAddress);
          tokenCache.set(tokenAddress, tokenRequest);
        }
        const token = await tokenRequest;
        symbol = content.tokenSymbol ?? token.symbol;
        decimals = token.decimals;
      }
      if (content.decimals !== undefined && content.decimals !== decimals) {
        throw new Error(`Encrypted refund token decimals do not match the chain for deposit leaf ${deposition.leaf_index}`);
      }
      results.push({
        chainId: input.chainId,
        leafIndex: deposition.leaf_index,
        token: { address: tokenAddress, symbol, decimals },
        tier: content.tier,
        totalAllocated: amount(state.totalAllocated, decimals),
        totalWithdrawn: amount(state.totalClaimed, decimals),
        refundableAmount: amount(state.refundAmount, decimals),
      });
    }
    return results;
  }
}
