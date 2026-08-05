import type { ChainDetails } from "../core/types.js";
import { PactPrivacyBackend } from "../backend/client.js";
import { createChainRuntime, type ChainRuntime } from "../chain/runtime.js";
import type { LocalEnvironment } from "../config/env.js";
import { CircuitArtifactCache } from "../proof/artifact-cache.js";
import { LocalProofService } from "../proof/prover.js";
import { LocalSigner } from "../wallet/local-signer.js";

export class PactPrivacyClient {
  readonly signer: LocalSigner;
  readonly backend: PactPrivacyBackend;
  readonly proofs: LocalProofService;

  constructor(readonly environment: Required<Pick<LocalEnvironment, "privateKey" | "backendUrl">> & LocalEnvironment) {
    this.signer = new LocalSigner(environment.privateKey);
    this.backend = new PactPrivacyBackend(environment.backendUrl, environment.apiKey);
    this.proofs = new LocalProofService(new CircuitArtifactCache({
      backendUrl: environment.backendUrl,
      ...(environment.apiKey ? { apiKey: environment.apiKey } : {}),
      ...(environment.circuitCacheDir ? { cacheDir: environment.circuitCacheDir } : {}),
    }));
  }

  async chain(chainId: number): Promise<{ config: ChainDetails; runtime: ChainRuntime }> {
    const config = await this.backend.chain(chainId);
    await this.backend.assertApiKeyGrant(this.signer, config.family);
    return {
      config,
      runtime: createChainRuntime(config, this.signer, {
        ...(this.environment.tronProApiKey ? { tronProApiKey: this.environment.tronProApiKey } : {}),
      }),
    };
  }
}
