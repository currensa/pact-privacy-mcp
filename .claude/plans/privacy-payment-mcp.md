# 在 pactpay-mcp-server 中加入 GravArc 隐私支付（deposit / withdraw / refund）

## 背景结论

- 后端 `pactpay-server` 的 `transaction` 模块已有完整流程接口（privacy-deposit-plan / privacy-deposit-data / deposit-auth / confirm-deposit / relay-refund / confirm-refund-gravarc / my-payroll-items / relay-withdraw / confirm-withdraw / privacy-withdraw-relayer），`gravarc` 模块提供证明辅助接口（deposit-path / deposit-membership-path / circuit-files）。
- 证明生成按用户决策**移植 `pact-privacy-mcp` 的本地证明栈**（snarkjs + circomlibjs poseidon + circuit artifact 缓存校验），面向**组织管理员（充值/退款）+ 员工（提现）**两类用户。
- 两个必须先解决的前置问题：
  1. **认证缺口**：transaction 模块全部只支持 session token（`@Auth()` / `@RequireMemberWithRoles`），不支持 org API key。MCP 默认用 API key 登录 → 后端需把这些管理员接口改为 `@RequireOrgAuthOrApiKey(ALL_ADMIN_ROLES, 'mcp:read'|'mcp:write')`（模式已在 api-key-org.controller.ts 存在）。员工侧"仅自己"接口保持 `@Auth()`，MCP 用 `PACTPAY_TOKEN` 走 session token。
  2. **密钥/钱包**：deposit 需要一个有余额的组织钱包广播 approve + depositForPayroll；员工提现需要员工钱包派生密钥解密 withdrawMessage。均通过环境变量注入私钥（`PACTPAY_SIGNER_KEY`），明文不落盘。

## 分阶段实施

### Phase 1：后端 API key 放行（pactpay-server 改动）

`transaction.controller.ts` 管理员路由加 `@RequireOrgAuthOrApiKey`（读接口 `mcp:read`，写接口 `mcp:write`）：
- `POST :orgId/privacy-deposit-plan`、`POST :orgId/plan`、`POST :orgId/plan/fee-preview`、`DELETE :orgId/batch/:batchId`
- `GET :orgId/:batchId`、`GET :orgId/:batchId/approve-deposit`、`GET :orgId/batches/:batchId/privacy-deposit-data`、`GET :orgId/batches/:batchId/deposit-auth`、`GET :orgId/batches/:batchId/refund-payload`
- `POST :orgId/batches/:batchId/confirm-deposit`、`confirm-refund`、`relay-refund`、`confirm-refund-gravarc`
- gravarc 三个公开接口无需改动。

### Phase 2：MCP 工程重构 + 依赖

- 拆分现有 1428 行 `src/index.ts`：保留工具注册骨架，按域拆到 `src/tools/`（auth.ts / org.ts / plan.ts / apikey.ts / payment/*.ts）。
- 新增依赖：`ethers`、`snarkjs`、`circomlibjs`、`tweetnacl`（TRON 支持后续再加 tronweb，先做 EVM 链）。包体积会显著增大，README 需说明。
- 从 pact-privacy-mcp 移植（几乎原样拷贝，去 CLI 耦合）：
  - `proof/`：artifact-cache.ts（下载 wasm/zkey + sha256 校验 + 缓存）、poseidon.ts、prover.ts（groth16）
  - `deposit/proof.ts`（DepositProofService）、`withdraw/proof.ts`（WithdrawProofService）
  - `crypto/messages.ts`（withdrawMessage 加密/解密，tweetnacl）
  - `wallet/local-signer.ts`（精简为 EVM）
- 证明输入来源改为 pactpay-server 接口：merkle 路径用 `GET /api/gravarc/deposit-path` 与 `deposit-membership-path`；电路文件用 `GET /api/gravarc/circuit-files`。

### Phase 3：管理员侧 MCP 工具（deposit / refund）

无证明、纯 REST 封装（先落地）：
1. `create_privacy_deposit_plan` → POST privacy-deposit-plan（caipChainId、tokenAddress、members[{memberId,amount}]）
2. `get_privacy_deposit_data` → GET privacy-deposit-data（tier、leafIndex、成员 secretHash/encPubkey）
3. `get_deposit_auth` → GET deposit-auth（EIP-712 授权签名）
4. `confirm_deposit` → POST confirm-deposit（txHash + withdrawMessages + encContent + depositInfo）
5. `get_refund_payload` → GET refund-payload
6. `get_privacy_withdraw_relayer` → GET privacy-withdraw-relayer（relayer 地址、支持能力）

带证明（一步式工具，内部：取数据→下载电路→生成证明→上链/上送）：
7. `prepare_and_deposit`：生成 deposit 证明 + 每成员加密 withdrawMessage + 可退款 encContent/depositInfo；用 `PACTPAY_SIGNER_KEY` 钱包先 `approve` 再 `depositForPayroll`（带 deposit-auth 签名），广播后自动调 `confirm-deposit`。返回 txHash 与各成员领取指引。
8. `prepare_and_relay_refund`：取回 refund-payload 解密 → 生成 refund 证明（relayer=平台地址）→ POST relay-refund → POST confirm-refund-gravarc。返回 txHash。

### Phase 4：员工侧 MCP 工具（withdraw）

认证：仅 `PACTPAY_TOKEN`（session）；无 org 上下文依赖。
1. `my_payroll_items` → GET my-payroll-items（含 walletToken/status 过滤）
2. `my_payroll_summary` → GET my-summary
3. `prepare_and_relay_withdraw`：员工钱包（`PACTPAY_SIGNER_KEY`）派生密钥解密 item 的 withdrawMessage → GET deposit-membership-path 组装见证 → 生成 withdraw 证明（relayer=平台地址、recipient=员工指定地址）→ POST relay-withdraw → POST confirm-withdraw。返回 txHash/recipient/fee。
4. `confirm_withdraw`（独立确认工具，用户自己广播过的交易回填 txHash）

### Phase 5：测试与文档

- 用现有 `pact-privacy-mcp/test` 的思路补单测：proof 组装、DTO 编码、路径校验。
- README：新增环境变量（PACTPAY_SIGNER_KEY、电路缓存目录）、两类认证说明、工具清单更新。

## 关键设计取舍

- **一步式工具**（prepare+prove+submit 在一次 tool call 内完成），不复刻 privacy-mcp 的 operations/payload-store 状态机 —— 后端 relay 接口本身同步返回 txHash，MCP 无长事务恢复需求，大幅降低复杂度。
- **私钥只经环境变量**，不实现 privacy-mcp 的加密账户库（后续可加）。
- **先 EVM 后 TRON**：tronweb + 双链地址规范化第二期再移植。

## 文件改动清单（MCP 侧新增）

```
src/tools/payment/{deposit,refund,withdraw}.ts   # 工具注册 + 参数 schema
src/gravarc/{paths,artifact-cache}.ts            # 后端证明辅助接口客户端
src/proof/{poseidon,prover,deposit-proof,withdraw-proof}.ts
src/crypto/messages.ts                           # withdrawMessage 加解密
src/wallet/local-signer.ts
src/web3/broadcast.ts                            # approve/depositForPayroll 广播
```
