import { AccountStore, normalizeAccountAddress } from "./store.js";
import { resolveAccountContext, type AccountContext } from "./context.js";

export type McpAccountSelection = {
  selected: AccountContext;
  allowedAddresses: ReadonlySet<`0x${string}`>;
};

export async function resolveMcpAccounts(store = new AccountStore()): Promise<McpAccountSelection> {
  const selected = await resolveAccountContext({ store });
  const configured = process.env.PACT_PRIVACY_MCP_ACCOUNTS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeAccountAddress);
  const allowedAddresses = new Set<`0x${string}`>(configured?.length ? configured : [selected.address]);
  if (!allowedAddresses.has(selected.address)) {
    throw new Error(`Default MCP account ${selected.address} is not in PACT_PRIVACY_MCP_ACCOUNTS`);
  }
  for (const address of allowedAddresses) {
    if (selected.source === "environment" && address === selected.address) continue;
    await store.get(address);
  }
  return { selected, allowedAddresses };
}
