# Existing Python Backend

Put Ablo in front of the records several people (or AI agents) edit at once and
you get two things at no cost to your stack: every edit fans out live to
everyone watching, and humans and agents write through one shared contract. Your
Python service and database stay the source of truth — Ablo doesn't replace your
backend, it coordinates the writes into it. You stop calling your endpoint
directly; you call Ablo, Ablo calls your endpoint, and Ablo pushes the result
back out to every browser and agent on that record.

Use this path when a product already has a Python API server and every button
currently calls an application endpoint. It applies to any API-backed app, not
only Python — a YC company's existing dashboard can keep its current
endpoint/service/database shape and migrate one coordinated model at a time.

Here is the full path a button takes. After your Python service commits the
change, Ablo pushes it live to every other browser and agent watching that
record (the "realtime fanout" step at the bottom):

```txt
Browser UI
  -> Ablo model write
  -> Python Data Source endpoint
  -> existing Python service layer
  -> app database
  -> Ablo realtime fanout
  -> browser UI and agents
```

## 1. Declare The Shared Models

Create a schema for the records that need realtime coordination.

```ts
// web/ablo/schema.ts
import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
  }),
});
```

```ts
// web/ablo.ts — SERVER-ONLY client (holds the sk_ key; never imported in the browser).
import Ablo from '@abloatai/ablo';
import { schema } from './ablo/schema';

export const ablo = Ablo({
  schema,
  apiKey: process.env.ABLO_API_KEY,
});
```

Mount the React provider near the app root. Build the browser client first —
with an `apiKey` resolver (an async `() => Promise<string | null>`) that fetches
the short-lived session token your backend minted, instead of carrying the
secret key — then pass it to the provider via `client`.

```tsx
// web/app/providers.tsx
'use client';

import Ablo from '@abloatai/ablo';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

// Browser client: no secret key — the `apiKey` resolver fetches the session
// token your server route mints (see the session route below).
const ablo = Ablo({
  schema,
  apiKey: () => fetch('/api/ablo-session').then((r) => r.text()),
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider client={ablo}>{children}</AbloProvider>;
}
```

The session route mints with the server client that holds the `sk_` key — the
browser only ever sees the short-lived token:

```ts
// web/app/api/ablo-session/route.ts
import { ablo } from '@/ablo';

export const runtime = 'nodejs';

export async function POST() {
  const userId = await currentUserId(); // your auth
  const { token } = await ablo.sessions.create({ user: { id: userId } });
  return Response.json({ token });
}
```

## 2. Add Live Reads In The UI

Keep the first render backed by the existing Python endpoint. After that,
subscribe to the same model client Ablo writes through.

```tsx
'use client';

import { useAblo } from '@abloatai/ablo/react';

export function ReportRow({
  report: serverReport,
}: {
  report: { id: string; location: string; status: string };
}) {
  const report = useAblo((ablo) => ablo.weatherReports.get(serverReport.id)) ?? serverReport;
  const active = useAblo((ablo) => ablo.weatherReports.claim.state({ id: serverReport.id }));
  const claimed = Boolean(active);

  return (
    <button disabled={claimed || report.status === 'ready'}>
      {claimed ? 'Someone is editing' : report.location}
    </button>
  );
}
```

No string model key is needed in the first example. Because the selector reads
straight from `ablo.weatherReports`, your reads, your writes, and any agent all
go through one client — so a live edit shows up here without extra wiring.

## 3. Add One Python Data Source Endpoint

Expose one customer-owned Data Source endpoint:

```txt
https://api.example.com/api/ablo/source
```

Store the Ablo API key in the Python server:

```bash
ABLO_API_KEY=sk_live_...
```

Then expose one route that verifies the signed request and calls the existing
service functions.

