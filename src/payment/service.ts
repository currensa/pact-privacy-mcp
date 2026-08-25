import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import type { PactPayClient } from '../client.js';
import { ERC20_ABI, GRAVARC_ABI } from './abi.js';
import { deriveNaclKeyPair, naclDecrypt, naclEncrypt, secretboxDecrypt } from './nacl-crypto.js';
import { generateDepositProof } from './deposit-proof.js';
import { computeNullifierHash, generateWithdrawProof } from './withdraw-proof.js';
import { generateRefundProof, type RefundProofResult } from './refund-proof.js';
import type { CircuitFiles } from './prover.js';

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

export type PaymentChain = {
    caipChainId: string;
    name: string;
    chainId: string;
    rpcUrls: string[];
};

export type GravArcChainConfig = {
    gravArcAddress: string;
    status: string;
    withdrawRelayerSupported: boolean;
    refundRelayerSupported: boolean;
};

export type RefundSlot = {
    nullifier: string;
    secretHash: string;
    withdrawAmount: string;
};

export type RefundPayload = {
    batchId: string;
    leafIndex: number;
    token: string;
    tier: number;
    authRoot: string;
    depositLeaf: string;
    depositorSecretHash: string;
    slots: RefundSlot[];
};

export type PaymentEnv = {
    /** Funded EVM private key (with or without 0x prefix) used to sign on-chain transactions. */
    signerKey?: string;
    /** Password for deriving the NaCl key pair (same password as the PactPay web account). */
    signerPassword?: string;
};

type GravArcUserInfo = {
    address: string;
    encryptedSecret: string;
    secretHash: string;
    encPubkey: string | null;
};

export class PactPayPaymentService {
    private chainCache: PaymentChain[] | null = null;
    private configCache = new Map<string, GravArcChainConfig>();
    private walletTokenCache: { token: string; expiresAt: number } | null = null;

    constructor(
        private readonly client: PactPayClient,
        private readonly env: PaymentEnv,
    ) {}

    // ── Signer / keys ───────────────────────────────────────────────────────

    requireSigner(): Wallet {
        const key = this.env.signerKey?.trim();
        if (!key) throw new Error('WALLET_PRIVATE_KEY is required for this operation');
        return new Wallet(key.startsWith('0x') ? key : `0x${key}`);
    }

    private requirePassword(): string {
        const password = this.env.signerPassword?.trim();
        if (!password) throw new Error('PACTPAY_SIGNER_PASSWORD is required to decrypt your GravArc account');
        return password;
    }

    private async naclKey(): Promise<Uint8Array> {
        return deriveNaclKeyPair(this.requirePassword(), this.requireSigner());
    }

    // ── Chain / proof-input data ────────────────────────────────────────────

    async listChains(): Promise<PaymentChain[]> {
        if (this.chainCache) return this.chainCache;
        const raw = (await this.client.request('/api/chain-asset/chains', { skipAuth: true })) as any[];
        this.chainCache = (raw ?? []).map((chain) => ({
            caipChainId: String(chain.caipChainId ?? ''),
            name: String(chain.name ?? ''),
            chainId: String(chain.chainId ?? ''),
            rpcUrls: Array.isArray(chain.rpcUrls) ? chain.rpcUrls : [],
        }));
        return this.chainCache;
    }

    private async chain(caipChainId: string): Promise<PaymentChain> {
        const chain = (await this.listChains()).find((entry) => entry.caipChainId === caipChainId);
        if (!chain) throw new Error(`Chain ${caipChainId} is not available`);
        return chain;
    }

    async gravArcConfig(caipChainId: string): Promise<GravArcChainConfig> {
        const cached = this.configCache.get(caipChainId);
        if (cached) return cached;
        const config = (await this.client.request(
            `/api/gravarc/config?caipChainId=${encodeURIComponent(caipChainId)}`,
            { skipAuth: true },
        )) as GravArcChainConfig;
        if (!config?.gravArcAddress) throw new Error(`GravArc is not configured for chain ${caipChainId}`);
        this.configCache.set(caipChainId, config);
        return config;
    }

