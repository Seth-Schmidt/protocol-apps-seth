/**
 * DFNS API authentication for the confidential-wrapper deployer. No raw-key path — the blockchain
 * key never leaves DFNS custody. These credentials only authenticate (bearer token) and authorize
 * (User Action Signature from the credential keypair) API requests; signing/broadcasting happen
 * inside DFNS via `Wallets:BroadcastTransaction`.
 */
import { createPrivateKey } from 'node:crypto';

import { DfnsApiClient } from '@dfns/sdk';
import { AsymmetricKeySigner } from '@dfns/sdk-keysigner';

/** Credentials that authenticate + authorize DFNS API requests (no wallet). */
export type DfnsAuthConfig = {
  apiUrl: string;
  orgId?: string;
  authToken: string;
  credId: string;
  credentialPrivateKey: string;
};

/** The env vars that must all be present for the DFNS signing path to activate. */
export const DFNS_AUTH_ENV_VARS = ['DFNS_AUTH_TOKEN', 'DFNS_CRED_ID', 'DFNS_PRIVATE_KEY'] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

/** True when every DFNS auth secret is set (non-empty) in the environment. */
export function hasDfnsAuthEnv(): boolean {
  return DFNS_AUTH_ENV_VARS.every(name => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * Load the DFNS auth credentials. `DFNS_API_URL` defaults to the production host and `DFNS_ORG_ID`
 * is optional, so the required secrets are the bearer token and the credential keypair.
 */
export function loadDfnsAuth(): DfnsAuthConfig {
  return {
    apiUrl: process.env.DFNS_API_URL?.trim() || 'https://api.dfns.io',
    orgId: process.env.DFNS_ORG_ID?.trim() || undefined,
    authToken: requireEnv('DFNS_AUTH_TOKEN'),
    credId: requireEnv('DFNS_CRED_ID'),
    credentialPrivateKey: requireEnv('DFNS_PRIVATE_KEY'),
  };
}

/**
 * Repair a PEM whose newlines a secret store / env round-trip mangled (collapsed to spaces,
 * escaped as `\n`, or stripped) back to canonical form. Only re-wraps whitespace, never alters key
 * material, so it's always safe. Without it, a flattened key fails to parse with `BAD_END_LINE`.
 */
export function normalizePem(raw: string): string {
  const s = raw.trim().replace(/\\n/g, '\n');
  const m = s.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return s.endsWith('\n') ? s : `${s}\n`;
  const [, label = '', rawBody = ''] = m;
  const body = (rawBody.match(/[A-Za-z0-9+/=]+/g) ?? []).join('');
  const wrapped = (body.match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

/**
 * The credential signer for User Action Signing. PEM is normalized first; the digest depends on
 * key type — EdDSA signs with none (`undefined`), ECDSA/RSA need one (sha256). DFNS verifies the
 * resulting signature against the registered public key.
 */
function credentialSigner(auth: DfnsAuthConfig): AsymmetricKeySigner {
  const privateKey = normalizePem(auth.credentialPrivateKey);
  const keyType = createPrivateKey(privateKey).asymmetricKeyType;
  const algorithm = keyType === 'ed25519' || keyType === 'ed448' ? undefined : 'sha256';
  return new AsymmetricKeySigner({ credId: auth.credId, privateKey, algorithm });
}

/** An authenticated DFNS API client (the credential signer performs User Action Signing). */
export function dfnsApiClient(auth: DfnsAuthConfig): DfnsApiClient {
  return new DfnsApiClient({
    baseUrl: auth.apiUrl,
    orgId: auth.orgId,
    authToken: auth.authToken,
    signer: credentialSigner(auth),
  });
}
