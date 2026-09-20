import { Interface } from "ethers";
import { normalizeAddress } from "../chain/address.js";
import type { RegisteredReceiver } from "../core/types.js";
import { encryptMessage } from "../crypto/messages.js";
import { GRAVARC_DEPOSIT_ABI, PACT_PRIVACY_DEFI_ROUTER_ABI } from "../deposit/abi.js";
import type { DepositDelivery } from "../deposit/payload-store.js";
import { DepositProofService } from "../deposit/proof.js";
import { depositRegistryDigest, NATIVE_TOKEN } from "../deposit/prepare.js";
import type { DepositReceiver } from "../deposit/types.js";
import type { OperationRecord } from "../operations/types.js";
import { poseidonHash } from "../proof/poseidon.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { decryptAllocation } from "../withdraw/allocation.js";
import { WithdrawProofService } from "../withdraw/proof.js";
import { buildSwapCalls, quoteDefi } from "./adapter.js";
import { computeDefiCommitment } from "./commitment.js";
import type { DefiCall, DefiPlan } from "./types.js";

const erc20 = new Interface(["function approve(address spender,uint256 amount)", "function transfer(address to,uint256 amount)"]);
const gravArc = new Interface(GRAVARC_DEPOSIT_ABI);
const defiRouter = new Interface(PACT_PRIVACY_DEFI_ROUTER_ABI);
const pureRouter = new Interface(["function sweepRemaining(address token,address recipient)"]);

export function defiPlanFrom(operation: OperationRecord, kind: "defi" | "relayed-defi"): DefiPlan {
  if (operation.kind !== kind) throw new Error(`Operation ${operation.id} is not ${kind}`);
  const plan = operation.plan as Partial<DefiPlan>;
  if (!Number.isSafeInteger(plan.allocationId) || !Number.isSafeInteger(plan.leafIndex)
    || typeof plan.inputToken !== "string" || typeof plan.outputToken !== "string"
    || typeof plan.swapAmount !== "string" || typeof plan.minimumOutput !== "string"
    || typeof plan.defiFee !== "string" || typeof plan.totalWithdrawal !== "string"
    || typeof plan.privateRedeposit !== "boolean" || !plan.protocol) {
    throw new Error("DeFi operation plan is invalid");
  }
  return plan as DefiPlan;
}

function registered(row: RegisteredReceiver, family: "evm" | "tron") {
  if (!/^0x[0-9a-fA-F]{64}$/.test(row.secretHash) || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(row.encPubkey)) {
    throw new Error(`Receiver registration is invalid: ${row.address}`);
  }
  return { ...row, address: normalizeAddress(row.address, family) };
}

async function redepositReceivers(client: PactPrivacyClient, operation: OperationRecord, plan: DefiPlan): Promise<{ receivers: DepositReceiver[]; depositorSecretHash?: string; depositorEncPubkey: string | null }> {
  const { config } = await client.chain(operation.chainId);
  if (config.family === "tron") throw new Error("Private re-deposit is not supported on TRON");
  if (!plan.recipients || !plan.registryDigest) throw new Error("Private re-deposit recipients are unavailable");
  const rows = (await client.backend.users(config.family)).map((row) => registered(row, config.family));
  const receivers = plan.recipients.map((recipient) => {
    const account = rows.find((row) => row.address === recipient.address);
    if (!account) throw new Error(`Receiver is no longer registered: ${recipient.address}`);
    return { address: recipient.address, amount: BigInt(recipient.amount), secretHash: account.secretHash, encPubkey: account.encPubkey };
  });
  const digest = depositRegistryDigest(receivers.map((receiver) => ({ address: receiver.address, account: receiver.secretHash, key: receiver.encPubkey })));
  if (digest !== plan.registryDigest) throw new Error("Receiver registration changed; prepare a new DeFi operation");
  if (!plan.refund) return { receivers, depositorEncPubkey: null };
  const account = await client.backend.account(config.family);
  if (!account.found || !account.secretHash || !account.encPubkey) throw new Error("Depositor account data is unavailable for refund support");
  if (depositRegistryDigest({ account: account.secretHash, key: account.encPubkey }) !== plan.depositorRegistryDigest) {
    throw new Error("Depositor account data changed; prepare a new DeFi operation");
  }
  return { receivers, depositorSecretHash: account.secretHash, depositorEncPubkey: account.encPubkey };
}

