import type { CanonicalAddress, ChainFamily } from "../core/types.js";

export type ApiKeyGrant = {
  address: CanonicalAddress;
  family: ChainFamily;
  createdAt: number;
};

export type ApiKeyIdentity = {
  id: string;
  name: string;
  scopes: string[];
  grants: ApiKeyGrant[];
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

export type ApiKeyCreated = ApiKeyIdentity & { key: string };

export interface ApiKeyProvisioner {
  issue(input: { name: string; grants: ApiKeyGrant[]; scopes: string[]; expiresAt?: number }): Promise<string>;
  rotate(id: string): Promise<string>;
}
