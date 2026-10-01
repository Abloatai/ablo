/**
 * `invalidateCache(modelType)` drops one model type's cached results by name.
 * It used to take a regex pattern, which the store built from a model name, so
 * a name with regex characters reached `new RegExp` unescaped.
 */

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
