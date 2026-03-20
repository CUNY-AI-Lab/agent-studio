import assert from 'assert';
import { describe, it } from 'node:test';
import { assessEgressDestination } from '../../src/runner/egress-proxy';

describe('runner egress proxy policy', () => {
  it('blocks localhost hostnames', async () => {
    const assessment = await assessEgressDestination('localhost');
    assert.equal(assessment.allowed, false);
    assert.match(assessment.reason || '', /Blocked internal hostname/);
  });

  it('blocks internal raw IP addresses', async () => {
    const assessment = await assessEgressDestination('127.0.0.1');
    assert.equal(assessment.allowed, false);
    assert.match(assessment.reason || '', /Blocked internal IP/);
  });

  it('blocks cloud metadata addresses', async () => {
    const assessment = await assessEgressDestination('169.254.169.254');
    assert.equal(assessment.allowed, false);
    assert.match(assessment.reason || '', /Blocked internal IP/);
  });

  it('allows public destinations', async () => {
    const assessment = await assessEgressDestination('8.8.8.8');
    assert.equal(assessment.allowed, true);
    assert.ok(assessment.connectHost);
  });
});