    private async provider(caipChainId: string): Promise<JsonRpcProvider> {
        const chain = await this.chain(caipChainId);
        const rpcUrl = chain.rpcUrls.find((url) => url.startsWith('http'));
        if (!rpcUrl) throw new Error(`No HTTP RPC configured for chain ${caipChainId}`);
        return new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    }

    private async circuitFiles(caipChainId: string, tier: number, circuitType: 'deposit' | 'withdraw' | 'refund'): Promise<CircuitFiles> {
        return this.client.request(
            `/api/gravarc/circuit-files?caipChainId=${encodeURIComponent(caipChainId)}&tier=${tier}&circuitType=${circuitType}`,
            { skipAuth: true },
        );
    }

    private async depositPath(caipChainId: string): Promise<{ nextIndex: number; siblings: string[] }> {
        return this.client.request(`/api/gravarc/deposit-path?caipChainId=${encodeURIComponent(caipChainId)}`, { skipAuth: true });
    }

    private async depositMembershipPath(caipChainId: string, leafIndex: number): Promise<{ leafIndex: number; depositRoot: string; siblings: string[]; pathIndices: number[] }> {
        return this.client.request(
            `/api/gravarc/deposit-membership-path?caipChainId=${encodeURIComponent(caipChainId)}&leafIndex=${leafIndex}`,
            { skipAuth: true },
        );
    }

    // ── Transaction REST endpoints ──────────────────────────────────────────

    private async requireOrgId(): Promise<string> {
        if (this.client.orgId) return this.client.orgId;
        await this.client.getOrganizations();
        const resolved = this.client.orgId;
        if (!resolved) throw new Error('No organization context - log in and select an organization first');
        return resolved;
    }

    async createPrivacyDepositPlan(input: {
        caipChainId?: string;
        tokenAddress?: string;
        transactionName?: string;
        members: { memberId: string; amount: string }[];
    }): Promise<any> {
        const orgId = await this.requireOrgId();
        return this.client.request(`/api/transaction/${orgId}/privacy-deposit-plan`, { method: 'POST', body: input });
    }

    async getOrgPayrollConfig(): Promise<{ caipChainId: string; token: string } | null> {
        return this.client.getOrgPayrollConfig();
    }

    async listPaymentTokens(caipChainId?: string): Promise<any[]> {
        return this.client.listPaymentTokens(caipChainId);
    }

    async getPrivacyDepositData(batchId: string): Promise<any> {
        const orgId = await this.requireOrgId();
        return this.client.request(`/api/transaction/${orgId}/batches/${batchId}/privacy-deposit-data`);
    }

    private async confirmDeposit(batchId: string, body: any): Promise<any> {
        const orgId = await this.requireOrgId();
        return this.client.request(`/api/transaction/${orgId}/batches/${batchId}/confirm-deposit`, { method: 'POST', body });
    }

    private async getRefundPayload(batchId: string): Promise<{ encContent: string | null; depositInfo: string | null }> {
        const orgId = await this.requireOrgId();
        return this.client.request(`/api/transaction/${orgId}/batches/${batchId}/refund-payload`);
    }

    private async relayGravArcRefund(batchId: string, body: any): Promise<{ status: string; txHash: string }> {
        const orgId = await this.requireOrgId();
        return this.client.request(`/api/transaction/${orgId}/batches/${batchId}/relay-refund`, { method: 'POST', body });
    }

    async getRelayerAddress(caipChainId?: string): Promise<{
        relayerAddress: string;
        withdrawRelayerSupported: boolean;
        refundRelayerSupported: boolean;
    }> {
        const suffix = caipChainId ? `?caipChainId=${encodeURIComponent(caipChainId)}` : '';
        return this.client.request(`/api/transaction/privacy-withdraw-relayer${suffix}`);
    }

