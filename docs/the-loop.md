# The loop: how your data flows

This explainer moved to the canonical, maintained docs:

**→ https://abloatai.com/docs/webhooks**

The short version: Ablo has the same two-sided shape as Stripe — **you call Ablo to make changes (the client), and Ablo calls you to persist them (a signed webhook)** — plus realtime sync to every connected client.

```
your app ──write──▶  Ablo (hosted)  ──realtime sync──▶  other clients
 (the client)        the transaction log               (live, optimistic)
                            │
                            └──signed event──▶  /api/ablo/[...all]  ──▶  YOUR database
                                                (the webhook route)
```

Ablo owns the ordered transaction log (the source of truth); your database is a
materialized copy you keep via the webhook. See the link above for the full
guide: scaffolding the handler (`ablo init`), local testing (`ablo dev`),
registering an endpoint (`ablo webhooks create`), signature verification, the
delivery/retry model, and best practices.
