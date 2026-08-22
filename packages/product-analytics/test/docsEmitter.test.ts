import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { ZodObject, ZodType } from 'zod';

import { productEventSchema } from '../src/events';

/**
 * The documentation site emits product events from an inline browser script,
 * because `docs/ablo` is a standalone npm project outside this workspace and so
 * cannot import `productEventSchema` at build time.
 *
 * That leaves one hand-written copy of the contract in the repository. This
 * test is what stops it drifting: it reads the emitter's source and pins every
 * event name and property key it sends to the schema above. It deliberately
 * asserts against the SCHEMA rather than against a second list kept here, so it
 * cannot pass by agreeing with itself.
 */

const EMITTER_PATH = fileURLToPath(
  new URL('../../../docs/ablo/components/DocsAnalytics.astro', import.meta.url)
);

/** `send("<event>", { … })` calls, with the object literal brace-matched. */
function emittedEvents(source: string): Map<string, ReadonlySet<string>> {
  const emitted = new Map<string, ReadonlySet<string>>();
  const call = /send\(\s*"([a-z_]+)"\s*,\s*\{/g;

  for (let match = call.exec(source); match !== null; match = call.exec(source)) {
    const [, eventName] = match;
    const objectStart = match.index + match[0].length - 1;
    emitted.set(eventName as string, topLevelKeys(source, objectStart));
  }
  return emitted;
}

/**
 * Keys declared directly in the object literal opening at `start`. Depth
 * tracking matters: a `${…}` interpolation inside a template literal value
 * opens braces of its own, and its contents are not properties.
 */
function topLevelKeys(source: string, start: number): ReadonlySet<string> {
  const keys = new Set<string>();
  let depth = 0;
  let index = start;
  let keyCandidate = '';

  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && character === ':' && keyCandidate.trim()) {
      keys.add(keyCandidate.trim());
      keyCandidate = '';
      continue;
    } else if (depth === 1 && (character === ',' || character === '\n')) {
      keyCandidate = '';
      continue;
    }
    if (depth === 1 && /[A-Za-z0-9_]/.test(character as string)) keyCandidate += character;
  }
  return keys;
}

function propertyShape(eventName: string): Record<string, ZodType> {
  const option = productEventSchema.options.find(
    (candidate) => candidate.shape.eventName.value === eventName
  );
  if (!option) throw new Error(`${eventName} is not in productEventSchema`);
  return (option.shape.properties as ZodObject).shape as Record<string, ZodType>;
}

const source = readFileSync(EMITTER_PATH, 'utf8');
const emitted = emittedEvents(source);

describe('documentation emitter matches the product event contract', () => {
  it('emits at least one event', () => {
    expect(emitted.size).toBeGreaterThan(0);
  });

  it.each([...emitted.keys()])('%s is a known event name', (eventName) => {
    expect(productEventSchema.options.map((option) => option.shape.eventName.value)).toContain(
      eventName
    );
  });

  it.each([...emitted.entries()])('%s sends only declared properties', (eventName, keys) => {
    const declared = Object.keys(propertyShape(eventName));
    expect([...keys].filter((key) => !declared.includes(key))).toEqual([]);
  });

  it.each([...emitted.entries()])('%s sends every required property', (eventName, keys) => {
    const shape = propertyShape(eventName);
    const required = Object.entries(shape)
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key);
    expect(required.filter((key) => !keys.has(key))).toEqual([]);
  });
});