    /**
     * 获取 walletToken：用 WALLET_PRIVATE_KEY 对 nonce 做 personal_sign，换取 1 小时有效的 walletToken。
     * 后端校验签名地址 === 该用户绑定的钱包地址（即 WALLET_PRIVATE_KEY 必须与账户绑定钱包一致）。
     * 参考 pactpay-app-website/src/views/member/hooks/use-claim-all.ts:22-33。
     * walletToken 内存缓存，提前 5 分钟刷新以避免每次调用都重新签名。
     */
    private async getWalletToken(): Promise<string> {
        const now = Date.now();
        if (this.walletTokenCache && this.walletTokenCache.expiresAt > now) {
            return this.walletTokenCache.token;
        }
        const wallet = this.requireSigner();

        // 1. 获取 nonce（POST /api/auth/nonce，公开无鉴权）
        const nonceRes = (await this.client.request('/api/auth/nonce', {
            method: 'POST',
            skipAuth: true,
        })) as { nonce: string };
        const nonce = nonceRes?.nonce;
        if (!nonce) throw new Error('Failed to obtain wallet nonce');

        // 2. 钱包对 nonce 做 EIP-191 personal_sign
        const signature = await wallet.signMessage(nonce);

        // 3. 换取 walletToken（POST /api/auth/meta-pub/verify，需 API Key/session 鉴权）
        const verifyRes = (await this.client.request('/api/auth/meta-pub/verify', {
            method: 'POST',
            body: { address: wallet.address, nonce, signature },
        })) as { verified?: boolean; token?: string; reason?: string };
        if (!verifyRes?.verified || !verifyRes.token) {
            throw new Error(`Wallet verification failed: ${verifyRes?.reason ?? 'unknown'}`);
        }

        // TTL 3600s，提前 5 分钟过期以触发刷新
        this.walletTokenCache = {
            token: verifyRes.token,
            expiresAt: now + (3600 - 300) * 1000,
        };
        return verifyRes.token;
    }

    async myPayrollItems(query: { page?: number; pageSize?: number } = {}): Promise<any> {
        const walletToken = await this.getWalletToken();
        const params = new URLSearchParams();
        params.set('walletToken', walletToken);
        if (query.page) params.set('page', String(query.page));
        if (query.pageSize) params.set('pageSize', String(query.pageSize));
        return this.client.request(`/api/transaction/my-payroll-items?${params}`);
    }

    async myPayrollSummary(): Promise<any> {
        return this.client.request('/api/transaction/my-summary');
    }

    async myGravArcUserInfo(): Promise<GravArcUserInfo | null> {
        return this.client.request('/api/auth/gravarc-user-info/detail');
    }

    private async relayPrivacyWithdraw(itemId: string, body: any): Promise<{ status: string; txHash: string; recipient: string | null; fee: string | null }> {
        return this.client.request(`/api/transaction/my-payroll-items/${itemId}/relay-withdraw`, { method: 'POST', body });
    }

    async confirmWithdraw(itemId: string, txHash: string): Promise<any> {
        return this.client.request(`/api/transaction/my-payroll-items/${itemId}/confirm-withdraw`, { method: 'POST', body: { txHash } });
    }

    // ── Chain reads ─────────────────────────────────────────────────────────

    private async readClaimState(caipChainId: string, gravArcAddress: string, nullifierHash: string): Promise<{ claimed: bigint; nextNonce: bigint; refunded: boolean }> {
        const provider = await this.provider(caipChainId);
        const contract = new Contract(gravArcAddress, GRAVARC_ABI, provider);
        const [claimed, nextNonce] = (await contract.nullifierHashes(nullifierHash)) as [bigint, bigint];
        const refunded = (await contract.refundedNullifierHashes(nullifierHash)) as boolean;
        return { claimed, nextNonce, refunded };
    }

    // ── Deposit ─────────────────────────────────────────────────────────────

