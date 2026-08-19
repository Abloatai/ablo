/**
 * Pure renderers for the two public discovery descriptors, shared by the
 * generator (generate-discovery-docs.mts, writes to disk) and its `--check`
 * guard. String in, string out, so the check can prove the committed files
 * still agree with their sources without touching anything.
 *
 * The descriptors say, in machine-readable form, what a catalog or an agent
 * would otherwise have to infer by crawling: which contract documents exist,
 * what a plan costs, and what it actually takes to walk up and get a working
 * credential. Both are therefore assembled from the definition sites that
 * already own those answers — the pricing contract for plans, the published
 * OpenAPI document for the contract and its host, the docs landing frontmatter
 * for the promise line — and nothing here restates a value that lives
 * elsewhere. A descriptor typed by hand is the same defect as a doc written by
 * hand: it is right on the day it ships and silently wrong afterwards.
 *
 * Two documents live in one module because they cross-reference each other.
 * The APIs.json index links the onboarding descriptor, and the onboarding
 * descriptor links back to the index; generated together, that pair cannot
 * come apart.
 */
import { z } from 'zod';
import {
  ABLO_DOCS_BASE_URL,
  ABLO_HOSTED_HTTP_BASE_URL,
  ABLO_SITE_BASE_URL,
} from '@abloatai/transaction/auth';
import {
  PLANS,
  PLAN_FEATURE_LABEL,
  PLAN_ORDER,
  type PlanDefinition,
} from '@abloatai/transaction/pricing';

/**
 * The slice of the published OpenAPI document these descriptors quote. Read
 * from `docs/ablo/public/openapi.json` rather than rebuilt from `abloOpenApi()`
 * so the catalog describes the artifact actually served, and parsed at this
 * boundary so a missing field fails here instead of shipping a descriptor with
 * `undefined` in it.
 */
const publishedOpenApiSchema = z.object({
  info: z.object({
    title: z.string(),
    description: z.string(),
    version: z.string(),
    license: z.object({ name: z.string(), identifier: z.string().optional() }).optional(),
  }),
  servers: z.array(z.object({ url: z.string(), description: z.string() })).min(1),
  paths: z.record(z.string(), z.unknown()),
});
export type PublishedOpenApi = z.infer<typeof publishedOpenApiSchema>;

export function parsePublishedOpenApi(json: string): PublishedOpenApi {
  return publishedOpenApiSchema.parse(JSON.parse(json));
}

/** Where each descriptor is served, relative to the documentation site root. */
export const APIS_JSON_PATH = '.well-known/apis.json';
export const ONBOARDING_PATH = '.well-known/api-onboarding';

const apisJsonUrl = `${ABLO_DOCS_BASE_URL}/${APIS_JSON_PATH}`;
const onboardingUrl = `${ABLO_DOCS_BASE_URL}/${ONBOARDING_PATH}`;

/**
 * The date this index first existed. APIs.json carries `created`/`modified`
 * timestamps; only `created` is emitted, because a `modified` stamped at
 * generation time would differ on every run and the drift guard would never
 * pass. The SDK version below is the marker that actually moves.
 */
const CREATED = '2026/08/19';

/**
 * How this catalog files Ablo. The only editorial values in either document,
 * and there is no prior list to derive them from: the npm package carries no
 * `keywords`, and the docs site has no tag vocabulary. This is that definition
 * site. Written for what a person types into a catalog search, which is why
 * "coordination" appears and "sync" does not (ADR 0016).
 */
const TAGS = [
  'agents',
  'multi-agent',
  'coordination',
  'concurrency',
  'state',
  'postgres',
  'real-time',
  'mcp',
] as const;

/** `1000000` reads as `1M`. Matches the pricing page's own compact form. */
function formatOps(ops: number): string {
  if (ops >= 1_000_000) return `${Number((ops / 1_000_000).toFixed(2))}M`;
  if (ops >= 1_000) return `${Number((ops / 1_000).toFixed(2))}K`;
  return String(ops);
}

