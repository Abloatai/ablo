import { z } from 'zod';

export const PRODUCT_EVENT_VERSION = 1 as const;
export const MAX_PRODUCT_EVENT_BATCH_SIZE = 50;

const shortToken = z.string().trim().min(1).max(100);
const routeClass = z.string().trim().min(1).max(160);
const optionalCampaign = z.string().trim().min(1).max(100).optional();

const eventEnvelope = {
  producerEventId: z.uuid(),
  eventVersion: z.literal(PRODUCT_EVENT_VERSION),
  occurredAt: z.iso.datetime({ offset: true }),
};

function event<Name extends string, Properties extends z.ZodType>(
  eventName: Name,
  properties: Properties
) {
  return z.strictObject({
    ...eventEnvelope,
    eventName: z.literal(eventName),
    properties,
  });
}

const marketingPageViewed = event(
  'marketing_page_viewed',
  z.strictObject({
    pageClass: routeClass,
    referrerClass: shortToken,
    utmSource: optionalCampaign,
    utmMedium: optionalCampaign,
    utmCampaign: optionalCampaign,
  })
);

const marketingCtaClicked = event(
  'marketing_cta_clicked',
  z.strictObject({
    ctaId: shortToken,
    surface: shortToken,
    destinationClass: shortToken,
  })
);

const docsPageViewed = event(
  'docs_page_viewed',
  z.strictObject({ documentationRouteClass: routeClass })
);

const docsCtaClicked = event(
  'docs_cta_clicked',
  z.strictObject({
    ctaId: shortToken,
    destinationClass: shortToken,
  })
);

const waitlistJoined = event('waitlist_joined', z.strictObject({ source: shortToken }));

const signupCompleted = event(
  'signup_completed',
  z.strictObject({ signupSource: shortToken.optional() })
);

export const cliOsSchema = z.enum(['darwin', 'linux', 'win32', 'other']);
export const cliArchitectureSchema = z.enum(['arm64', 'x64', 'ia32', 'other']);

const cliInitStarted = event(
  'cli_init_started',
  z.strictObject({
    cliVersion: shortToken,
    nodeMajorVersion: z.number().int().min(18).max(100),
    os: cliOsSchema,
    architecture: cliArchitectureSchema,
    interactive: z.boolean(),
    source: shortToken,
  })
);

const cliInitCompleted = event(
  'cli_init_completed',
  z.strictObject({
    durationBucket: z.enum(['under_1s', '1s_to_5s', '5s_to_30s', '30s_to_2m', 'over_2m']),
    setupClass: shortToken,
  })
);

const cliDevStarted = event(
  'cli_dev_started',
  z.strictObject({ mode: shortToken, cliVersion: shortToken })
);

const cliSchemaPushAttempted = event(
  'cli_schema_push_attempted',
  z.strictObject({ sourceCommand: z.enum(['init', 'push']) })
);

const schemaPushSucceeded = event(
  'schema_push_succeeded',
  z.strictObject({
    changeClass: z.enum(['initial', 'changed', 'unchanged']),
    clientClass: shortToken.optional(),
  })
);

const firstConfirmedCommit = event(
  'first_confirmed_commit',
  z.strictObject({ storageResultClass: shortToken })
);

const firstCoordinatedCommit = event(
  'first_coordinated_commit',
  z.strictObject({ coordinationEvidenceClass: shortToken })
);

const actorCoordinatedCommitActivated = event(
  'actor_coordinated_commit_activated',
  z.strictObject({
    coordinationEvidenceClass: shortToken,
    actorKind: z.enum(['user', 'agent', 'system']),
  })
);

const coordinatedCommitSucceeded = event(
  'coordinated_commit_succeeded',
  z.strictObject({ coordinationEvidenceClass: shortToken })
);

const coordinationIntervention = event(
  'coordination_intervention',
  z.strictObject({
    interventionClass: z.enum(['stale_context', 'claim_conflict', 'queued', 'preempted']),
    outcome: z.enum(['accepted', 'rejected']),
  })
);

const githubAcquisitionSnapshotCollected = event(
  'github_acquisition_snapshot_collected',
  z.strictObject({
    repositoryClass: shortToken,
    windowStart: z.iso.date(),
    windowEnd: z.iso.date(),
    views: z.number().int().nonnegative(),
    uniqueVisitors: z.number().int().nonnegative(),
    clones: z.number().int().nonnegative(),
    uniqueCloneClients: z.number().int().nonnegative(),
    stars: z.number().int().nonnegative(),
  })
);

const npmAcquisitionSnapshotCollected = event(
  'npm_acquisition_snapshot_collected',
  z.strictObject({
    packageClass: shortToken,
    windowStart: z.iso.date(),
    windowEnd: z.iso.date(),
    downloads: z.number().int().nonnegative(),
    latestVersion: shortToken,
    latestPublishedAt: z.iso.datetime({ offset: true }),
    versions: z.number().int().nonnegative(),
  })
);

export const productEventSchema = z.discriminatedUnion('eventName', [
  marketingPageViewed,
  marketingCtaClicked,
  docsPageViewed,
  docsCtaClicked,
  waitlistJoined,
  signupCompleted,
  cliInitStarted,
  cliInitCompleted,
  cliDevStarted,
  cliSchemaPushAttempted,
  schemaPushSucceeded,
  firstConfirmedCommit,
  firstCoordinatedCommit,
  actorCoordinatedCommitActivated,
  coordinatedCommitSucceeded,
  coordinationIntervention,
  githubAcquisitionSnapshotCollected,
  npmAcquisitionSnapshotCollected,
]);

export const productEventBatchSchema = z.strictObject({
  anonymousId: z.string().trim().min(16).max(200).optional(),
  events: z.array(productEventSchema).min(1).max(MAX_PRODUCT_EVENT_BATCH_SIZE),
});

export type ProductEvent = z.infer<typeof productEventSchema>;
export type ProductEventBatch = z.infer<typeof productEventBatchSchema>;
export type ProductEventName = ProductEvent['eventName'];

export const PRODUCT_EVENT_NAMES = productEventSchema.options.map(
  (schema) => schema.shape.eventName.value
) as readonly ProductEventName[];
