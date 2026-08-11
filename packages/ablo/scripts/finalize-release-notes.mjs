#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: finalize-release-notes.mjs <version>');
  process.exit(2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(scriptDir, '../..');
const packageNames = ['ablo', 'transaction', 'humans', 'agent', 'cli'];

function parseChangelog(source, file) {
  const matches = [...source.matchAll(/^## (.+)$/gm)];
  if (matches.length === 0) {
    throw new Error(`${file}: no release sections found`);
  }

  const prefix = source.slice(0, matches[0].index).trimEnd();
  const sections = matches.map((match, index) => {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? source.length;
    return {
      title: match[1],
      body: source.slice(bodyStart, bodyEnd).trim(),
    };
  });

  return { prefix, sections };
}

function renderChangelog(prefix, sections) {
  return `${[
    prefix,
    ...sections.map(
      (section) => `## ${section.title}\n\n${section.body}`.trimEnd(),
    ),
  ].join('\n\n')}\n`;
}

/** Changesets writes maintainer provenance into package changelogs. Keep useful
 * package-local notes, but remove commit IDs and lockstep dependency sections:
 * neither belongs in customer-facing prose. */
function cleanGeneratedBody(body) {
  const withoutIds = body
    .replace(/^(\s*-\s+)[0-9a-f]{7,40}:\s+/gm, '$1')
    .replace(/^(\s*- Updated dependencies) \[[0-9a-f, ]+\]$/gm, '$1');
  const matches = [...withoutIds.matchAll(/^### (.+)$/gm)];
  if (matches.length === 0) return withoutIds.trim();

  const prefix = withoutIds.slice(0, matches[0].index).trim();
  const sections = matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? withoutIds.length;
    return { title: match[1], body: withoutIds.slice(start, end).trim() };
  });
  const useful = sections.filter((section) => {
    if (section.title !== 'Patch Changes') return true;
    const lines = section.body.split('\n').filter((line) => line.trim());
    return !(
      lines.length > 0 &&
      lines.every((line) =>
        /^- Updated dependencies$/.test(line) || /^\s+- @[^\s]+@\S+$/.test(line),
      )
    );
  });
  return [
    prefix,
    ...useful.map((section) => `### ${section.title}\n\n${section.body}`),
  ].filter(Boolean).join('\n\n').trim();
}

for (const packageName of packageNames) {
  const file = resolve(packagesDir, packageName, 'CHANGELOG.md');
  const source = readFileSync(file, 'utf8');
  const { prefix, sections } = parseChangelog(source, file);
  // The heading carries an optional trailing label, as in
  // `## Unreleased — coordination core`. Comparing the title for exact equality
  // with 'Unreleased' skipped those, and because a missing section is a normal
  // release rather than an error, the skip was silent: the hand-written note
  // stayed in the file and Changesets' generated body shipped in its place.
  // Absence still means "no hand-written note for this release" and is fine;
  // two of them is not, because only the first would be consumed and the other
  // would publish as its own changelog entry.
  const candidates = sections.filter((section) =>
    /^Unreleased\b/.test(section.title),
  );
  if (candidates.length > 1) {
    throw new Error(
      `${file}: found ${candidates.length} Unreleased sections ` +
        `(${candidates.map((section) => `"${section.title}"`).join(', ')}); ` +
        'keep exactly one so the release body is unambiguous',
    );
  }
  const unreleased = candidates[0];

  const release = sections.find((section) => section.title === version);
  if (!release) {
    throw new Error(`${file}: Changesets did not create a ${version} section`);
  }

  if (!unreleased) {
    if (packageName === 'ablo') {
      throw new Error(
        `${file}: missing an Unreleased section for ${version}; ` +
          'write the public release note before prepare so Changesets metadata ' +
          'cannot become customer-facing prose',
      );
    }
    release.body = cleanGeneratedBody(release.body);
    writeFileSync(file, renderChangelog(prefix, sections));
    continue;
  }
  if (!unreleased.body) {
    throw new Error(`${file}: Unreleased section is empty`);
  }

  release.body = unreleased.body;
  const finalized = sections.filter((section) => section !== unreleased);
  writeFileSync(file, renderChangelog(prefix, finalized));
  console.log(`finalized ${packageName} release notes for ${version}`);
}
