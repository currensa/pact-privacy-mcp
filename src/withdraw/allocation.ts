import { deriveEncryptionKeyPair, decryptOwnSecret } from "../crypto/account.js";
import { decryptMessage } from "../crypto/messages.js";
import { parseWithdrawMessage, type WithdrawMessage } from "../discovery/service.js";
import type { PactPrivacyClient } from "../runtime/client.js";

export async function decryptAllocation(
  client: PactPrivacyClient,
  chainId: number,
  allocationId: number,
  password: string,
): Promise<{ info: WithdrawMessage; rawSecret: string }> {
  const { config } = await client.chain(chainId);
  const message = (await client.backend.messages(chainId)).find((row) => row.id === allocationId);
  if (!message) throw new Error(`Allocation ${allocationId} was not found`);
  const account = await client.backend.account(config.family);
  if (!account.found || !account.encryptedSecret) throw new Error("Account is not initialized");
  const keyPair = await deriveEncryptionKeyPair(password, client.signer, config.family);
  const info = parseWithdrawMessage(decryptMessage(message.content, keyPair.secretKey));
  return { info, rawSecret: decryptOwnSecret(account.encryptedSecret, keyPair.secretKey) };
}
