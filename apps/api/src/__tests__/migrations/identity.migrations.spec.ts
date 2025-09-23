import { DataSource } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';

jest.setTimeout(45000);

describe('Identity migrations', () => {
  let dataSource: DataSource | undefined;

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.dropDatabase();
      await dataSource.destroy();
    }
  });

  it('applies migrations sequentially on a clean database', async () => {
    dataSource = await createPostgresDataSource({ runMigrations: false });
    await dataSource.dropDatabase();

    const migrations = await dataSource.runMigrations({ transaction: 'all' });

    expect(migrations.map((migration) => migration.name)).toEqual([
      'EnableExtensions0011738364606484',
      'IdentityTables0021738364606485',
    ]);

    const tables = await dataSource.query<Array<{
      table_name: string;
    }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );

    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['users', 'user_settings', 'user_auth_identities', 'user_devices']),
    );
  });

  it('rolls back cleanly by undoing each migration in reverse order', async () => {
    dataSource = await createPostgresDataSource({ runMigrations: false });
    await dataSource.dropDatabase();
    await dataSource.runMigrations({ transaction: 'all' });

    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<Array<{
      table_name: string;
    }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name IN ('users','user_settings','user_auth_identities','user_devices')",
    );

    expect(tables).toHaveLength(0);
  });
});
