import { defineConfig } from "blume";

/**
 * Ablo documentation site.
 *
 * Most pages under `docs/` are generated — prose from
 * `packages/sync-engine/docs/*.md`, the error reference from the code registry,
 * and `docs/changelog/*` from `CHANGELOG.md` — via `npm run build:docs` /
 * `npm run generate:errors` in that package. Edit the sources, not the output.
 * The `navigation.sidebar` below mirrors the curated group order the site
 * carried on Mintlify; new generated pages must be added to their group here.
 */
export default defineConfig({
  title: "Ablo",
  description: "An open protocol for agent-native multiplayer state",

  logo: {
    image: { light: "/logo/light.svg", dark: "/logo/dark.svg", alt: "Ablo" },
    href: "https://abloatai.com",
  },

  theme: {
    accent: "#1a1a1a",
    radius: "sm",
    mode: "light",
    background: { light: "#fafafa", dark: "#262522" },
    fonts: { display: "inter", body: "inter" },
  },

  markdown: {
    codeBlocks: {
      theme: { light: "github-light", dark: "github-dark" },
    },
  },

  // Renders the OpenAPI reference at /api-reference (the /api route is the SDK
  // API page); the spec is the served copy in public/.
  openapi: {
    enabled: true,
    spec: "./public/openapi.json",
    route: "/api-reference",
  },

  github: {
    owner: "Abloatai",
    repo: "ablo",
  },

  // Canonical docs host — the target of every error `doc_url`. Enables the
  // sitemap and absolute Open Graph / RSS URLs.
  deployment: {
    site: "https://docs.abloatai.com",
  },

  navigation: {
    tabs: [
      { label: "API Reference", path: "/api-reference" },
      { label: "Changelog", path: "/changelog" },
    ],
    sidebar: [
      {
        label: "Get Started",
        items: ["/", "/quickstart", "/integration-guide", "/cli"],
      },
      {
        label: "Concepts",
        items: [
          "/identity",
          "/groups",
          "/coordination",
          "/concurrency-convention",
          "/interaction-model",
          "/schema-contract",
          "/guarantees",
          "/client-behavior",
        ],
      },
      {
        label: "Authority",
        items: ["/projects", "/api-keys", "/sessions", "/audit"],
      },
      {
        label: "Storage",
        items: ["/data-sources"],
      },
      {
        label: "Agents",
        items: ["/agents", "/agent-messaging"],
      },
      {
        label: "Webhooks",
        items: ["/webhooks"],
      },
      {
        label: "Frontend",
        items: ["/react"],
      },
      {
        label: "Examples",
        items: [
          "/examples/ai-sdk-tool",
          "/examples/agent-human",
          "/examples/server-agent",
          "/examples/existing-python-backend",
          "/examples/nextjs",
        ],
      },
      {
        label: "MCP",
        items: ["/mcp", "/mcp/claude-code", "/mcp/cursor", "/mcp/windsurf"],
      },
      {
        label: "SDK Reference",
        items: ["/api", "/errors", "/migration"],
      },
    ],
  },
});
