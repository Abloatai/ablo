import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { docs } from '../docs';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('installed documentation', () => {
  it('resolves the SDK package rather than a docs-less transaction dependency', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await docs(['branch-development']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('# Branch-first development'));
  });
});
