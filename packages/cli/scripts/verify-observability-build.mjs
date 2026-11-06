const token = process.env.ABLO_CLI_POSTHOG_PROJECT_TOKEN;
const host = process.env.ABLO_CLI_POSTHOG_HOST;
if (!token?.startsWith('phc_') || !['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(host)) {
  throw new Error('CLI publishing requires public ABLO_CLI_POSTHOG_PROJECT_TOKEN and ABLO_CLI_POSTHOG_HOST.');
}
console.log('CLI PostHog ingestion configuration validated.');
