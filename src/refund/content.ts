import { deriveEncryptionKeyPair, decryptOwnSecret } from "../crypto/account.js";
import { decryptMessage } from "../crypto/messages.js";
import type { DepositionRecord } from "../core/types.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import type { CircuitTier } from "../proof/artifact-cache.js";
import type { RefundContent } from "./types.js";

const TIERS = new Set([8, 16, 32, 64, 128]);

export function parseRefundContent(value: string): RefundContent {
  const parsed = JSON.parse(value) as Partial<RefundContent>;
  if (
    typeof parsed.token !== "string"
    || !Number.isSafeInteger(parsed.tier)
    || !TIERS.has(parsed.tier as number)
    || typeof parsed.authRoot !== "string"
    || typeof parsed.depositLeaf !== "string"
    || typeof parsed.depositorSecretHash !== "string"
    || !Array.isArray(parsed.refundEntries)
    || parsed.refundEntries.length !== parsed.tier
    || parsed.refundEntries.some((entry) => (
      typeof entry?.nullifier !== "string"
      || typeof entry?.secretHash !== "string"
      || typeof entry?.amount !== "string"
    ))
  ) throw new Error("Encrypted refund content has an invalid payload");
  return parsed as RefundContent;
}

export async function decryptRefund(
  client: PactPrivacyClient,
  chainId: number,
  leafIndex: number,
  password: string,
): Promise<{ deposition: DepositionRecord; content: RefundContent; rawSecret: string }> {
  const { config } = await client.chain(chainId);
  const deposition = (await client.backend.depositions(chainId)).find((row) => row.leaf_index === leafIndex);
  if (!deposition) throw new Error(`Deposit leaf ${leafIndex} was not found`);
  if (deposition.can_refund !== 1) throw new Error("This deposit does not support refunds");
  if (deposition.is_refunded === true || deposition.is_refunded === 1) throw new Error("This deposit is already marked as refunded");
  if (!deposition.enc_content) throw new Error("Encrypted refund content is unavailable");
  const account = await client.backend.account(config.family);
  if (!account.found || !account.encryptedSecret) throw new Error("Account is not initialized");
  const keyPair = await deriveEncryptionKeyPair(password, client.signer, config.family);
  const content = parseRefundContent(decryptMessage(deposition.enc_content, keyPair.secretKey));
  return { deposition, content, rawSecret: decryptOwnSecret(account.encryptedSecret, keyPair.secretKey) };
}

export function asCircuitTier(value: number): CircuitTier {
  if (!TIERS.has(value)) throw new Error(`Unsupported refund tier: ${value}`);
  return value as CircuitTier;
}