```py
# app/ablo_source.py
import base64
import hashlib
import hmac
import json
import os
import time
from fastapi import APIRouter, HTTPException, Request

from app.services.reports import get_report, list_reports, apply_report_operations

router = APIRouter()


def verify_ablo_signature(request: Request, raw_body: bytes) -> None:
    api_key = os.environ["ABLO_API_KEY"].encode()
    message_id = request.headers.get("webhook-id")
    timestamp = request.headers.get("webhook-timestamp")
    signature_header = request.headers.get("webhook-signature", "")

    if not message_id or not timestamp or not signature_header:
        raise HTTPException(status_code=401, detail="missing signature")

    signed_at = int(timestamp)
    if abs(int(time.time()) - signed_at) > 5 * 60:
        raise HTTPException(status_code=401, detail="expired signature")

    payload = message_id.encode() + b"." + timestamp.encode() + b"." + raw_body
    expected = base64.b64encode(
        hmac.new(api_key, payload, hashlib.sha256).digest()
    ).decode()

    presented = [
        part.removeprefix("v1,")
        for part in signature_header.split()
        if part.startswith("v1,")
    ]

    if not any(hmac.compare_digest(expected, value) for value in presented):
        raise HTTPException(status_code=401, detail="invalid signature")


@router.post("/api/ablo/source")
async def ablo_source(request: Request):
    raw_body = await request.body()
    verify_ablo_signature(request, raw_body)
    body = json.loads(raw_body)

    if body["type"] == "load":
        if body["model"] == "weatherReports":
            return {"row": await get_report(body["id"])}

    if body["type"] == "list":
        if body["model"] == "weatherReports":
            return {"rows": await list_reports(body.get("query", {}))}

    if body["type"] == "commit":
        rows = await apply_report_operations(
            operations=body["operations"],
            client_tx_id=body.get("clientTxId"),
            scope=body.get("scope", {}),
        )
        return {"rows": rows}

    raise HTTPException(status_code=400, detail="unsupported request")
```

`apply_report_operations` should reuse the same transaction and validation logic
the existing Python endpoints already use. Dedupe by `clientTxId` so retries are
safe.

## 4. Move Buttons Gradually

Existing button path:

```txt
Button -> Python endpoint -> service -> database
```

Target button path:

```txt
Button -> ablo.weatherReports.update(...)
Ablo -> Python Data Source endpoint
Python service -> database
Ablo -> realtime fanout and receipt
```

The app does not need a flag-day rewrite. Move one model at a time.

```ts
const snap = ablo.snapshot({ weatherReports: reportId });

await ablo.weatherReports.update({
  id: reportId,
  data: { status: 'ready' },
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

Use `readAt` and `onStale: 'reject'` for actions that depend on state the user
or agent already saw. If two people both click "mark ready" on a report one of
them already finished, `onStale: 'reject'` makes the second write fail instead
of silently clobbering — `readAt: snap.stamp` is the version the user actually
saw, and the write is rejected if the row changed underneath them.

## 5. Report Direct Database Writes

Some writes will still happen through old Python endpoints, cron jobs, admin
tools, or imports. Those bypass Ablo until the backend reports them.

Add an outbox table in Python and expose it through Data Source `events`:

```txt
old Python endpoint -> service -> database -> outbox row
Ablo polls events -> realtime fanout
```

Each event needs a stable event id, model name, entity id, event type, row data,
and timestamp. If the change originated from an Ablo commit, include the same
`clientTxId` so Ablo can ignore its own echo.

## 6. Add Agents Later

Agents use the same model API as the UI:

```ts
const report = await ablo.weatherReports.retrieve({ id: reportId });
const snap = ablo.snapshot({ weatherReports: reportId });

await ablo.weatherReports.update({
  id: reportId,
  data: { status: 'ready' },
  readAt: snap.stamp,
  onStale: 'reject',
  wait: 'confirmed',
});
```

Agents reach for the exact same calls the UI does — the same write contract
stated at the top of this page. The Python backend keeps owning the business
logic and the database; agents just become another safe writer in front of it.
