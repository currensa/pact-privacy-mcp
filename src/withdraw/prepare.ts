import { normalizeAddress } from "../chain/address.js";
import type { ChainFamily } from "../core/types.js";
import type { CircuitTier } from "../proof/artifact-cache.js";
import { poseidonHash } from "../proof/poseidon.js";
import { OperationService } from "../operations/service.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { decryptAllocation } from "./allocation.js";
import type { WithdrawPlan } from "./types.js";

const TIERS = new Set([8, 16, 32, 64, 128]);

export function directWithdrawParties(
  signerAddress: string,
  recipient: string | undefined,
  family: ChainFamily,
): { recipient: `0x${string}`; relayer: `0x${string}` } {
  const relayer = normalizeAddress(signerAddress, family);
  return {
    recipient: normalizeAddress(recipient ?? relayer, family),
    relayer,
  };
}

export class WithdrawPreparationService {
  constructor(private readonly client: PactPrivacyClient, private readonly operations = new OperationService()) {}

  async prepare(input: { chainId: number; allocationId: number; amount?: string; all: boolean; recipient?: string }) {
    if (input.all === (input.amount !== undefined)) throw new Error("Choose exactly one of --amount or --all");
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt the allocation");
    const { config, runtime } = await this.client.chain(input.chainId);
    const web3 = new Web3Service(config, runtime);
    const { info } = await decryptAllocation(this.client, input.chainId, input.allocationId, password);
    if (!TIERS.has(info.tier)) throw new Error(`Unsupported withdrawal tier: ${info.tier}`);
    const token = normalizeAddress(info.token, config.family);
    const native = token === "0x0000000000000000000000000000000000000000";
    const details = native ? null : await web3.token(token);
    const decimals = details?.decimals ?? (config.nativeCurrency?.decimals ?? (config.family === "tron" ? 6 : 18));
    const tokenSymbol = info.tokenSymbol ?? details?.symbol ?? config.nativeCurrency?.symbol ?? "native";
    if (info.decimals !== undefined && info.decimals !== decimals) {
      throw new Error("Encrypted allocation token decimals do not match the chain");
    }
    const nullifierHashValue = await poseidonHash([BigInt(info.nullifier)]);
    const nullifierHash = `0x${nullifierHashValue.toString(16).padStart(64, "0")}`;
    const state = await web3.claimedState(nullifierHash);
    const total = BigInt(info.amount);
    if (state.refunded) throw new Error("This allocation was refunded");
    const remaining = total - state.claimed;
    if (remaining <= 0n) throw new Error("Nothing remains to withdraw");
    const expectedAmount = input.all ? remaining : web3.parseTokenAmount(input.amount!, decimals);
    if (expectedAmount <= 0n || expectedAmount > remaining) throw new Error("Withdrawal amount exceeds the remaining allocation");
    const fee = (expectedAmount + 999n) / 1000n;
    const { recipient, relayer } = directWithdrawParties(
      this.client.signer.address(config.family),
      input.recipient,
      config.family,
    );
    const plan: WithdrawPlan = {
      allocationId: input.allocationId,
      leafIndex: info.leafIndex,
      token,
      tokenSymbol,
      decimals,
      tier: info.tier as CircuitTier,
      allocationAmount: total.toString(),
      claimedAtPreparation: state.claimed.toString(),
      nonceAtPreparation: state.nonce.toString(),
      expectedAmount: expectedAmount.toString(),
      fee: fee.toString(),
      netAmount: (expectedAmount - fee).toString(),
      recipient,
      relayer,
      expectedTransactions: ["withdraw"],
    };
    return this.operations.prepare("withdraw", input.chainId, plan);
  }
}
