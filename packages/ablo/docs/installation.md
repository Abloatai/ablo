# Installation

> Install Ablo, declare the models participants share, and create a typed client.

Install the Ablo TypeScript SDK in an existing or new project.

## Install the package

```bash
npm install @abloatai/ablo
npx ablo init
```

`ablo init` creates the schema, registration, and client files and signs the
developer in. Keep these files together under one `ablo/` ownership boundary.

## Declare shared models

Declare only the rows Ablo coordinates. Your other tables stay in the schema
and migrations the application already owns.

```ts
// ablo/schema.ts
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  tasks: model({
    title: z.string(),
    status: z.enum(['open', 'done']),
  }),
});
```

Every model automatically has an `id`. Declare application fields such as
timestamps and actor ids yourself when you need them.

## Start development

```bash
npx ablo dev
```

The development command prepares an isolated Ablo branch, supplies its
temporary `ABLO_API_KEY`, pushes the schema, and watches for changes. Runtime
code always reads `ABLO_API_KEY`; do not put management credentials in the
application.

## Use your PostgreSQL database

```bash
npx ablo connect
```

Ablo runs no DDL and does not replace your migration tool. It writes the models
you declared and confirms changes from PostgreSQL's write-ahead log. Existing
APIs, direct SQL, constraints, and transactions can remain in place.

## Create the client

`ablo init` scaffolds this file. Start with the HTTP client for an agent or
server operation; it has no persistent connection to manage.

```ts
// ablo/client.ts
import Ablo from '@abloatai/ablo';
import { schema } from './schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
  transport: 'http',
});
```

Continue to [Basic usage](./basic-usage.md) to read, write, and coordinate one
operation. Use the [full Quickstart](./quickstart.md) when you need the detailed
branch, schema-registration, and database setup explanation.
