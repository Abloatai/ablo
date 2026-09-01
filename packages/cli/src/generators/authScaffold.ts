export function generateProviders(): string {
  return `'use client';

import Ablo from '@abloatai/ablo';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

const ablo = Ablo({ schema, session: { endpoint: '/api/ablo-session' } });

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider client={ablo}>{children}</AbloProvider>;
}
`;
}

export function generateSessionRoute(): string {
  return `import { headers } from 'next/headers';
import Sessions from '@abloatai/ablo/sessions';
import { schema } from '@/ablo/schema';
import { auth } from '@/lib/auth';

const sessions = Sessions({ schema, apiKey: process.env.ABLO_API_KEY });

export const POST = sessions.handler({
  async authenticate() {
    const session = await auth.api.getSession({ headers: await headers() });
    return session?.user ?? null;
  },
  async grant({ principal: user }) {
    const authorizedScope = await authorizeActiveWorkspace(user.id);
    if (!authorizedScope) return null;

    return {
      user: { id: user.id },
      // These ids came from the server-side membership lookup below. Never take
      // organization, workspace, team, or group ids from the request body.
      groups: authorizedScope.groups,
      can: { records: ['read', 'create', 'update'] },
    };
  },
});

type AuthorizedWorkspace = {
  workspaceId: string;
  groups: readonly [\`workspace:\${string}\`, ...\`\${string}:\${string}\`[]];
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
  //   groups: [\`workspace:\${membership.workspaceId}\`],
  // };
  return null;
}
`;
}
