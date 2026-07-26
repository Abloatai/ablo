import { readFileSync } from "node:fs";
import { defineConfig } from "blume";

/**
 * The site description IS the landing page's promise line. That line has one
 * definition site — the blockquote under the H1 of
 * `packages/ablo/docs/index.md` — which `npm run build:docs` lifts into
 * `docs/index.mdx` frontmatter. Read it here rather than restating it; the
 * build script pins `llms.txt` to the same line.
 */
function landingPromise(): string {
  const mdx = readFileSync(new URL("./docs/index.mdx", import.meta.url), "utf8");
  const described = mdx.match(/^description: (".*")$/m);
  if (!described) {
    throw new Error(
      "docs/index.mdx carries no description — run `npm run build:docs` in packages/ablo.",
    );
  }
  return JSON.parse(described[1]) as string;
}

/**
 * Ablo documentation site.
 *
 * Most pages under `docs/` are generated — prose from
 * `packages/ablo/docs/*.md`, the error reference from the code registry,
 * and `docs/changelog/*` from `CHANGELOG.md` — via `npm run build:docs` /
 * `npm run generate:errors` in that package. Edit the sources, not the output.
 * The `navigation.sidebar` below mirrors the curated group order the site
 * carried on Mintlify; new generated pages must be added to their group here.
 */
export default defineConfig({
  title: "Ablo",
  description: landingPromise(),

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
    // The root tab is the way back to the prose docs from the reference and the
    // changelog. `activeTabForRoute` picks the longest matching path, so `/`
    // acts as the fallback and yields to the two specific tabs on their routes.
    // (No `icon` here: the header renders a tab's label only.)
    tabs: [
      { label: "Docs", path: "/" },
      { label: "API Reference", path: "/api-reference" },
      { label: "Changelog", path: "/changelog" },
    ],
    sidebar: {
      // Collapsible disclosures rather than one long flat list: ten groups of
      // prose is more than fits on screen. A group opens automatically when the
      // current page is inside it, so a reader never lands in a closed section,
      // and `components/SidebarAccordion.astro` keeps only one open at a time.
      // No group is pinned open: under an exclusive accordion a second forced-
      // open group would just be closed again by the browser.
      display: "group",
      items: [
        {
          label: "Get Started",
          icon: "play",
          items: ["/", "/quickstart", "/integration-guide", "/deployment", "/cli", "/debugging"],
        },
        {
          label: "Concepts",
          icon: "lightbulb",
          items: [
            "/how-it-works",
            "/identity",
            "/groups",
            "/coordination",
            "/concurrency-convention",
            "/interaction-model",
            "/schema-contract",
            "/guarantees",
            "/idempotency",
            "/client-behavior",
          ],
        },
        {
          label: "Authority",
          icon: "shield",
          items: ["/projects", "/api-keys", "/sessions", "/audit"],
        },
        {
          label: "Storage",
          icon: "hard-drive",
          items: ["/data-sources", "/operating-on-your-database", "/session-settings"],
        },
        {
          label: "Agents",
          icon: "cpu",
          items: ["/agents", "/agent-messaging"],
        },
        {
          label: "Integrations",
          icon: "blocks",
          items: ["/integrations", "/integrations/temporal", "/integrations/inngest"],
        },
        {
          label: "Webhooks",
          icon: "radio-tower",
          items: ["/webhooks"],
        },
        {
          label: "Frontend",
          icon: "app-window",
          items: ["/react"],
        },
        {
          label: "Examples",
          icon: "folder-code",
          items: [
            "/examples/ai-sdk-tool",
            "/examples/agent-human",
            "/examples/scoped-agent",
            "/examples/server-agent",
            "/examples/existing-python-backend",
            "/examples/nextjs",
          ],
        },
        {
          label: "MCP",
          icon: "blocks",
          items: ["/mcp", "/mcp/claude-code", "/mcp/cursor", "/mcp/windsurf"],
        },
        {
          label: "SDK Reference",
          icon: "library",
          items: ["/api", "/errors", "/migration"],
        },
      ],
    },
  },
});
