import { deriveEncryptionKeyPair, decryptOwnSecret } from "../crypto/account.js";
import { decryptMessage } from "../crypto/messages.js";
import { parseWithdrawMessage, type WithdrawMessage } from "../discovery/service.js";
import { normalizeAddress } from "../chain/address.js";
import { poseidonHash } from "../proof/poseidon.js";
import type { PactPrivacyClient } from "../runtime/client.js";

export async function decryptAllocation(
  client: PactPrivacyClient,
  chainId: number,
  allocationId: string,
  password: string,
): Promise<{ info: WithdrawMessage; rawSecret: string; source: "payroll" | "defi" }> {
  const { config } = await client.chain(chainId);
  const message = (await client.backend.messages(chainId)).find((row) => row.id === allocationId);
  if (!message) throw new Error(`Allocation ${allocationId} was not found`);
  if (normalizeAddress(message.recipient, config.family) !== client.signer.address(config.family)) {
    throw new Error("Organization allocation belongs to a different wallet");
  }
  const account = await client.backend.account(config.family);
  if (!account.found || !account.encryptedSecret) throw new Error("Account is not initialized");
  if (account.encryptedSecret !== message.encryptedSecret) throw new Error("Organization allocation secret differs from the current profile");
  const keyPair = await deriveEncryptionKeyPair(password, client.signer, config.family);
  const info = parseWithdrawMessage(decryptMessage(message.content, keyPair.secretKey), message);
  const leaf = await poseidonHash([BigInt(info.authRoot), BigInt(info.depositorSecretHash)]);
  if (leaf !== BigInt(message.depositLeaf)) throw new Error("Encrypted allocation deposit leaf mismatch");
  return { info, rawSecret: decryptOwnSecret(message.encryptedSecret, keyPair.secretKey), source: message.source };
}
