import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import path from 'node:path';
import { getEntityCollection } from '../entities/entity-sets';

type SupportedDriver = 'postgres' | 'sqlite' | 'sqljs';

export const resolveDriver = (): SupportedDriver => {
  const explicit = process.env.DB_DRIVER?.toLowerCase();
  if (explicit === 'sqlite' || explicit === 'sqljs') {
    return explicit;
  }
  if (explicit === 'postgres') {
    return 'postgres';
  }
  if (process.env.NODE_ENV === 'test') {
    return 'sqljs';
  }
  return 'postgres';
};

export const getDatabaseConfig = (): TypeOrmModuleOptions => {
  const driver = resolveDriver();
  const logging = process.env.NODE_ENV === 'development';

  const entities = getEntityCollection(driver);
  if (driver === 'postgres') {
    return {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'dev_user',
      password: process.env.DB_PASSWORD || 'dev_password',
      database: process.env.DB_DATABASE || 'expense_tracker_dev',
      entities: Object.values(entities),
      migrations: [
        path.join(__dirname, '..', 'database', 'migrations', '*{.ts,.js}'),
      ],
      synchronize: false, // Always use migrations in production
      migrationsRun: true,
      logging,
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
    } satisfies TypeOrmModuleOptions;
  }

  const synchronize =
    process.env.TYPEORM_SYNCHRONIZE === 'true' ||
    process.env.NODE_ENV !== 'production';

  if (driver === 'sqlite') {
    return {
      type: 'sqlite',
      database:
        process.env.SQLITE_DB_PATH ||
        path.join(process.cwd(), 'var', 'dev.sqlite'),
      entities: Object.values(entities),
      migrations: [],
      migrationsRun: false,
      synchronize,
      logging,
    } satisfies TypeOrmModuleOptions;
  }

  return {
    type: 'sqljs',
    entities: Object.values(entities),
    migrations: [],
    migrationsRun: false,
    synchronize: true,
    logging: false,
    autoSave: (process.env.SQLJS_AUTO_SAVE || 'false') === 'true',
    location: process.env.SQLJS_FILE_LOCATION,
  } satisfies TypeOrmModuleOptions;
};
