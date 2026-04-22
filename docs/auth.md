# Authentication

The sync engine supports three auth tiers. Pick the one that fits your app.

## Tier 1: API Key Only

No login, no user tokens. Every user shares the same data context. Good for public dashboards, demos, internal tools, and AI agents.

```typescript
const sync = createSyncEngine({
  url: 'wss://sync.ablo.dev',
  apiKey: 'sk_live_...',
  schema,
});
```

All requests are scoped to the organization that owns the API key. No user identity — mutations are attributed to `apikey:<keyId>`.

## Tier 2: Session Cookie (browser)

Browser integrations rely on the session cookie the Ablo web app already issues — no explicit token handoff. Mutations are attributed to the signed-in user.

```typescript
const sync = createSyncEngine({
  url: 'wss://mesh.ablo.finance',
  schema,
  // no apiKey — session cookie carries identity
});
```

## Tier 3: API Key + User Token

Both app identity (billing, rate limits) and user identity (data scoping, audit). Good for managed cloud apps with real users.

```typescript
const sync = createSyncEngine({
  url: 'wss://sync.ablo.dev',
  apiKey: 'sk_live_...',
  auth: () => getAccessToken(),
  schema,
});
```

The API key identifies your app. The user token identifies who's acting. The sync server merges both into one identity.

## Auth provider examples

The `auth` option accepts a string or an async function that returns a token.

### Firebase

```typescript
import { getAuth } from 'firebase/auth';

const sync = createSyncEngine({
  apiKey: 'sk_live_...',
  auth: async () => {
    const user = getAuth().currentUser;
    return user ? await user.getIdToken() : '';
  },
  schema,
});
```

### Auth0

```typescript
import { useAuth0 } from '@auth0/auth0-react';

const { getAccessTokenSilently } = useAuth0();

const sync = createSyncEngine({
  apiKey: 'sk_live_...',
  auth: () => getAccessTokenSilently(),
  schema,
});
```

### Clerk

```typescript
import { useAuth } from '@clerk/nextjs';

const { getToken } = useAuth();

const sync = createSyncEngine({
  apiKey: 'sk_live_...',
  auth: () => getToken() ?? '',
  schema,
});
```

### Okta

```typescript
import { useOktaAuth } from '@okta/okta-react';

const { authState } = useOktaAuth();

const sync = createSyncEngine({
  apiKey: 'sk_live_...',
  auth: () => authState?.accessToken?.accessToken ?? '',
  schema,
});
```

### Supabase Auth

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(url, anonKey);

const sync = createSyncEngine({
  apiKey: 'sk_live_...',
  auth: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? '';
  },
  schema,
});
```

### Better Auth

```typescript
import { createAuthClient } from 'better-auth/client';

const authClient = createAuthClient();

const sync = createSyncEngine({
  apiKey: 'sk_live_...',
  auth: async () => {
    const session = await authClient.getSession();
    return session?.token ?? '';
  },
  schema,
});
```

## How tokens are sent

The SDK handles transport automatically:

| Request type | API key | User token |
|---|---|---|
| HTTP (fetch) | `X-API-Key` header | `Authorization: Bearer <token>` header |
| WebSocket | `?apiKey=` query param | `?token=` query param |

You don't set headers manually. The SDK does it based on your config.

## How the server processes auth

The sync server uses a layered auth model:

```
Request arrives with:
  X-API-Key: sk_live_...        ← Layer 1: app identity
  Authorization: Bearer <jwt>   ← Layer 2: user identity

LayeredProvider:
  1. APIKeyProvider validates sk_live_... → { orgId: "org_123", method: "apikey" }
  2. JWTProvider validates Bearer token → { userId: "user_456", email: "...", method: "jwt" }
  3. Merge → { userId: "user_456", orgId: "org_123", method: "apikey+jwt" }
```

If only an API key is sent (Tier 1): `{ userId: "apikey:key_abc", orgId: "org_123" }`
If only a user token is sent (Tier 2): `{ userId: "user_456", orgId: "org_789" }`
If both are sent (Tier 3): user identity + org from API key

## Cookies vs JWT

Both work. The sync server accepts the same token from either transport:

| Transport | When used | Example |
|---|---|---|
| **Cookie** (`__session`, `.session_token`) | Same-origin requests — browser sends automatically | Auth0 Next.js SDK, Clerk, Better Auth |
| **Bearer header** (`Authorization: Bearer <token>`) | Cross-origin requests — client sends explicitly | SPA calling separate API, mobile apps |

The token itself is usually a JWT in both cases. Auth0, Clerk, Firebase, and Okta all issue JWTs. Better Auth issues opaque session tokens (validated against DB). The sync server's pluggable auth handles both.

## Server-side

The Ablo managed service at `mesh.ablo.finance` handles auth provider wiring, API-key validation, and session verification. Self-hosting is not offered today — if compliance / data residency requires it, get in touch.
