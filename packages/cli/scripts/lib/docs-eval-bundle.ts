import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  setupAgentBundleSchema,
  type SetupAdaptationTask,
  type SetupAgentBundle,
} from '../../src/setup/contracts';

export interface DocsEvalPage {
  readonly path: string;
  readonly name?: string;
}

/** Public Markdown inventory available to an agent that must discover its route. */
export function discoverPublicDocsEvalPages(root: string): DocsEvalPage[] {
  const pages: DocsEvalPage[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'internal') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        pages.push({ path, name: relative(root, path) });
      }
    }
  };
  visit(root);
  return pages.sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path));
}

/** Build the normal setup bundle plus the exact documentation pages under test. */
export function buildDocsEvalBundle(input: {
  readonly record: SetupAdaptationTask;
  readonly pages: readonly DocsEvalPage[];
  readonly now?: () => Date;
}): SetupAgentBundle {
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const entrypoint = `# Documentation implementation evaluation

Implement the supplied task in the disposable application. Use only repository
evidence, compiler feedback, and the public documentation files under
\`references/\` for Ablo API knowledge. Inspect before editing, preserve existing
application boundaries, make the smallest complete change, and run the available
checks. Do not assume undocumented Ablo behavior.`;
  const files = input.pages.map((page) => {
    const content = readFileSync(page.path, 'utf8');
    const name = page.name ?? basename(page.path);
    return {
      path: `references/${name}`,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  return setupAgentBundleSchema.parse({
    schemaVersion: input.record.schemaVersion,
    kind: 'ablo_setup_agent_bundle',
    createdAt,
    record: input.record,
    skill: {
      schemaVersion: input.record.schemaVersion,
      kind: 'ablo_setup_skill',
      id: 'integrate-ablo',
      version: 'docs-eval-v1',
      entrypoint: 'SKILL.md',
      files: [{
        path: 'SKILL.md',
        content: entrypoint,
        sha256: createHash('sha256').update(entrypoint).digest('hex'),
      }, ...files],
    },
  });
}
