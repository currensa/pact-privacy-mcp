import type { ChainFamily } from "../core/types.js";
import { AccountStore, normalizeAccountAddress } from "../accounts/store.js";
import { resolveAccountContext, type AccountContext } from "../accounts/context.js";
import type { McpAccountSelection } from "../accounts/mcp.js";
import { PactPrivacyClient } from "../runtime/client.js";
import { OperationService } from "../operations/service.js";
import { DiscoveryService } from "../discovery/service.js";
import { Web3Service } from "../web3/service.js";
import { DepositPreparationService } from "../deposit/prepare.js";
import { DepositExecutionService } from "../deposit/execute.js";
import { WithdrawPreparationService } from "../withdraw/prepare.js";
import { WithdrawExecutionService } from "../withdraw/execute.js";
import { RefundPreparationService } from "../refund/prepare.js";
import { RefundExecutionService } from "../refund/execute.js";
import { RelayedWithdrawExecutionService } from "../relayed-withdraw/execute.js";
import { RelayedRefundExecutionService } from "../relayed-refund/execute.js";
import { DefiExecutionService } from "../defi/execute.js";
import { RelayedDefiExecutionService } from "../relayed-defi/execute.js";

type Services = {
  context: AccountContext;
  client: PactPrivacyClient;
  operations: OperationService;
};

export class McpWorkflows {
  private readonly store = new AccountStore();

  constructor(private readonly accounts: McpAccountSelection) {}

  async listAccounts() {
    return (await this.store.list()).filter((profile) => this.accounts.allowedAddresses.has(profile.address));
  }

  private async context(account?: string): Promise<AccountContext> {
    if (!account) return this.accounts.selected;
    const address = normalizeAccountAddress(account);
    if (!this.accounts.allowedAddresses.has(address)) throw new Error(`MCP account is not allowed: ${address}`);
    if (address === this.accounts.selected.address) return this.accounts.selected;
    return resolveAccountContext({ account: address, store: this.store });
  }

  async run<T>(account: string | undefined, action: (services: Services) => Promise<T>): Promise<T> {
    const context = await this.context(account);
    const client = new PactPrivacyClient(context.environment);
    const operations = new OperationService(context.operations, Date.now, context.address);
    try {
      return await action({ context, client, operations });
    } finally {
      await client.close();
    }
  }

  async web3(client: PactPrivacyClient, chainId: number): Promise<Web3Service> {
    const selected = await client.chain(chainId);
    return new Web3Service(selected.config, selected.runtime);
  }

  async resume(client: PactPrivacyClient, operations: OperationService, operationId: string): Promise<unknown> {
    const operation = await operations.get(operationId);
    if (operation.stage === "prepared") {
      return { operation, nextAction: `Execute the prepared ${operation.kind} operation with explicit confirmation` };
    }
    if (operation.stage === "completed" || operation.stage === "expired" || operation.stage === "cancelled") {
      return { operation, nextAction: null };
    }
    if (operation.kind === "deposit") return new DepositExecutionService(client, operations).execute(operation.id);
    if (operation.kind === "withdraw") return new WithdrawExecutionService(client, operations).execute(operation.id);
    if (operation.kind === "refund") return new RefundExecutionService(client, operations).execute(operation.id);
    if (operation.kind === "relayed-withdraw") return new RelayedWithdrawExecutionService(client, operations).execute(operation.id);
    if (operation.kind === "relayed-refund") return new RelayedRefundExecutionService(client, operations).execute(operation.id);
    if (operation.kind === "defi") return new DefiExecutionService(client, operations).execute(operation.id);
    if (operation.kind === "relayed-defi") return new RelayedDefiExecutionService(client, operations).execute(operation.id);
    throw new Error(`Operation kind is not implemented: ${operation.kind}`);
  }

  discovery(client: PactPrivacyClient): DiscoveryService {
    return new DiscoveryService(client);
  }

  addresses(client: PactPrivacyClient, family?: ChainFamily): Array<Record<string, string>> {
    const families: ChainFamily[] = family ? [family] : ["evm", "tron"];
    return families.map((selected) => ({
      family: selected,
      address: client.signer.displayAddress(selected),
      canonicalAddress: client.signer.address(selected),
    }));
  }

  prepareDeposit(client: PactPrivacyClient, operations: OperationService, input: {
    orgId: string;
    chainId: number;
    token: string;
    recipients: Array<{ address: string; amount: string }>;
    refund: boolean;
  }) {
    return new DepositPreparationService(client, operations).prepare(input);
  }

  prepareWithdraw(client: PactPrivacyClient, operations: OperationService, input: {
    chainId: number;
    allocationId: string;
    amount?: string;
    all: boolean;
    recipient?: string;
  }) {
    return new WithdrawPreparationService(client, operations).prepare(input);
  }

  prepareRefund(client: PactPrivacyClient, operations: OperationService, chainId: number, leafIndex: number) {
    return new RefundPreparationService(client, operations).prepare({ chainId, leafIndex });
  }
}
