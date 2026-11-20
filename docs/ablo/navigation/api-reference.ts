import { readFileSync } from 'node:fs';
import { extractOperations, type ApiDocument } from 'blume/openapi/model';
import type { SidebarItemConfig } from 'blume/schema';

const API_REFERENCE_ROUTE = '/api-reference';

/** Keep the plain API sidebar complete as the OpenAPI document changes. */
export function apiReferenceSidebar(specUrl: URL): SidebarItemConfig {
  const document = JSON.parse(readFileSync(specUrl, 'utf8')) as ApiDocument;
  const { operations, tags, warnings } = extractOperations(document, API_REFERENCE_ROUTE);
  if (warnings.length > 0) {
    throw new Error(`OpenAPI navigation is incomplete:\n${warnings.join('\n')}`);
  }
  return {
    label: 'API Reference',
    root: API_REFERENCE_ROUTE,
    items: [API_REFERENCE_ROUTE, ...tags.map(tag => ({
      label: tag.name.charAt(0).toUpperCase() + tag.name.slice(1),
      display: 'flat' as const,
      items: operations.filter(operation => operation.tagSlug === tag.slug).map(operation => ({
        root: operation.route,
        label: operation.summary || operation.path,
      })),
    }))],
  };
}
