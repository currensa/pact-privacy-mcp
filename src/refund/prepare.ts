import { normalizeAddress } from "../chain/address.js";
import { OperationService } from "../operations/service.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { asCircuitTier, decryptRefund } from "./content.js";
import { refundState } from "./state.js";
import type { RefundPlan } from "./types.js";

export class RefundPreparationService {
  constructor(private readonly client: PactPrivacyClient, private readonly operations = new OperationService()) {}

  async prepare(input: { chainId: number; leafIndex: number }) {
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt refund data");
    const { config, runtime } = await this.client.chain(input.chainId);
    const { content } = await decryptRefund(this.client, input.chainId, input.leafIndex, password);
    const token = normalizeAddress(content.token, config.family);
    const native = token === "0x0000000000000000000000000000000000000000";
    const web3 = new Web3Service(config, runtime);
    const details = native ? null : await web3.token(token);
    const decimals = details?.decimals ?? (config.nativeCurrency?.decimals ?? (config.family === "tron" ? 6 : 18));
    if (content.decimals !== undefined && content.decimals !== decimals) {
      throw new Error("Encrypted refund token decimals do not match the chain");
    }
    const state = await refundState(web3, content);
    const signer = normalizeAddress(this.client.signer.address(config.family), config.family);
    const plan: RefundPlan = {
      leafIndex: input.leafIndex,
      token,
      tokenSymbol: content.tokenSymbol ?? details?.symbol ?? config.nativeCurrency?.symbol ?? "native",
      decimals,
      tier: asCircuitTier(content.tier),
      depositLeaf: content.depositLeaf,
      totalAllocated: state.totalAllocated.toString(),
      totalClaimedAtPreparation: state.totalClaimed.toString(),
      refundAmountAtPreparation: state.refundAmount.toString(),
      feeAtPreparation: state.fee.toString(),
      netRefundAtPreparation: (state.refundAmount - state.fee).toString(),
      refunder: signer,
      relayer: signer,
      expectedTransactions: ["refund"],
    };
    return this.operations.prepare("refund", input.chainId, plan);
  }
}
