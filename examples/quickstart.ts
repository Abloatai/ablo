/**
 * Quickstart — schema-backed state coordination.
 *
 * Run:
 *
 *   ABLO_API_KEY=sk_test_... npx tsx quickstart.ts
 */

import Ablo from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  weatherReports: model({
    location: z.string(),
    status: z.enum(['pending', 'ready']),
    forecast: z.string().optional(),
  }),
});

async function getWeather(location: string): Promise<string> {
  return `Light rain in ${location}, 13C`;
}

async function main() {
  const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
  const location = process.env.WEATHER_LOCATION ?? 'Stockholm';

  try {
    await ablo.ready();

    const created = await ablo.weatherReports.create({
      location,
      status: 'pending',
    });

    const updated = await ablo.weatherReports.update(created.id, {
      status: 'ready',
      forecast: await getWeather(created.location),
    });

    console.log('updated', {
      id: updated.id,
      status: updated.status,
      forecast: updated.forecast,
    });
  } finally {
    await ablo.dispose();
  }
}

main().catch((err) => {
  console.error('quickstart failed:', err);
  process.exit(1);
});
