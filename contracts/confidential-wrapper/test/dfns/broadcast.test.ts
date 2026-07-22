/**
 * The DFNS broadcast helpers are the custody-side send path, so their pure pieces
 * must be exact: the tx→Eip1559 body mapping (rename `gas`, omit unset fields so DFNS
 * fills nonce/fees) and the id→hash poll (resolve on a hash, throw a DFNS reason on
 * Rejected, time out rather than hang). No credentials or chain needed.
 */
import { awaitBroadcastTxHash, eip1559BodyFromTx, type DfnsTransaction } from '../../tasks/dfns/broadcast';
import { expect } from 'chai';

// A getTransaction stub returning a fixed status, for the poll tests.
function statusOnce(tx: Partial<DfnsTransaction>): () => Promise<DfnsTransaction> {
  return () => Promise.resolve(tx as DfnsTransaction);
}

const noSleep = (): Promise<void> => Promise.resolve();
const frozenClock = (): number => 0;
const ref = { walletId: 'wa-1', transactionId: 'tx-1' };

// Self-contained rejection assertion so the mocha run needs no chai-as-promised
// (which only gets registered inside the hardhat test runner).
async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect((err as Error).message).to.match(pattern);
    return;
  }
  expect.fail('expected promise to reject');
}

describe('eip1559BodyFromTx', function () {
  const tx = { to: '0x1e74d7e7121edc958d83add905263ed387a96c02', data: '0xb6955866', gasLimit: '0x5208' };

  it('renames gas to gasLimit', function () {
    expect(eip1559BodyFromTx(tx).gasLimit).to.equal('0x5208');
  });

  it('is an Eip1559 broadcast', function () {
    expect(eip1559BodyFromTx(tx).kind).to.equal('Eip1559');
  });

  it('omits fields left unset so DFNS fills them', function () {
    const body = eip1559BodyFromTx(tx);
    expect(body).to.not.have.property('value');
    expect(body).to.not.have.property('maxFeePerGas');
    expect(body).to.not.have.property('maxPriorityFeePerGas');
  });

  it('includes value when set', function () {
    expect(eip1559BodyFromTx({ ...tx, value: '0x64' }).value).to.equal('0x64');
  });
});

describe('awaitBroadcastTxHash', function () {
  const hash = `0x${'ab'.repeat(32)}`;

  it('resolves a broadcast transaction to its chain hash', async function () {
    const got = await awaitBroadcastTxHash(statusOnce({ status: 'Broadcasted', txHash: hash } as Partial<DfnsTransaction>), ref, {
      now: frozenClock,
      sleep: noSleep,
    });
    expect(got).to.equal(hash);
  });

  it('surfaces the DFNS reason when a transaction is rejected', async function () {
    const promise = awaitBroadcastTxHash(
      statusOnce({ status: 'Rejected', reason: 'blocked by policy' } as Partial<DfnsTransaction>),
      ref,
      { now: frozenClock, sleep: noSleep },
    );
    await expectRejects(promise, /blocked by policy/);
  });

  it('waits through a pending status before resolving', async function () {
    const statuses: Partial<DfnsTransaction>[] = [
      { status: 'Pending' } as Partial<DfnsTransaction>,
      { status: 'Broadcasted', txHash: hash } as Partial<DfnsTransaction>,
    ];
    const getTransaction = (): Promise<DfnsTransaction> => Promise.resolve(statuses.shift() as DfnsTransaction);
    const got = await awaitBroadcastTxHash(getTransaction, ref, { now: frozenClock, sleep: noSleep });
    expect(got).to.equal(hash);
  });

  it('times out rather than hanging when no hash appears', async function () {
    const clock = [0, 60_000];
    const promise = awaitBroadcastTxHash(statusOnce({ status: 'Pending' } as Partial<DfnsTransaction>), ref, {
      timeoutMs: 60_000,
      now: () => clock.shift() ?? 60_000,
      sleep: noSleep,
    });
    await expectRejects(promise, /no txHash/);
  });
});
