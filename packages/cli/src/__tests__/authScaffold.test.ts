import { describe, expect, it } from '@jest/globals';
import {
  generateProviders,
  generateSessionRoute,
} from '../generators/authScaffold';

describe('auth scaffold', () => {
  it('configures the browser with the dedicated auth endpoint', () => {
    const source = generateProviders();
    expect(source).toContain("authEndpoint: '/api/ablo-session'");
    expect(source).not.toContain('apiKey:');
  });

  it('generates one schema-backed, same-origin, no-store protocol', () => {
    const source = generateSessionRoute();
    expect(source).toContain('credentialEndpointSuccessSchema.parse');
    expect(source).toContain('credentialEndpointErrorSchema.parse');
    expect(source).toContain("'Cache-Control': 'no-store'");
    expect(source).toContain("code: 'session_expired'");
    expect(source).toContain("credentialKind: 'ephemeral'");
    expect(source).toContain("can: { tasks: ['read', 'create', 'update'] }");
    expect(source).toContain('isSameOrigin(request)');
  });
});