function delivery(operation: OperationRecord, plan: DefiPlan, proof: Awaited<ReturnType<DepositProofService["generate"]>>, receivers: DepositReceiver[], depositorEncPubkey: string | null): DepositDelivery {
  const batchId = `df_${operation.id}`;
  return {
    predictedLeafIndex: proof.leafIndex,
    deposition: {
      encContent: proof.canRefund === 1 && depositorEncPubkey ? encryptMessage(JSON.stringify({
        token: plan.outputToken, tokenSymbol: plan.outputTokenSymbol, decimals: plan.outputDecimals, tier: proof.tier,
        authRoot: proof.authRoot, depositLeaf: proof.depositLeaf, depositorSecretHash: proof.depositorSecretHash,
        refundEntries: proof.refundEntries,
      }), depositorEncPubkey) : null,
      canRefund: proof.canRefund,
      depositInfo: JSON.stringify({ depositorSecretHash: proof.depositorSecretHash, encPubkey: depositorEncPubkey }),
    },
    messages: proof.receivers.map((receiver, index) => ({
      address: receiver.address,
      content: encryptMessage(JSON.stringify({
        nullifier: receiver.nullifier, amount: receiver.amount, token: plan.outputToken, decimals: plan.outputDecimals,
        tokenSymbol: plan.outputTokenSymbol, authRoot: proof.authRoot, depositorSecretHash: proof.depositorSecretHash,
        authPathElements: receiver.authPathElements, authPathIndices: receiver.authPathIndices,
        leafIndex: proof.leafIndex, tier: proof.tier,
      }), receiver.encPubkey),
      secretHash: receivers[index]!.secretHash,
      encPubkey: receivers[index]!.encPubkey,
      clientMessageId: `${batchId}:${index}`,
    })),
  };
}

