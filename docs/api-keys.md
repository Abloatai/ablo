# API Keys

Trusted runtimes authenticate with an API key.

```ts
import Ablo from '@ablo/sync-engine';

const ablo = Ablo({ apiKey: process.env.ABLO_API_KEY });
```

The key identifies the Ablo account. Application code does not pass an organization id; Ablo derives scope from the credential.

Use the root `@ablo/sync-engine` import with a schema for app clients.

## Server-Side API Keys

Use API keys from trusted runtimes:

- backend route handlers
- workers and agents
- CLI tools
- webhooks

Never ship a secret API key to a browser bundle.
