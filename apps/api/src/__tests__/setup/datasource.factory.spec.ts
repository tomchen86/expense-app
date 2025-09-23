import { DataSource } from 'typeorm';
import {
  createSqliteDataSource,
  createPostgresDataSource,
} from './datasource.factory';
import { SqljsConnectionOptions } from 'typeorm/driver/sqljs/SqljsConnectionOptions';

jest.setTimeout(30000);

describe('datasource.factory', () => {
  it('produces an in-memory sqlite datasource configured for synchronize()', async () => {
    const dataSource = await createSqliteDataSource();

    expect(dataSource).toBeInstanceOf(DataSource);
    expect(dataSource.options.type).toBe('sqljs');
    const sqljsOptions = dataSource.options as SqljsConnectionOptions;
    expect(sqljsOptions.location).toBe(':memory:');
    expect(dataSource.options.synchronize).toBe(true);

    await expect(dataSource.initialize()).resolves.toBeDefined();
    await dataSource.destroy();
  });

  it('provisions a postgres datasource and ensures required extensions are present', async () => {
    const dataSource = await createPostgresDataSource();

    expect(dataSource).toBeInstanceOf(DataSource);
    await expect(
      dataSource.query(
        "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'citext')",
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ extname: 'uuid-ossp' }),
        expect.objectContaining({ extname: 'citext' }),
      ]),
    );

    await dataSource.destroy();
  });
});
