import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { User } from '../../entities/user.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { UserAuthIdentity } from '../../entities/user-auth-identity.entity';
import { UserDevice } from '../../entities/user-device.entity';
import { UserSimple } from '../../entities/user-simple.entity';
import { UserSettingsSimple } from '../../entities/user-settings-simple.entity';
import { UserAuthIdentitySimple } from '../../entities/user-auth-identity-simple.entity';
import { UserDeviceSimple } from '../../entities/user-device-simple.entity';

import { ensureTestPostgresUri } from './postgres-test-container';
import { EnableExtensions0011738364606484 } from '../../database/migrations/001_enable_extensions';
import { IdentityTables0021738364606485 } from '../../database/migrations/002_identity_tables';

type CreatePostgresOptions = {
  runMigrations?: boolean;
};

export const createSqliteDataSource = async (): Promise<DataSource> =>
  new DataSource({
    type: 'sqljs',
    location: ':memory:',
    autoSave: false,
    entities: [
      UserSimple,
      UserSettingsSimple,
      UserAuthIdentitySimple,
      UserDeviceSimple,
    ],
    synchronize: true,
    logging: false,
  });

const isConnectionAvailable = async (connectionString: string): Promise<boolean> => {
  const client = new Client({ connectionString, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch (error) {
    await client.end().catch(() => undefined);
    return false;
  }
};

export const createPostgresDataSource = async (
  options: CreatePostgresOptions = {},
): Promise<DataSource> => {
  const { runMigrations = true } = options;

  const candidateUrls = [
    process.env.TEST_DATABASE_URL,
    process.env.COMPOSE_TEST_DATABASE_URL,
    'postgres://dev_user:dev_password@127.0.0.1:5432/expense_tracker_dev',
  ].filter((value): value is string => Boolean(value));

  let connectionString: string | undefined;

  for (const candidate of candidateUrls) {
    if (await isConnectionAvailable(candidate)) {
      connectionString = candidate;
      break;
    }
  }

  if (!connectionString) {
    connectionString = await ensureTestPostgresUri();
  }

  process.env.TEST_DATABASE_URL = connectionString;

  const dataSource = new DataSource({
    type: 'postgres',
    url: connectionString,
    entities: [User, UserSettings, UserAuthIdentity, UserDevice],
    synchronize: false,
    migrationsRun: false,
    migrations: [
      EnableExtensions0011738364606484,
      IdentityTables0021738364606485,
    ],
    logging: false,
  });

  await dataSource.initialize();
  if (runMigrations) {
    await dataSource.runMigrations({ transaction: 'all' });
  }

  return dataSource;
};