    /**
     * Full privacy deposit: build the deposit proof locally, approve + deposit
     * on-chain with the signer wallet, then confirm with the backend (uploading
     * encrypted per-receiver withdraw messages and the encrypted refund payload).
     */
    async executePrivacyDeposit(batchId: string): Promise<any> {
        const data = await this.getPrivacyDepositData(batchId);
        const tier = data?.tier;
        if (!tier) throw new Error('This batch is not a privacy deposit plan (missing tier) - create it with create_privacy_deposit_plan first');
        const members: any[] = data?.members ?? [];
        if (members.length === 0) throw new Error('The deposit plan has no members');
        for (const member of members) {
            if (!member.secretHash || !member.encPubkey) {
                throw new Error(`Member ${member.address ?? ''} has no GravArc account - they must bind a wallet in PactPay first`);
            }
        }

        const config = await this.gravArcConfig(data.caipChainId);
        const tokenAddress = String(data.tokenAddress ?? NATIVE_TOKEN);
        const isNative = tokenAddress.toLowerCase() === NATIVE_TOKEN;

        const refundable = Boolean(data.privacyRefundable ?? true);
        let depositorSecretHash: string | null = null;
        let depositorEncPubkey: string | null = null;
        if (refundable) {
            const info = await this.myGravArcUserInfo();
            if (!info) throw new Error('Refundable deposits require your GravArc account - bind your wallet in PactPay first');
            depositorSecretHash = info.secretHash;
            depositorEncPubkey = info.encPubkey;
        }

        const [circuit, depositPath] = await Promise.all([
            this.circuitFiles(data.caipChainId, tier, 'deposit'),
            this.depositPath(data.caipChainId),
        ]);

        // Each receiver's committed amount is GROSS = item amount + platformFee.
        const receivers = members.map((member) => ({
            address: member.address,
            secretHash: member.secretHash,
            encPubkey: member.encPubkey,
            amount: BigInt(member.amount) + BigInt(member.platformFee ?? '0'),
        }));

        const proofResult = await generateDepositProof(
            receivers,
            BigInt(tokenAddress),
            circuit,
            depositPath,
            refundable,
            depositorSecretHash,
        );

        const planTotal = BigInt(data.totalAmount ?? '0');
        if (proofResult.totalAmount !== planTotal) {
            throw new Error(`Deposit total mismatch: proof totalAmount=${proofResult.totalAmount} but plan totalAmount=${planTotal} - retry in a moment`);
        }

        const provider = await this.provider(data.caipChainId);
        const wallet = this.requireSigner().connect(provider);

        if (!isNative) {
            const token = new Contract(tokenAddress, ERC20_ABI, wallet);
            const allowance = (await token.allowance(wallet.address, config.gravArcAddress)) as bigint;
            if (allowance < proofResult.totalAmount) {
                const approveTx = await token.approve(config.gravArcAddress, proofResult.totalAmount);
                const approveReceipt = await approveTx.wait();
                if (!approveReceipt || approveReceipt.status !== 1) throw new Error('approve transaction reverted');
            }
        }

        const gravArc = new Contract(config.gravArcAddress, GRAVARC_ABI, wallet);
        const depositTx = await gravArc.deposit({
            pA: proofResult.proof.pA.map(BigInt),
            pB: proofResult.proof.pB.map((row) => row.map(BigInt)),
            pC: proofResult.proof.pC.map(BigInt),
            newRoot: BigInt(proofResult.newDepositRoot),
            depositLeaf: BigInt(proofResult.depositLeaf),
            totalAmount: proofResult.totalAmount,
            token: tokenAddress,
            tier: proofResult.tier,
        }, isNative ? { value: proofResult.totalAmount } : {});
        const receipt = await depositTx.wait();
        if (!receipt || receipt.status !== 1) throw new Error('deposit transaction reverted');
        const depositTxHash = receipt.hash;

        const withdrawMessages: any[] = [];
        for (let i = 0; i < proofResult.receivers.length; i += 1) {
            const receiver = proofResult.receivers[i];
            const messageContent = JSON.stringify({
                nullifier: receiver.nullifier,
                amount: receiver.amount,
                depositRoot: proofResult.newDepositRoot,
                leafIndex: proofResult.leafIndex,
                authRoot: proofResult.authRoot,
                depositorSecretHash: proofResult.depositorSecretHash,
                depositPathElements: proofResult.depositPathElements,
                depositPathIndices: proofResult.depositPathIndices,
                authPathElements: receiver.authPathElements,
                authPathIndices: receiver.authPathIndices,
            });
            withdrawMessages.push({
                address: receiver.address,
                content: await naclEncrypt(messageContent, receiver.encPubkey),
                secretHash: members[i].secretHash,
                encPubkey: receiver.encPubkey,
            });
        }

        let encContent: string | undefined;
        let depositInfo: string | undefined;
        if (refundable && depositorEncPubkey) {
            const refundPayload: RefundPayload = {
                batchId,
                leafIndex: proofResult.leafIndex,
                token: tokenAddress,
                tier: proofResult.tier,
                authRoot: proofResult.authRoot,
                depositLeaf: proofResult.depositLeaf,
                depositorSecretHash: proofResult.depositorSecretHash,
                slots: proofResult.refundSlots,
            };
            encContent = await naclEncrypt(JSON.stringify(refundPayload), depositorEncPubkey);
            depositInfo = JSON.stringify({
                depositorSecretHash: proofResult.depositorSecretHash,
                encPubkey: depositorEncPubkey,
            });
        }

        await this.confirmDeposit(batchId, {
            depositTxHash,
            withdrawMessages,
            ...(encContent !== undefined ? { encContent } : {}),
            ...(depositInfo !== undefined ? { depositInfo } : {}),
        });

        return {
            batchId,
            depositTxHash,
            tier: proofResult.tier,
            totalAmount: proofResult.totalAmount.toString(),
            newDepositRoot: proofResult.newDepositRoot,
            refundable,
            confirmed: true,
        };
    }

