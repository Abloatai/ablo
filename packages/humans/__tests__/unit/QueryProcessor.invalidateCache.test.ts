/** `invalidateCache(modelType)` drops one model type's cached results by name. */

import { QueryProcessor } from '../../src/local/query/QueryProcessor';

describe('QueryProcessor.invalidateCache', () => {
  it('drops only the named model type, including names with regex characters', () => {
    const processor = new QueryProcessor();
    processor.processQuery([], 'task-list.v2');
    processor.processQuery([], 'Document');
    expect(processor.getCacheStats().size).toBe(2);

    processor.invalidateCache('task-list.v2');
    expect(processor.getCacheStats().size).toBe(1);

    processor.invalidateCache();
    expect(processor.getCacheStats().size).toBe(0);
  });
});
