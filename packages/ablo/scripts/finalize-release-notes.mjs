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

  if (!unreleased) continue;
  if (!unreleased.body) {
    throw new Error(`${file}: Unreleased section is empty`);
  }

  const release = sections.find((section) => section.title === version);
  if (!release) {
    throw new Error(`${file}: Changesets did not create a ${version} section`);
  }

  release.body = unreleased.body;
  const finalized = sections.filter((section) => section !== unreleased);
  const rendered = [
    prefix,
    ...finalized.map(
      (section) => `## ${section.title}\n\n${section.body}`.trimEnd(),
    ),
  ].join('\n\n');

  writeFileSync(file, `${rendered}\n`);
  console.log(`finalized ${packageName} release notes for ${version}`);
}
