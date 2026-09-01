import { describe, expect, it } from '@jest/globals';
import {
  generateProviders,
  generateSessionRoute,
} from '../generators/authScaffold';
import { generateSyncConfig } from '../init/generators';

describe('auth scaffold', () => {
  it('configures the browser with the dedicated session endpoint', () => {
    const source = generateProviders();
    expect(source).toContain("session: { endpoint: '/api/ablo-session' }");
    expect(source).not.toContain('apiKey:');
  });

  it('creates a real Next.js server-only boundary around the secret client', () => {
    expect(generateSyncConfig('apikey', { serverOnly: true })).toMatch(
      /^import 'server-only';/,
    );
    expect(generateSyncConfig('apikey')).not.toContain("import 'server-only';");
  });

  it('generates one authenticated session handler with server-derived access', () => {
    const source = generateSessionRoute();
    expect(source).toContain('sessions.handler({');
    expect(source).toContain('async authenticate()');
    expect(source).toContain('async grant({ principal: user })');
    expect(source).toContain('auth.api.getSession');
    expect(source).toContain("can: { records: ['read', 'create', 'update'] }");
    expect(source).toContain('authorizeActiveWorkspace(user.id)');
    expect(source).toContain('groups: authorizedScope.groups');
    expect(source).toContain('Never take');
    expect(source).toContain('return null;');
    expect(source).not.toContain('credentialEndpointSuccessSchema');
    expect(source).not.toContain('isSameOrigin');
  });
});
