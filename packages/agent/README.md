# @ablo/agent

Internal adapters that compose Ablo rows and claims into the AI SDK calls of
Ablo's own applications.

The `Agent` perception source reads rows and claims through an existing
`@abloatai/ablo` transaction client and adds that context to model calls. The
public agent surface is the ordinary `@abloatai/ablo` API, with model tools at
`@abloatai/ablo/ai-sdk`.