    // ── Refund ──────────────────────────────────────────────────────────────

    private async confirmGravArcRefund(batchId: string, refundTxHash: string): Promise<any> {
        const orgId = await this.requireOrgId();
        return this.client.request(`/api/transaction/${orgId}/batches/${batchId}/confirm-refund-gravarc`, {
            method: 'POST',
            body: { depositTxHash: refundTxHash },
        });
    }

    /**
     * Full privacy refund: decrypt the depositor secret and the refund payload,
     * generate the refund proof, then submit it.
     *
     * Two submit paths mirror the web app (refundPrivacyDeposit.ts):
     *  - delegate=true (default when supported): platform relayer pays gas, POST relay-refund.
     *    Requires chain config refundRelayerSupported=true.
     *  - delegate=false: depositor wallet self-relays the on-chain refund() call
     *    (relayer = refunder = depositor, so msg.sender == relayer holds), then
     *    confirms with the backend via confirm-refund-gravarc. Use this on chains
     *    where platform refund relaying is not supported.
     */
    async relayPrivacyRefund(batchId: string, options: { delegate?: boolean } = {}): Promise<any> {
        const delegate = options.delegate ?? true;
        const key = await this.naclKey();

        const gravArcInfo = await this.myGravArcUserInfo();
        if (!gravArcInfo?.encryptedSecret) {
            throw new Error('Missing depositor GravArc account secret - bind your wallet in PactPay first');
        }
        const depositSecret = await secretboxDecrypt(gravArcInfo.encryptedSecret, key);

        const remote = await this.getRefundPayload(batchId);
        if (!remote.encContent) throw new Error('No encrypted refund payload for this batch - was the deposit confirmed?');
        const payload = JSON.parse(await naclDecrypt(remote.encContent, key)) as RefundPayload;

        // The encrypted payload does not carry the chain - resolve it from the batch.
        const data = await this.getPrivacyDepositData(batchId);
        const caipChainId = String(data.caipChainId);
        const config = await this.gravArcConfig(caipChainId);

        const relayerInfo = await this.getRelayerAddress(caipChainId);
        const refunder = this.requireSigner().address;

        // Decide submit path. delegate=false is forced when the chain doesn't
        // support platform refund relaying (the web app does the same).
        const useDelegate = delegate && config.refundRelayerSupported;
        if (delegate && !config.refundRelayerSupported) {
            throw new Error(
                'Platform refund relaying is not supported on this chain - retry with delegate=false to self-relay the refund from your wallet',
            );
        }

        const path = await this.depositMembershipPath(caipChainId, payload.leafIndex);

        let totalClaimed = 0n;
        for (const slot of payload.slots) {
            const nullifierHash = await computeNullifierHash(slot.nullifier);
            const state = await this.readClaimState(caipChainId, config.gravArcAddress, nullifierHash);
            if (state.refunded) throw new Error('This deposit has already been refunded on-chain');
            totalClaimed += state.claimed;
        }

        const totalWithdraw = payload.slots.reduce((sum, slot) => sum + BigInt(slot.withdrawAmount), 0n);
        const refundAmount = totalWithdraw - totalClaimed;
        if (refundAmount <= 0n) throw new Error('Nothing to refund - all allocations already fully claimed');
        const fee = (refundAmount + 999n) / 1000n;

        // relayer: delegate -> platform relayer (fee to platform); self-relay -> depositor
        // (relayer == refunder == msg.sender so the contract's relayer check passes).
        const relayer = useDelegate ? relayerInfo.relayerAddress : refunder;

        const circuit = await this.circuitFiles(caipChainId, payload.tier, 'refund');
        const proof: RefundProofResult = await generateRefundProof({
            slots: payload.slots,
            depositSecret,
            token: payload.token,
            tier: payload.tier,
            depositPathElements: path.siblings,
            depositPathIndices: path.pathIndices,
            totalClaimed,
            fee,
            relayer,
            refunder,
            circuit,
        });

        if (useDelegate) {
            const result = await this.relayGravArcRefund(batchId, {
                pA: proof.proof.pA,
                pB: proof.proof.pB,
                pC: proof.proof.pC,
                depositRoot: proof.depositRoot,
                nullifierHash: proof.nullifierHash,
                token: proof.token,
                refundAmount: proof.refundAmount.toString(),
                fee: proof.fee.toString(),
                relayer: proof.relayer,
                refunder: proof.refunder,
                tier: proof.tier,
            });
            return { batchId, ...result, refundAmount: proof.refundAmount.toString(), delegate: true };
        }

        // Self-relay: depositor wallet calls GravArc.refund() directly.
        // msg.sender == relayer == refunder == depositor, satisfying the contract check.
        const provider = await this.provider(caipChainId);
        const wallet = this.requireSigner().connect(provider);
        const gravArc = new Contract(config.gravArcAddress, GRAVARC_ABI, wallet);
        const refundTx = await gravArc.refund({
            pA: proof.proof.pA.map(BigInt),
            pB: proof.proof.pB.map((row) => row.map(BigInt)),
            pC: proof.proof.pC.map(BigInt),
            depositRoot: BigInt(proof.depositRoot),
            nullifierHash: proof.nullifierHash,
            token: proof.token,
            refundAmount: proof.refundAmount,
            fee: proof.fee,
            relayer: proof.relayer,
            refunder: proof.refunder,
            tier: proof.tier,
        });
        const receipt = await refundTx.wait();
        if (!receipt || receipt.status !== 1) throw new Error('refund transaction reverted on-chain');
        const refundTxHash = receipt.hash;

        // On-chain success - record with backend so the deposit is marked refunded.
        // Mirrors the web app's confirmSync.enqueue('confirm-refund-gravarc', ...).
        let confirmResult: any = null;
        try {
            confirmResult = await this.confirmGravArcRefund(batchId, refundTxHash);
        } catch {
            // Backend confirm failed; the refund is already final on-chain. Caller
            // can retry confirm via confirm_gravarc_refund if needed.
        }

        return {
            batchId,
            txHash: refundTxHash,
            refundAmount: proof.refundAmount.toString(),
            delegate: false,
            confirmed: confirmResult,
        };
    }