/**
 * What a plan gates, in the descriptor's own terms. Every clause reads a field
 * off the pricing contract, so a rate change moves this sentence without anyone
 * editing it.
 */
function planRequirement(plan: PlanDefinition): string {
  const said: string[] = [plan.summary];

  if (plan.monthlyMinimumUsd === null) {
    said.push('Monthly minimum set in the contract.');
  } else if (plan.monthlyMinimumUsd === 0) {
    said.push('No card and no monthly minimum.');
  } else {
    said.push(`$${plan.monthlyMinimumUsd} monthly minimum, with usage metered against it.`);
  }

  if (plan.hardCapOps !== null && plan.hardCapOpsPerDay !== null) {
    said.push(
      `Capped rather than metered: ${formatOps(plan.hardCapOps)} operations a month and ${formatOps(plan.hardCapOpsPerDay)} a day, refused beyond that.`,
    );
  }

  said.push(
    plan.maxConcurrentConnections === null
      ? 'Concurrency negotiated.'
      : `Up to ${plan.maxConcurrentConnections.toLocaleString('en-US')} concurrent connections.`,
  );

  if (plan.features.length > 0) {
    said.push(`Adds ${plan.features.map((f) => PLAN_FEATURE_LABEL[f].toLowerCase()).join(', ')}.`);
  }

  return said.join(' ');
}

/**
 * The APIs.json index (apisjson.org), served at `/.well-known/apis.json` and
 * mirrored at `/apis.json`. Its job is to point at every other artifact, so
 * each `properties` entry is a URL this repo already publishes; nothing is
 * listed that a crawler would then fail to fetch.
 */
