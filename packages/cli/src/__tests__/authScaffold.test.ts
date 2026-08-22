import { describe, expect, it } from '@jest/globals';
import {
  generateProviders,
  generateSessionRoute,
} from '../generators/authScaffold';
import { generateSyncConfig } from '../init/generators';

describe('auth scaffold', () => {
  it('configures the browser with the dedicated auth endpoint', () => {
    const source = generateProviders();
    expect(source).toContain("authEndpoint: '/api/ablo-session'");
    expect(source).not.toContain('apiKey:');
  });

  it('creates a real Next.js server-only boundary around the secret client', () => {
    expect(generateSyncConfig('apikey', { serverOnly: true })).toMatch(
      /^import 'server-only';/,
    );
    expect(generateSyncConfig('apikey')).not.toContain("import 'server-only';");
  });

  it('generates one schema-backed, same-origin, no-store protocol', () => {
    const source = generateSessionRoute();
    expect(source).toContain('credentialEndpointSuccessSchema.parse');
    expect(source).toContain('credentialEndpointErrorSchema.parse');
    expect(source).toContain("'Cache-Control': 'no-store'");
    expect(source).toContain("code: 'session_expired'");
    expect(source).toContain("credentialKind: 'ephemeral'");
    expect(source).toContain("can: { records: ['read', 'create', 'update'] }");
    expect(source).toContain('isSameOrigin(request)');
    expect(source).toContain('authorizeActiveWorkspace(user.id)');
    expect(source).toContain("code: 'policy_denied'");
    expect(source).toContain('syncGroups: authorizedScope.syncGroups');
    expect(source).toContain('Never take');
    expect(source).toContain('return null;');
  });
});
