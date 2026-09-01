import { readFileSync } from "node:fs";
import { defineConfig } from "blume";
import { apiReferenceSidebar } from "./navigation/api-reference";

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
  // The site name search engines show for docs.abloatai.com results and the
  // suffix of every document title. "Ablo Docs", not "Ablo": the bare brand
  // name belongs to www.abloatai.com, and a reader scanning results should be
  // able to tell the two hosts apart.
  title: "Ablo Docs",
  description: landingPromise(),

  logo: {
    image: { light: "/logo/light.svg", dark: "/logo/dark.svg", alt: "Ablo" },
    href: "https://www.abloatai.com",
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
        apiReferenceSidebar(new URL("./public/openapi.json", import.meta.url)),
        {
          label: "Get Started",
          icon: "play",
          items: [
            "/",
            "/comparison",
            "/installation",
            "/basic-usage",
            "/pricing",
          ],
        },
        {
          label: "Guides",
          icon: "route",
          items: [
            "/implement",
            "/coordinate-existing-work",
            "/agents",
            "/react",
            "/mcp",
            "/approaches/graphql/graphql-js",
          ],
        },
        {
          label: "Concepts",
          icon: "lightbulb",
          items: [
            "/how-it-works",
            "/coordination",
            "/concurrency-convention",
            "/context",
            "/transports",
            "/guarantees",
            "/idempotency",
            "/identity",
            "/groups",
            "/agent-messaging",
          ],
        },
        {
          label: "Authority",
          icon: "shield",
          items: ["/projects", "/api-keys", "/sessions", "/customer-organizations", "/audit"],
        },
        {
          label: "Database & Deployment",
          icon: "hard-drive",
          items: [
            "/schema-contract",
            "/data-sources",
            "/branch-development",
            "/deployment",
            "/operating-on-your-database",
            "/session-settings",
          ],
        },
        {
          label: "Integrations",
          icon: "blocks",
          items: [
            "/integrations",
            "/integrations/temporal",
            "/integrations/inngest",
            "/integrations/sandbox-runtime",
            "/webhooks",
          ],
        },
        {
          label: "Examples",
          icon: "folder-code",
          items: [
            "/examples/ai-sdk-tool",
            "/examples/agent-human",
            "/examples/scoped-agent",
            "/examples/server-agent",
            "/examples/coordination-conformance",
            "/examples/existing-python-backend",
            "/examples/evidence-backed-document-pipeline",
            "/examples/nextjs",
          ],
        },
        {
          label: "Reference",
          icon: "library",
          items: [
            "/api",
            "/options",
            "/errors",
            "/cli",
            "/security",
            "/instrumentation",
            "/faq",
            "/client-behavior",
            "/migration",
          ],
        },
      ],
    },
  },
});
