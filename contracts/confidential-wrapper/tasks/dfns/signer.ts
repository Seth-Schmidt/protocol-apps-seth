/**
 * `DfnsSigner` — an ethers v6 signer whose blockchain key lives in DFNS custody.
 *
 * This is the ethers analogue of confidential-defi's viem `dfnsBroadcastTransport`:
 * writes are handed to DFNS `Wallets:BroadcastTransaction` (DFNS parses, can enforce
 * recipient policies, then signs AND broadcasts), while reads/gas-estimation go
 * through the ethers `Provider` unchanged. There is no local signing — the service
 * account is not granted raw `generateSignature`, so `signTransaction`/`signMessage`
 * throw.
 *
 * OZ `upgrades.deployProxy` takes `getSigner(ImplFactory.runner)` and reuses that one
 * signer for the implementation deploy, the ERC1967 proxy factory, and initial-owner
 * resolution — so connecting this signer to the ContractFactory routes the entire
 * proxy deploy through DFNS with no plugin changes.
 */
import { awaitBroadcastTxHash, eip1559BodyFromTx } from './broadcast';
import type { DfnsApiClient } from '@dfns/sdk';
import {
  AbstractSigner,
  getAddress,
  hexlify,
  resolveAddress,
  toBeHex,
  type Provider,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';

// How long to poll the RPC for the just-broadcast tx before returning its response.
const RESPONSE_POLL_MS = 1_500;
const RESPONSE_TIMEOUT_MS = 60_000;

const NOT_SUPPORTED = 'not supported: the key is in DFNS custody (broadcast-only, no local signing)';

export class DfnsSigner extends AbstractSigner {
  readonly #dfns: DfnsApiClient;
  readonly #walletId: string;
  readonly #address: string;

  constructor(dfns: DfnsApiClient, walletId: string, address: string, provider?: Provider | null) {
    super(provider ?? null);
    this.#dfns = dfns;
    this.#walletId = walletId;
    this.#address = getAddress(address);
  }

  async getAddress(): Promise<string> {
    return this.#address;
  }

  connect(provider: Provider | null): DfnsSigner {
    return new DfnsSigner(this.#dfns, this.#walletId, this.#address, provider);
  }

  // DFNS custody exposes no raw-signature path to service accounts.
  signTransaction(): Promise<string> {
    throw new Error(`signTransaction ${NOT_SUPPORTED}`);
  }

  signMessage(): Promise<string> {
    throw new Error(`signMessage ${NOT_SUPPORTED}`);
  }

  signTypedData(): Promise<string> {
    throw new Error(`signTypedData ${NOT_SUPPORTED}`);
  }

  /**
   * Route a write through DFNS: resolve to/data/value, estimate gas on the RPC when
   * the caller did not pin it (DFNS fills nonce + fees), broadcast, poll the DFNS
   * transaction id to its chain hash, then return the RPC's `TransactionResponse` so
   * callers' `.wait()` confirms inclusion exactly as with a local signer.
   */
  async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const provider = this.provider;
    if (!provider) {
      throw new Error('DfnsSigner has no provider; connect it to one before sending transactions');
    }

    const to = tx.to == null ? null : await resolveAddress(tx.to, provider);
    const data = tx.data == null ? undefined : hexlify(tx.data);
    const value = tx.value == null ? 0n : BigInt(tx.value);

    const gasLimit =
      tx.gasLimit == null
        ? await provider.estimateGas({ from: this.#address, to, data: data ?? '0x', value })
        : BigInt(tx.gasLimit);

    const body = eip1559BodyFromTx({
      to,
      data,
      value: value > 0n ? toBeHex(value) : undefined,
      gasLimit: toBeHex(gasLimit),
    });

    const { id } = await this.#dfns.wallets.broadcastTransaction({ walletId: this.#walletId, body });
    const hash = await awaitBroadcastTxHash(
      req => this.#dfns.wallets.getTransaction(req),
      { walletId: this.#walletId, transactionId: id },
    );

    return this.#waitForResponse(provider, hash);
  }

  // The RPC may not index the broadcast hash immediately; poll briefly for it.
  async #waitForResponse(provider: Provider, hash: string): Promise<TransactionResponse> {
    const start = Date.now();
    for (;;) {
      const response = await provider.getTransaction(hash);
      if (response) return response;
      if (Date.now() - start >= RESPONSE_TIMEOUT_MS) {
        throw new Error(`DFNS broadcast ${hash} not visible on the RPC after ${RESPONSE_TIMEOUT_MS}ms`);
      }
      await new Promise<void>(resolve => setTimeout(resolve, RESPONSE_POLL_MS));
    }
  }
}
