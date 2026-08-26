import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('published CLI metadata', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as {
    name?: string;
    homepage?: string;
    bin?: Record<string, string>;
  };

  it('resolves the official package and binary back to the Ablo product domain', () => {
    expect(manifest.name).toBe('@abloatai/cli');
    expect(manifest.bin).toEqual({ ablo: './dist/cli.cjs' });
    expect(manifest.homepage).toBe('https://docs.abloatai.com/cli');
  });
});
