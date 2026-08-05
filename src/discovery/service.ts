import { deriveEncryptionKeyPair } from "../crypto/account.js";
import { decryptMessage } from "../crypto/messages.js";
import { poseidonHash } from "../proof/poseidon.js";
import type { ChainFamily, DepositionRecord, RegisteredReceiver } from "../core/types.js";
import { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { normalizeAddress } from "../chain/address.js";

type WithdrawMessage = {
  nullifier: string;
  amount: string;
  token: string;
  decimals?: number;
  tokenSymbol?: string;
  leafIndex: number;
  tier: number;
};

function parseWithdrawMessage(value: string): WithdrawMessage {
  const parsed = JSON.parse(value) as Partial<WithdrawMessage>;
  if (
    typeof parsed.nullifier !== "string"
    || typeof parsed.amount !== "string"
    || typeof parsed.token !== "string"
    || !Number.isSafeInteger(parsed.leafIndex)
    || !Number.isSafeInteger(parsed.tier)
  ) throw new Error("Encrypted allocation has an invalid payload");
  return parsed as WithdrawMessage;
}

export class DiscoveryService {
  constructor(private readonly client: PactPrivacyClient) {}

  chains() {
    return this.client.backend.chains();
  }

  async receivers(family?: ChainFamily, address?: string): Promise<Array<RegisteredReceiver & { family: ChainFamily }>> {
    const families = family
      ? [family]
      : [...new Set((await this.client.backend.apiKeyIdentity()).grants.map((grant) => grant.family))];
    const rows = (await Promise.all(families.map(async (selected) => (
      await this.client.backend.users(selected)
    ).map((row) => ({ ...row, family: selected }))))).flat();
    if (!address) return rows;
    return rows.filter((row) => {
      try {
        return normalizeAddress(row.address, row.family) === normalizeAddress(address, row.family);
      } catch {
        return false;
      }
    });
  }

  async depositions(chainId: number, leafIndex?: number): Promise<DepositionRecord[]> {
    await this.client.chain(chainId);
    const rows = await this.client.backend.depositions(chainId);
    return leafIndex === undefined ? rows : rows.filter((row) => row.leaf_index === leafIndex);
  }

  async allocations(chainId: number, password: string, unwithdrawnOnly: boolean): Promise<Array<Record<string, unknown>>> {
    const { config, runtime } = await this.client.chain(chainId);
    const keyPair = await deriveEncryptionKeyPair(password, this.client.signer, config.family);
    const web3 = new Web3Service(config, runtime);
    const messages = await this.client.backend.messages(chainId);
    const rows = await Promise.all(messages.map(async (message) => {
      const info = parseWithdrawMessage(decryptMessage(message.content, keyPair.secretKey));
      const nullifierHashValue = await poseidonHash([BigInt(info.nullifier)]);
      const nullifierHash = `0x${nullifierHashValue.toString(16).padStart(64, "0")}`;
      const state = await web3.claimedState(nullifierHash);
      const total = BigInt(info.amount);
      const remaining = total > state.claimed ? total - state.claimed : 0n;
      return {
        id: message.id,
        chainId,
        leafIndex: info.leafIndex,
        token: info.token,
        ...(info.tokenSymbol ? { tokenSymbol: info.tokenSymbol } : {}),
        ...(info.decimals !== undefined ? { decimals: info.decimals } : {}),
        tier: info.tier,
        amount: total.toString(),
        claimed: state.claimed.toString(),
        remaining: remaining.toString(),
        nonce: state.nonce.toString(),
        refunded: state.refunded,
        withdrawable: remaining > 0n && !state.refunded,
      };
    }));
    return unwithdrawnOnly ? rows.filter((row) => row.withdrawable === true) : rows;
  }
}