    /**
     * Re-confirm a self-relayed GravArc refund with the backend after the
     * on-chain refund() succeeded (maps to POST confirm-refund-gravarc).
     */
    async confirmGravArcRefundTx(batchId: string, refundTxHash: string): Promise<any> {
        return this.confirmGravArcRefund(batchId, refundTxHash);
    }

    // ── Withdraw (employee) ─────────────────────────────────────────────────

    /**
     * Full privacy withdraw for one payroll item: decrypt the withdraw message
     * and secret, generate the withdraw proof (relayer = platform), and submit
     * via the backend relayer so the user pays no gas.
     */
    async relayPrivacyWithdrawForItem(itemId: string, recipient: string): Promise<any> {
        const list = await this.myPayrollItems({ page: 1, pageSize: 200 });
        const items: any[] = Array.isArray(list?.items) ? list.items
            : Array.isArray(list?.data) ? list.data
            : Array.isArray(list) ? list : [];
        const item = items.find((entry: any) => entry.id === itemId);
        if (!item) throw new Error(`Payroll item ${itemId} not found - list your items with list_my_payroll_items`);
        const wd = item.withdrawData;
        if (!wd?.content) throw new Error('This item has no encrypted withdraw message');
        if (!wd?.encryptedSecret) throw new Error('Missing encrypted secret - bind your wallet in PactPay first');
        if (!wd?.gravArcAddress || wd.tier === null || wd.tier === undefined) {
            throw new Error('Deposit is not confirmed yet for this item');
        }

        const key = await this.naclKey();
        const decoded = JSON.parse(await naclDecrypt(wd.content, key)) as {
            nullifier: string;
            amount: string;
            leafIndex?: number;
            authRoot: string;
            depositorSecretHash: string;
            depositPathElements: string[];
            depositPathIndices: number[];
            authPathElements: string[];
            authPathIndices: number[];
        };
        const rawSecret = await secretboxDecrypt(wd.encryptedSecret, key);

        const nullifierHash = await computeNullifierHash(decoded.nullifier);
        const state = await this.readClaimState(wd.caipChainId, wd.gravArcAddress, nullifierHash);
        if (state.refunded) throw new Error('This allocation was refunded');
        const total = BigInt(decoded.amount);
        const remaining = total - state.claimed;
        if (remaining <= 0n) throw new Error('Nothing left to claim - already fully withdrawn');
        const fee = item.platformFee ? BigInt(item.platformFee) : (remaining + 999n) / 1000n;

        const relayerInfo = await this.getRelayerAddress(wd.caipChainId);
        if (!relayerInfo.withdrawRelayerSupported) {
            throw new Error('Platform withdraw relaying is not supported on this chain');
        }

        const circuit = await this.circuitFiles(wd.caipChainId, wd.tier, 'withdraw');
        const proof = await generateWithdrawProof(
            {
                nullifier: decoded.nullifier,
                amount: decoded.amount,
                token: item.tokenAddress || item.batch?.tokenAddress || NATIVE_TOKEN,
                authRoot: decoded.authRoot,
                depositorSecretHash: decoded.depositorSecretHash,
                authPathElements: decoded.authPathElements,
                authPathIndices: decoded.authPathIndices,
                leafIndex: decoded.leafIndex ?? wd.leafIndex ?? 0,
                depositPathElements: decoded.depositPathElements,
                depositPathIndices: decoded.depositPathIndices,
                tier: wd.tier,
            },
            rawSecret,
            recipient,
            fee,
            circuit,
            state.claimed,
            state.nextNonce,
            remaining,
            relayerInfo.relayerAddress,
        );

        const result = await this.relayPrivacyWithdraw(item.id, {
            pA: proof.proof.pA,
            pB: proof.proof.pB,
            pC: proof.proof.pC,
            nullifierHash: proof.nullifierHash,
            recipient,
            claimedAmount: proof.claimedAmount.toString(),
            token: proof.token,
            tier: proof.tier,
            depositRoot: proof.depositRoot.toString(),
            expectedAmount: proof.expectedAmount.toString(),
            fee: proof.fee.toString(),
            relayer: proof.relayer,
            nonce: proof.nonce.toString(),
        });
        return { itemId: item.id, ...result, expectedAmount: proof.expectedAmount.toString() };
    }
}
