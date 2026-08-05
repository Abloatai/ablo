const rawDsn = process.env.ABLO_CLI_SENTRY_DSN;

if (!rawDsn) {
  throw new Error(
    'Refusing to publish an unobservable CLI: ABLO_CLI_SENTRY_DSN must be set by the release job.',
  );
}

const dsn = new URL(rawDsn);
if (dsn.protocol !== 'https:' || !dsn.username || !dsn.hostname) {
  throw new Error('ABLO_CLI_SENTRY_DSN must be a valid public HTTPS Sentry DSN.');
}

console.log(`CLI observability enabled for ${dsn.hostname}.`);
