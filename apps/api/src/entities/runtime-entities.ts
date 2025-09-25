import { resolveDriver } from '../config/database.config';
import { getEntityCollection } from './entity-sets';
import type { EntityCollection } from './entity-sets';

type EntityKeys = keyof EntityCollection;

export const Entities = new Proxy({} as EntityCollection, {
  get: (_target, prop: string) => {
    const collection = getEntityCollection(resolveDriver());
    if (prop in collection) {
      return collection[prop as EntityKeys];
    }
    return undefined;
  },
});