export async function buildDefiCalldata(client: PactPrivacyClient, operation: OperationRecord, plan: DefiPlan): Promise<{ calldata: string; delivery?: DepositDelivery }> {
  const selected = await client.chain(operation.chainId);
  if (!selected.config.pureRouter || !selected.config.pactPrivacyDefiRouter) throw new Error("DeFi routers are not configured");
  if (plan.privateRedeposit && selected.config.family === "tron") throw new Error("Private re-deposit is not supported on TRON");
  const password = client.environment.password;
  if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt the allocation");
  const { info, rawSecret } = await decryptAllocation(client, operation.chainId, plan.allocationId, password);
  if (info.leafIndex !== plan.leafIndex || info.tier !== plan.tier || info.amount !== plan.allocationAmount
    || normalizeAddress(info.token, selected.config.family) !== plan.inputToken) {
    throw new Error("Encrypted allocation no longer matches the prepared DeFi operation");
  }
  const web3 = new Web3Service(selected.config, selected.runtime);
  const nullifierHashValue = await poseidonHash([BigInt(info.nullifier)]);
  const state = await web3.claimedState(`0x${nullifierHashValue.toString(16).padStart(64, "0")}`);
  if (state.refunded) throw new Error("This allocation was refunded");
  const totalWithdrawal = BigInt(plan.swapAmount) + BigInt(plan.defiFee);
  if (totalWithdrawal !== BigInt(plan.totalWithdrawal) || state.claimed + totalWithdrawal > BigInt(info.amount)) {
    throw new Error("The prepared DeFi amount exceeds the current remaining allocation");
  }
  const quote = await quoteDefi({
    chain: selected.config, runtime: selected.runtime, protocol: plan.protocol,
    inputToken: plan.inputToken, outputToken: plan.outputToken, amount: BigInt(plan.swapAmount),
    inputDecimals: plan.inputDecimals, outputDecimals: plan.outputDecimals, slippageBips: BigInt(plan.slippageBips),
  });
  if (quote.minimumOutput < BigInt(plan.minimumOutput) || quote.estimatedOutput < BigInt(plan.minimumOutput)) {
    throw new Error("The refreshed DeFi quote is below the prepared minimum output");
  }
  if (plan.protocol.outputBehavior === "fixed" && quote.estimatedOutput !== BigInt(plan.estimatedOutput)) {
    throw new Error("The fixed-output quote changed; prepare a new DeFi operation");
  }
  const destination = plan.privateRedeposit ? selected.config.pureRouter : plan.destination;
  if (!destination) throw new Error("DeFi destination is unavailable");
  const swap = buildSwapCalls({
    chainId: operation.chainId, family: selected.config.family,
    protocol: plan.protocol, inputToken: plan.inputToken, outputToken: plan.outputToken,
    amount: BigInt(plan.swapAmount), quote, pureRouter: selected.config.pureRouter, destination,
    slippageBips: BigInt(plan.slippageBips),
    ...(plan.privateRedeposit ? { requiredOutput: (plan.recipients ?? []).reduce((sum, entry) => sum + BigInt(entry.amount), 0n) } : {}),
  });
  const calls: DefiCall[] = [...swap.calls];
  let depositDelivery: DepositDelivery | undefined;
  if (plan.privateRedeposit) {
    const data = await redepositReceivers(client, operation, plan);
    const proof = await new DepositProofService(client.backend, client.proofs).generate({
      receivers: data.receivers, token: BigInt(plan.outputToken), chainId: operation.chainId, refund: plan.refund,
      ...(data.depositorSecretHash ? { depositorSecretHash: data.depositorSecretHash } : {}),
    });
    if (plan.outputToken !== NATIVE_TOKEN) calls.push({
      target: plan.outputToken, value: 0n,
      data: erc20.encodeFunctionData("approve", [selected.config.gravArc, proof.totalAmount]) as `0x${string}`,
    });
    calls.push({
      target: selected.config.gravArc, value: plan.outputToken === NATIVE_TOKEN ? proof.totalAmount : 0n,
      data: gravArc.encodeFunctionData("deposit", [{
        pA: proof.proof.pA.map(BigInt), pB: proof.proof.pB.map((row) => row.map(BigInt)), pC: proof.proof.pC.map(BigInt),
        newRoot: BigInt(proof.newDepositRoot), depositLeaf: BigInt(proof.depositLeaf), totalAmount: proof.totalAmount,
        token: plan.outputToken, tier: proof.tier,
      }]) as `0x${string}`,
    });
    if (plan.protocol.outputBehavior === "variable") {
      if (!plan.excessRecipient) throw new Error("Variable-output private re-deposit requires an excess recipient");
      calls.push({
        target: selected.config.pureRouter, value: 0n,
        data: pureRouter.encodeFunctionData("sweepRemaining", [plan.outputToken, plan.excessRecipient]) as `0x${string}`,
      });
    }
    depositDelivery = delivery(operation, plan, proof, data.receivers, data.depositorEncPubkey);
  } else if (swap.outputLocation === "pure-router") {
    if (plan.protocol.outputBehavior === "variable") {
      calls.push({
        target: selected.config.pureRouter,
        value: 0n,
        data: pureRouter.encodeFunctionData("sweepRemaining", [plan.outputToken, destination]) as `0x${string}`,
      });
    } else {
      calls.push(plan.outputToken === NATIVE_TOKEN
        ? { target: destination, value: quote.estimatedOutput, data: "0x" }
        : { target: plan.outputToken, value: 0n, data: erc20.encodeFunctionData("transfer", [destination, quote.estimatedOutput]) as `0x${string}` });
    }
  }
  const commitment = computeDefiCommitment(BigInt(plan.defiFee), calls);
  const withdraw = await new WithdrawProofService(client.backend, client.proofs).generate({
    chainId: operation.chainId, info, rawSecret, recipient: commitment,
    relayer: selected.config.pactPrivacyDefiRouter, claimedAmount: state.claimed, nonce: state.nonce,
    expectedAmount: totalWithdrawal, fee: totalWithdrawal,
  });
  const calldata = defiRouter.encodeFunctionData("defiRouting", [{
    pA: withdraw.proof.pA.map(BigInt), pB: withdraw.proof.pB.map((row) => row.map(BigInt)), pC: withdraw.proof.pC.map(BigInt),
    nullifierHash: withdraw.nullifierHash, recipient: withdraw.recipient, claimedAmount: withdraw.claimedAmount,
    token: withdraw.token, tier: withdraw.tier, depositRoot: withdraw.depositRoot, expectedAmount: withdraw.expectedAmount,
    fee: withdraw.fee, relayer: withdraw.relayer, nonce: withdraw.nonce,
  }, { defiFee: BigInt(plan.defiFee), defiCalls: calls }]);
  return { calldata, ...(depositDelivery ? { delivery: depositDelivery } : {}) };
}
