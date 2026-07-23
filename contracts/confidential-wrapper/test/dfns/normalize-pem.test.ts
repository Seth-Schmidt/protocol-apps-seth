/**
 * `normalizePem` re-wraps a PEM that a secret store / env round-trip mangled back to
 * canonical 64-char lines. It only rewraps whitespace, never key material — verified
 * here against the two common manglings (escaped `\n` and space-collapsed).
 */
import { normalizePem } from '../../tasks/utils/dfns/auth';
import { expect } from 'chai';

const CANONICAL = '-----BEGIN PRIVATE KEY-----\nAAAABBBB\n-----END PRIVATE KEY-----\n';

describe('normalizePem', function () {
  it('rewraps a key whose newlines were escaped as backslash-n', function () {
    const escaped = '-----BEGIN PRIVATE KEY-----\\nAAAA\\nBBBB\\n-----END PRIVATE KEY-----';
    expect(normalizePem(escaped)).to.equal(CANONICAL);
  });

  it('rewraps a key whose newlines were collapsed to spaces', function () {
    const spaced = '-----BEGIN PRIVATE KEY----- AAAA BBBB -----END PRIVATE KEY-----';
    expect(normalizePem(spaced)).to.equal(CANONICAL);
  });

  it('leaves an already-canonical key on a trailing newline', function () {
    expect(normalizePem(CANONICAL)).to.equal(CANONICAL);
  });

  it('falls back to a trailing newline when there is no PEM envelope', function () {
    expect(normalizePem('not-a-pem')).to.equal('not-a-pem\n');
  });
});
