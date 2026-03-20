import assert from 'assert';
import { describe, it } from 'node:test';
import {
  buildClaudeCodeProcessEnv,
  getExposedAgentEnvValue,
} from '../../src/lib/runtime/environment';

describe('runtime environment policy', () => {
  it('filters the claude code process env to an explicit allowlist', () => {
    const env = buildClaudeCodeProcessEnv({
      TMPDIR: '/tmp/workspace',
      TMP: '/tmp/workspace',
      TEMP: '/tmp/workspace',
    }, {
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      HOME: '/home/agent',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      HTTP_PROXY: 'http://proxy.internal:8080',
      PRIMO_API_KEY: 'tool-secret',
      AWS_SECRET_ACCESS_KEY: 'should-not-leak',
      RANDOM_VAR: 'should-not-leak',
    } as NodeJS.ProcessEnv);

    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/agent');
    assert.equal(env.ANTHROPIC_API_KEY, 'anthropic-secret');
    assert.equal(env.HTTP_PROXY, 'http://proxy.internal:8080');
    assert.equal(env.TMPDIR, '/tmp/workspace');
    assert.equal(env.TMP, '/tmp/workspace');
    assert.equal(env.TEMP, '/tmp/workspace');
    assert.equal(env.PRIMO_API_KEY, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.RANDOM_VAR, undefined);
  });

  it('allows only explicitly exposed integration secrets to the agent env surface', () => {
    const source = {
      NODE_ENV: 'test',
      PRIMO_API_KEY: 'ok',
      AWS_SECRET_ACCESS_KEY: 'nope',
    } as NodeJS.ProcessEnv;

    assert.equal(getExposedAgentEnvValue('PRIMO_API_KEY', source), 'ok');
    assert.throws(
      () => getExposedAgentEnvValue('AWS_SECRET_ACCESS_KEY', source),
      /Access to environment variable 'AWS_SECRET_ACCESS_KEY' is not allowed/
    );
  });
});
