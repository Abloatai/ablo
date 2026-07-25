import { InstanceCache } from '../InstanceCache.js';
import { Model } from '../Model.js';
import { ModelRegistry } from '../ModelRegistry.js';
import { LoadStrategy } from '@abloatai/transaction/types';

class CacheRow extends Model {
  title: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.title = typeof data.title === 'string' ? data.title : '';
  }

  override getModelName(): string {
    return 'CacheRow';
  }
}

describe('InstanceCache bounded batch eviction', () => {
  it('retains a recently accessed row and evicts the oldest batch candidates', () => {
    const registry = new ModelRegistry({ validateOnRegister: false });
    registry.registerModel('CacheRow', CacheRow, {
      loadStrategy: LoadStrategy.instant,
    });
    const pool = new InstanceCache({ maxSize: 3, useWeakRefs: false }, registry);
    let clock = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => ++clock);
    const row = (id: string) => new CacheRow({ id, title: id });

    try {
      pool.addBatch([row('a'), row('b'), row('c')]);
      expect(pool.get('a')?.id).toBe('a');

      pool.addBatch([row('d'), row('e')]);

      expect(pool.has('a')).toBe(true);
      expect(pool.has('b')).toBe(false);
      expect(pool.has('c')).toBe(false);
      expect(pool.has('d')).toBe(true);
      expect(pool.has('e')).toBe(true);
    } finally {
      now.mockRestore();
      pool.stopGC();
    }
  });
});
