# @ablo/agent

Internal transaction-backed perception composition used by Ablo's own
applications.

This package is not a second Ablo client and is not a general agent framework.
Agents use the same `@abloatai/ablo` transaction API as backend services. The
package may adapt that API to application AI SDK hooks, but it does not own
HTTP, WebSocket, durable execution, queues, sandboxes, prompts, or model
providers.

Ownership is intentionally elsewhere:

- generated-code isolation and virtual filesystems: `@ablo/execute-sandbox`
- product prompts and skills: `@ablo/prompts`
- model selection and provider routing: `@ablo/ai`
- durable execution integrations: optional packages such as
  `@abloatai/temporal`
- concrete workers and dispatch: the application that deploys them

The package is private because Ablo's public agent surface is the ordinary
`@abloatai/ablo` API, with optional model tools at
`@abloatai/ablo/ai-sdk`. An agent is a caller of that API, not a separate
product primitive.
