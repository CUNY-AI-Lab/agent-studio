import assert from 'assert';
import { describe, it } from 'node:test';
import {
  CLAUDE_CODE_BUILT_IN_ALLOWED_TOOLS,
  buildWorkspaceRuntimeSecurityOptions,
  getWorkspaceRuntimePaths,
} from '../../src/lib/runtime/in-process';

describe('runtime security policy', () => {
  it('scopes bash to the current tenant workspace and disables bypass mode', () => {
    const paths = getWorkspaceRuntimePaths(
      { basePath: '/app/data/users/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as { basePath: string },
      'workspace-1'
    );
    const abortController = new AbortController();
    const options = buildWorkspaceRuntimeSecurityOptions({
      mcpToolNames: ['mcp__workspace-1__ui_table', 'mcp__workspace-1__ui_show_file'],
      paths,
      abortController,
      egressProxyPort: 4319,
    });

    assert.deepEqual(options.tools, { type: 'preset', preset: 'claude_code' });
    assert.deepEqual(options.allowedTools, [
      'mcp__workspace-1__ui_table',
      'mcp__workspace-1__ui_show_file',
      ...CLAUDE_CODE_BUILT_IN_ALLOWED_TOOLS,
    ]);
    assert.equal(options.permissionMode, 'dontAsk');
    assert.equal('allowDangerouslySkipPermissions' in options, false);
    assert.equal('settingSources' in options, false);
    assert.equal(options.cwd, paths.workspaceFilesDir);
    assert.equal(options.persistSession, false);
    assert.equal(options.abortController, abortController);

    assert.equal(options.settings.permissions.defaultMode, 'dontAsk');
    assert.equal(options.settings.permissions.disableBypassPermissionsMode, 'disable');

    assert.equal(options.sandbox.enabled, true);
    assert.equal(options.sandbox.autoAllowBashIfSandboxed, true);
    assert.equal(options.sandbox.allowUnsandboxedCommands, false);
    assert.equal(options.sandbox.network.allowAllUnixSockets, false);
    assert.equal(options.sandbox.network.allowLocalBinding, false);
    assert.equal(options.sandbox.network.httpProxyPort, 4319);
    assert.deepEqual(options.sandbox.filesystem.allowWrite, [
      paths.workspaceFilesDir,
      paths.runtimeTmpDir,
    ]);
    assert.deepEqual(options.sandbox.filesystem.allowRead, [
      paths.workspaceFilesDir,
      paths.runtimeTmpDir,
    ]);
    assert.equal('denyRead' in options.sandbox.filesystem, false);

    assert.equal(options.env.TMPDIR, paths.runtimeTmpDir);
    assert.equal(options.env.TMP, paths.runtimeTmpDir);
    assert.equal(options.env.TEMP, paths.runtimeTmpDir);
    assert.equal(options.env.HTTP_PROXY, 'http://127.0.0.1:4319');
    assert.equal(options.env.HTTPS_PROXY, 'http://127.0.0.1:4319');
    assert.equal(options.env.http_proxy, 'http://127.0.0.1:4319');
    assert.equal(options.env.https_proxy, 'http://127.0.0.1:4319');
    assert.equal(options.env.NO_PROXY, '');
    assert.equal(options.env.no_proxy, '');
  });
});
