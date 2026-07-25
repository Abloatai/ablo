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

  const { token, expiresAt } = await sync.sessions.create({
    user: { id: user.id },
    can: { tasks: ['read', 'create', 'update'] },
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
`;
}
