import { readFileSync } from 'node:fs';
import { extractOperations, type ApiDocument } from 'blume/openapi/model';
import type { SidebarItemConfig } from 'blume/schema';

const API_REFERENCE_ROUTE = '/api-reference';
const RESOURCE_ICONS = {
  branches: 'git-branch',
  claims: 'hand',
  commits: 'git-commit-horizontal',
  credentials: 'key-round',
  logs: 'scroll-text',
  models: 'database',
  schema: 'braces',
} as const;

/**
 * Own the API Reference tab's navigation beneath the OpenAPI boundary.
 *
 * Blume gives every operation its own page. Deriving this tree from the same
 * document keeps the left sidebar complete when an endpoint or resource is
 * added, without making readers scan the general documentation navigation.
 */
export function apiReferenceSidebar(specUrl: URL): SidebarItemConfig {
  const document = JSON.parse(readFileSync(specUrl, 'utf8')) as ApiDocument;
  const { operations, tags, warnings } = extractOperations(document, API_REFERENCE_ROUTE);

  if (warnings.length > 0) {
    throw new Error(`OpenAPI navigation is incomplete:\n${warnings.join('\n')}`);
  }

  return {
    label: 'API Reference',
    root: API_REFERENCE_ROUTE,
    items: [
      API_REFERENCE_ROUTE,
      ...tags.map((tag) => ({
        icon: resourceIcon(tag.slug),
        label: titleCase(tag.name),
        items: operations
          .filter((operation) => operation.tag === tag.name)
          .map((operation) => operation.route),
      })),
    ],
  };
}

function resourceIcon(slug: string): (typeof RESOURCE_ICONS)[keyof typeof RESOURCE_ICONS] {
  return RESOURCE_ICONS[slug as keyof typeof RESOURCE_ICONS] ?? 'braces';
}

function titleCase(value: string): string {
  return value.replace(
    /(^|[\s_-])([a-z])/gu,
    (_, separator: string, letter: string) =>
      `${separator === '-' || separator === '_' ? ' ' : separator}${letter.toUpperCase()}`
  );
}
