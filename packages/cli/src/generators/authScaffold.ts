export function generateProviders(): string {
  return `'use client';

import Ablo from '@abloatai/ablo';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

const ablo = Ablo({ schema, authEndpoint: '/api/ablo-session' });

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider client={ablo}>{children}</AbloProvider>;
}
`;
}

export function generateSessionRoute(): string {
  return `import { headers } from 'next/headers';
import {
  credentialEndpointErrorSchema,
  credentialEndpointSuccessSchema,
} from '@abloatai/ablo/auth';
import { sync } from '@/ablo';
import { auth } from '@/lib/auth';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  if (!(await isSameOrigin(request))) {
    return Response.json(
      credentialEndpointErrorSchema.parse({
        error: { code: 'origin_mismatch', message: 'Cross-origin mint rejected' },
      }),
      { status: 403, headers: noStore },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      credentialEndpointErrorSchema.parse({
        error: { code: 'session_expired', message: 'Sign in again' },
      }),
      { status: 401, headers: noStore },
    );
  }

  const authorizedScope = await authorizeActiveWorkspace(user.id);
  if (!authorizedScope) {
    return Response.json(
      credentialEndpointErrorSchema.parse({
        error: { code: 'policy_denied', message: 'Workspace membership is stale or revoked' },
      }),
      { status: 403, headers: noStore },
    );
  }

  const { token, expiresAt } = await sync.sessions.create({
    user: { id: user.id },
    // These ids came from the server-side membership lookup below. Never take
    // organization, workspace, team, or group ids from the request body.
    syncGroups: authorizedScope.syncGroups,
    can: { records: ['read', 'create', 'update'] },
  });
  return Response.json(
    credentialEndpointSuccessSchema.parse({
      token,
      expiresAt,
      credentialKind: 'ephemeral',
    }),
    { headers: noStore },
  );
}

async function isSameOrigin(request: Request): Promise<boolean> {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site';
  const host = (await headers()).get('host');
  return host !== null && new URL(origin).host === host;
}

async function getCurrentUser(): Promise<{ id: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ? { id: session.user.id } : null;
}

type AuthorizedWorkspace = {
  workspaceId: string;
  syncGroups: readonly [\`workspace:\${string}\`, ...\`\${string}:\${string}\`[]];
};

async function authorizeActiveWorkspace(userId: string): Promise<AuthorizedWorkspace | null> {
  void userId;
  // REQUIRED: query your membership table here, immediately before minting.
  // Read the active workspace from the server-side session, verify this user has
  // an active membership, and derive every team/group id on the server. Return
  // null for a stale or revoked membership. This refusal keeps a newly generated
  // route from turning "signed in" into workspace authorization by accident.
  //
  // Example after your membership query:
  // return {
  //   workspaceId: membership.workspaceId,
  //   syncGroups: [\`workspace:\${membership.workspaceId}\`],
  // };
  return null;
}
`;
}
