/**
 * Shape 2 — Browser app (Stripe-shaped flow).
 *
 * Two halves in one file for documentation clarity:
 *
 *   (1) Server route — your backend (Next.js API route, Hono handler,
 *       Express endpoint, whatever). Holds `ABLO_API_KEY`, mints a
 *       scoped capability token for the authenticated user, returns
 *       it to the browser. Just like Stripe's server-side PaymentIntent
 *       creation returning a `client_secret`.
 *
 *   (2) Browser code — receives the token and constructs a client
 *       directly with `capabilityToken`. No API key in the bundle,
 *       no session cookie passthrough, no allowed-origins registration
 *       required. The scope is baked into the token.
 *
 * Rotation: the browser client accepts `onTokenRefresh` so the SDK
 * can ask your server for a fresh token before the current one
 * expires — `participant.autoRefresh()` handles the scheduling.
 */

import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

// ─────────────────────────────────────────────────────────────────────
//  (1) SERVER — runs with ABLO_API_KEY in env
// ─────────────────────────────────────────────────────────────────────

/**
 * Mint a capability token scoped to exactly one matter, for one user,
 * for one hour. Call this from your authenticated API route.
 *
 * In a Next.js app router:
 *
 * ```ts
 * // app/api/ablo/token/route.ts
 * export async function POST(req: Request) {
 *   const session = await getSession();
 *   if (!session) return new Response('Unauthorized', { status: 401 });
 *   const { matterId } = await req.json();
 *   return Response.json({ token: await mintMatterToken(matterId) });
 * }
 * ```
 */
export async function mintMatterToken(matterId: string): Promise<string> {
  const ablo = new Ablo({ schema }); // reads ABLO_API_KEY

  const cap = await ablo.admin.capabilities.create({
    allowedSyncGroups: [`matter:${matterId}`],
    ttlSeconds: 60 * 60, // 1 hour
  });

  return cap.token;
}

// ─────────────────────────────────────────────────────────────────────
//  (2) BROWSER — no API key, no session cookie
// ─────────────────────────────────────────────────────────────────────

/**
 * Call from the client when you're ready to connect. The token came
 * from your server route above. The browser never holds an API key.
 */
export async function connectToMatter(matterId: string, token: string) {
  const ablo = new Ablo({
    schema,
    capabilityToken: token,
    // Refresh callback: the SDK calls this when the current token is
    // close to expiry. Fetch a new one from your server.
    onTokenRefresh: async () => {
      const res = await fetch('/api/ablo/token', {
        method: 'POST',
        body: JSON.stringify({ matterId }),
        credentials: 'include',
      });
      const { token: fresh } = (await res.json()) as { token: string };
      return fresh;
    },
  });

  const participant = await ablo.matters.join(matterId, {
    label: 'You',
  });
  participant.autoRefresh();

  // Broadcast that this browser tab is viewing the matter.
  participant.presence.viewing(['Matter', matterId]);

  // Render the live peer list. Each iteration yields the current roster.
  (async () => {
    for await (const peers of participant.presence) {
      updateAvatarBar(peers.map((p) => p.label ?? p.participantId));
    }
  })();

  return participant;
}

// Placeholder — replace with your DOM update.
declare function updateAvatarBar(labels: string[]): void;