export function renderApisJson(openapi: PublishedOpenApi, promise: string): string {
  const production = openapi.servers[0];

  const index = {
    specificationVersion: '0.21',
    name: 'Ablo',
    description: promise,
    url: apisJsonUrl,
    created: CREATED,
    tags: [...TAGS],
    maintainers: [{ FN: 'Ablo', email: 'support@abloatai.com', url: ABLO_SITE_BASE_URL }],
    common: [
      { type: 'Terms of Service', url: `${ABLO_SITE_BASE_URL}/terms-conditions` },
      { type: 'Privacy Policy', url: `${ABLO_SITE_BASE_URL}/privacy-policy` },
      { type: 'ChangeLog', url: `${ABLO_DOCS_BASE_URL}/changelog` },
      { type: 'APIOnboarding', url: onboardingUrl },
    ],
    apis: [
      {
        name: openapi.info.title,
        description: openapi.info.description,
        humanURL: ABLO_DOCS_BASE_URL,
        baseURL: production.url,
        image: `${ABLO_DOCS_BASE_URL}/logo/light.svg`,
        tags: [...TAGS],
        properties: [
          { type: 'OpenAPI', url: `${ABLO_DOCS_BASE_URL}/openapi.json` },
          { type: 'Documentation', url: ABLO_DOCS_BASE_URL },
          { type: 'GettingStarted', url: `${ABLO_DOCS_BASE_URL}/quickstart` },
          { type: 'Authentication', url: `${ABLO_DOCS_BASE_URL}/api-keys` },
          { type: 'Plans', url: `${ABLO_DOCS_BASE_URL}/pricing` },
          { type: 'Pricing', url: `${ABLO_DOCS_BASE_URL}/pricing.json` },
          { type: 'RateLimits', url: `${ABLO_DOCS_BASE_URL}/pricing` },
          { type: 'ChangeLog', url: `${ABLO_DOCS_BASE_URL}/changelog` },
          { type: 'Errors', url: `${ABLO_DOCS_BASE_URL}/errors.json` },
          { type: 'APIOnboarding', url: onboardingUrl },
          { type: 'LLMsTxt', url: `${ABLO_DOCS_BASE_URL}/llms.txt` },
          // The repository rather than the npm package page: npmjs.com answers a
          // plain GET with 403 behind its bot protection, and an index whose
          // whole purpose is being read by machines cannot cite a URL only a
          // browser can fetch.
          { type: 'SDKs', url: 'https://github.com/Abloatai/ablo' },
          { type: 'License', url: 'https://github.com/Abloatai/ablo/blob/main/LICENSE' },
        ],
      },
    ],
  };

  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * The route the executable flow below drives. Looked up in the published
 * document rather than trusted: if the mint route is ever renamed, generation
 * fails here instead of publishing a flow that 404s for whoever runs it.
 */
const MINT_PATH = '/v1/ephemeral_keys';

/**
 * The API Onboarding Descriptor (apicommons.org/onboarding), served at
 * `/.well-known/api-onboarding`. It answers the question OpenAPI does not:
 * what it takes to get to a working credential in the first place.
 *
 * The honest bucket is `bootstrap-token`. A person creates the organization in
 * a browser and approves one device-flow grant; from there every further
 * credential is minted over the API, which is what the flow at the bottom
 * executes. Claiming `self-serve` would be the flattering answer and would fail
 * the first agent that believed it.
 */
export function renderOnboardingDescriptor(openapi: PublishedOpenApi): string {
  if (!(MINT_PATH in openapi.paths)) {
    throw new Error(
      `[discovery] ${MINT_PATH} is not in the published OpenAPI document — the onboarding flow would describe a route that no longer exists.`,
    );
  }
  const production = openapi.servers[0];
  const mintUrl = `${production.url}${MINT_PATH}`;

  const descriptor = {
    aod: '0.1',
    provider: {
      name: 'Ablo',
      url: ABLO_SITE_BASE_URL,
      portalUrl: ABLO_DOCS_BASE_URL,
      apisJsonUrl,
    },
    maturity: 'bootstrap-token',
    account: {
      required: true,
      signupUrl: `${ABLO_SITE_BASE_URL}/signup`,
      // Onboarding, not use. An agent is a first-class caller of this API and
      // holds its own credential; what it cannot do is create the account that
      // issues the first one, because that step is a browser flow with no
      // programmatic equivalent. Saying `allowed` here would send an agent into
      // a signup wizard it cannot finish.
      agentPolicy: 'prohibited',
      prerequisites: [
        'A Postgres database Ablo can reach. Rows stay in your database; Ablo holds the transaction log and the coordination state, not your data.',
        'A logical replication role on that database, or the signed data-source endpoint where replication cannot be granted.',
      ],
      plans: PLAN_ORDER.map((tier) => ({
        name: PLANS[tier].label,
        requiredFor: planRequirement(PLANS[tier]),
        url: `${ABLO_DOCS_BASE_URL}/pricing`,
      })),
      termsOfService: {
        url: `${ABLO_SITE_BASE_URL}/terms-conditions`,
        acceptance: 'console-only',
      },
    },
    // Nothing queues between creating an account and holding a working key.
    verification: [],
    registration: {
      applicationNoun: 'project',
      owner: 'organization',
      mechanisms: [
        {
          type: 'browser-oauth',
          description: `\`npx ablo login\` runs the RFC 8628 device authorization flow: it prints a code, opens ${ABLO_SITE_BASE_URL}/cli, and a person approves the grant there. What comes back is one project management credential. This is the only step that needs a human, and an agent must not attempt it.`,
          authorizationEndpoint: `${ABLO_SITE_BASE_URL}/cli`,
          docsUrls: [`${ABLO_DOCS_BASE_URL}/cli`, `${ABLO_DOCS_BASE_URL}/api-keys`],
          auth: 'none',
        },
        {
          type: 'management-api',
          description: `Once a management credential exists, every further credential is minted over the API and no console is involved: \`ablo dev\` exchanges it for a branch-bound secret key, and POST ${MINT_PATH} mints the short-lived session credential a browser or a per-user agent runs on.`,
          baseUrl: production.url,
          registrationEndpoint: mintUrl,
          docsUrls: [`${ABLO_DOCS_BASE_URL}/api-keys`],
          auth: 'bearer',
        },
      ],
    },
    authentication: {
      methods: [
        {
          id: 'management-key',
          type: 'bearer-env',
          env: ['ABLO_MANAGEMENT_KEY'],
          header: 'Authorization',
          scheme: 'Bearer',
          bootstrap: 'A person runs `npx ablo login` once and approves the device grant in a browser. In CI there is no login: the value is set as an environment variable.',
          notes: 'Control-plane commands only: projects, branches, and schema pushes.',
        },
        {
          id: 'api-key',
          type: 'bearer-env',
          env: ['ABLO_API_KEY'],
          header: 'Authorization',
          scheme: 'Bearer',
          bootstrap: '`ablo dev --no-watch --branch <ref>` exchanges the management credential for a branch-bound secret key and writes it to a gitignored `.env.local`. No secret is copied by hand.',
          notes: 'The runtime credential every read, commit, and claim authenticates with.',
        },
      ],
    },
    credentials: [
      {
        type: 'api-key',
        fields: { api_key: 'sk_ secret key' },
        ttl: 'Branch-bound secret keys expire with the branch they were minted for.',
        rotation: 'Re-run `ablo dev` to mint a fresh branch key; revoke from the dashboard.',
        // The plaintext exists only in the mint response. Nothing can hand it
        // back later, which is why no tool in the MCP server returns one.
        oneTimeDisplay: true,
      },
      {
        type: 'access-token',
        fields: { access_token: 'token' },
        ttl: 'Short-lived; the caller sets `ttlSeconds` on the mint request.',
        rotation: `Mint another from ${MINT_PATH}. Sessions are meant to be re-minted rather than refreshed, and the SDK re-mints on expiry without dropping the connection.`,
        oneTimeDisplay: true,
      },
    ],
    scopes: {
      model: 'resource-selection',
      resourceSelection: 'projects and branches, plus the organization and user a session credential is minted for',
      vocabularyUrl: `${ABLO_DOCS_BASE_URL}/identity`,
      notes: 'Authority comes from what a credential was minted against rather than from scope strings. A session credential encodes its organization and user, so reads are scoped without the caller passing an organization id.',
    },
    flow: {
      args: [
        {
          name: 'user_id',
          description: 'Your own identifier for the person or agent this session belongs to.',
          required: true,
        },
      ],
      steps: [
        {
          id: 'mint',
          description: 'Mint a session credential from a branch-bound secret key. This is the whole programmatic surface: everything before it is the one-time human bootstrap.',
          auth: 'api-key',
          request: {
            method: 'POST',
            url: mintUrl,
            headers: {
              Authorization: 'Bearer {env.ABLO_API_KEY}',
              'Content-Type': 'application/json',
            },
            body: {
              user: { id: '{arg.user_id}' },
            },
          },
        },
      ],
      outputs: {
        access_token: '{steps.mint.token}',
        expires_at: '{steps.mint.expiresAt}',
      },
    },
    economics: {
      pricingUrl: `${ABLO_DOCS_BASE_URL}/pricing`,
      freeTier: planRequirement(PLANS.free),
      rateLimitsUrl: `${ABLO_DOCS_BASE_URL}/pricing`,
    },
    gaps: [
      'Account creation is a browser flow. No API creates an organization, so the first credential always needs a person.',
      'No Dynamic Client Registration (RFC 7591) and no Client ID Metadata Document. An agent onboards by being handed an environment variable, not by registering itself.',
      'The coordination MCP server ships as an npm package a host runs locally, not as a hosted endpoint an agent can discover by URL.',
    ],
  };

  return `${JSON.stringify(descriptor, null, 2)}\n`;
}
