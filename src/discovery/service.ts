import { deriveEncryptionKeyPair } from "../crypto/account.js";
import { decryptMessage } from "../crypto/messages.js";
import { poseidonHash } from "../proof/poseidon.js";
import type { ChainFamily, DepositionRecord, EncryptedAllocation, RegisteredReceiver } from "../core/types.js";
import { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { normalizeAddress } from "../chain/address.js";

export type WithdrawMessage = {
  nullifier: string;
  amount: string;
  token: string;
  decimals?: number;
  tokenSymbol?: string;
  leafIndex: number;
  tier: number;
  authRoot: string;
  depositorSecretHash: string;
  authPathElements: string[];
  authPathIndices: number[];
};

export function parseWithdrawMessage(value: string, envelope: EncryptedAllocation): WithdrawMessage {
  const parsed = JSON.parse(value) as Partial<WithdrawMessage>;
  if ((parsed.token && normalizeAddress(parsed.token, "evm") !== normalizeAddress(envelope.token, "evm"))
    || (parsed.tier !== undefined && parsed.tier !== envelope.tier)
    || (parsed.leafIndex !== undefined && parsed.leafIndex !== envelope.leafIndex)) {
    throw new Error("Encrypted allocation does not match its Organization record");
  }
  const info = { ...parsed, token: envelope.token, tier: envelope.tier, leafIndex: envelope.leafIndex };
  if (
    typeof info.nullifier !== "string"
    || typeof info.amount !== "string"
    || typeof info.token !== "string"
    || !Number.isSafeInteger(info.leafIndex)
    || !Number.isSafeInteger(info.tier)
    || typeof info.authRoot !== "string"
    || typeof info.depositorSecretHash !== "string"
    || !Array.isArray(info.authPathElements)
    || !Array.isArray(info.authPathIndices)
  ) throw new Error("Encrypted allocation has an invalid payload");
  return info as WithdrawMessage;
}

export class DiscoveryService {
  constructor(private readonly client: PactPrivacyClient) {}

  chains() {
    return this.client.backend.chains();
  }

  async organizations() {
    return (await this.client.backend.organizations()).map(({ organization, member }) => ({
      orgId: organization.orgId,
      name: organization.orgName,
      status: member.status,
      roles: member.roles.map(({ role }) => role),
    }));
  }

  async receivers(orgId: string, address?: string): Promise<Array<RegisteredReceiver & { family: ChainFamily }>> {
    const rows = (await this.client.backend.users("evm", orgId)).map((row) => ({ ...row, family: "evm" as const }));
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
      if (normalizeAddress(message.recipient, config.family) !== this.client.signer.address(config.family)) {
        throw new Error("Organization allocation belongs to a different wallet");
      }
      const info = parseWithdrawMessage(decryptMessage(message.content, keyPair.secretKey), message);
      const leaf = await poseidonHash([BigInt(info.authRoot), BigInt(info.depositorSecretHash)]);
      if (leaf !== BigInt(message.depositLeaf)) throw new Error("Encrypted allocation deposit leaf mismatch");
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
