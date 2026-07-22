/** Pure helpers for the DFNS custody send path (see per-function docs below). */
import type { DfnsApiClient } from '@dfns/sdk';

/** The `Eip1559` variant of the DFNS broadcast body, derived from the installed SDK. */
type BroadcastBody = Parameters<DfnsApiClient['wallets']['broadcastTransaction']>[0]['body'];
export type Eip1559Body = Extract<BroadcastBody, { kind: 'Eip1559' }>;

/** The transaction-status shape the broadcast poll reads (id, status, txHash, reason). */
export type DfnsTransaction = Awaited<ReturnType<DfnsApiClient['wallets']['getTransaction']>>;
type GetTransaction = (req: { walletId: string; transactionId: string }) => Promise<DfnsTransaction>;

/** A resolved transaction (hex quantity strings, `to`/`data` resolved). Null/undefined omitted. */
export type Eip1559TxInput = {
  to?: string | null;
  data?: string | null;
  value?: string | null;
  gasLimit?: string | null;
  maxFeePerGas?: string | null;
  maxPriorityFeePerGas?: string | null;
};

/** Default poll cadence and ceiling for resolving a broadcast id to its chain hash. */
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 60_000;

export type AwaitTxHashOptions = {
  pollMs?: number;
  timeoutMs?: number;
  // Injectable clock/sleep so the poll is testable without real time.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Map a resolved transaction to a DFNS `Eip1559` broadcast body: `from` is dropped (DFNS signs as
 * the wallet), `gas`→`gasLimit`, and unset fields are omitted so DFNS fills them (notably nonce).
 */
export function eip1559BodyFromTx(tx: Eip1559TxInput): Eip1559Body {
  const body: Eip1559Body = { kind: 'Eip1559' };
  if (tx.to != null) body.to = tx.to;
  if (tx.data != null) body.data = tx.data;
  if (tx.value != null) body.value = tx.value;
  if (tx.gasLimit != null) body.gasLimit = tx.gasLimit;
  if (tx.maxFeePerGas != null) body.maxFeePerGas = tx.maxFeePerGas;
  if (tx.maxPriorityFeePerGas != null) body.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  return body;
}

/* eslint-disable no-await-in-loop -- the poll must observe each status before the next */
/**
 * Poll a broadcast id until it carries a chain hash. `Failed`/`Rejected` throws with the DFNS
 * reason (policy `Block` surfaces here); exceeding `timeoutMs` throws so the caller retries from
 * chain state rather than hanging.
 */
export async function awaitBroadcastTxHash(
  getTransaction: GetTransaction,
  ref: { walletId: string; transactionId: string },
  options: AwaitTxHashOptions = {},
): Promise<string> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  const start = now();
  for (;;) {
    const tx = await getTransaction(ref);
    if (tx.status === 'Failed' || tx.status === 'Rejected') {
      throw new Error(`DFNS broadcast ${ref.transactionId} ${tx.status}: ${tx.reason ?? 'no reason given'}`);
    }
    if (tx.txHash) return tx.txHash;
    if (now() - start >= timeoutMs) {
      throw new Error(`DFNS broadcast ${ref.transactionId} has no txHash after ${timeoutMs}ms (status ${tx.status})`);
    }
    await sleep(pollMs);
  }
}
/* eslint-enable no-await-in-loop */
