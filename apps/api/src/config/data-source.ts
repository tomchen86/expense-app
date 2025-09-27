import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { getDatabaseConfig } from './database.config';

const config = getDatabaseConfig();

// getDatabaseConfig returns Nest's TypeOrmModuleOptions (a union by driver).
// For CLI usage here, normalize to TypeORM's DataSourceOptions.
export const AppDataSource = new DataSource(
  config as unknown as DataSourceOptions,
);

export default AppDataSource;
