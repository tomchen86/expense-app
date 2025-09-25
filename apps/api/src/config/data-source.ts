import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { getDatabaseConfig } from './database.config';

const config = getDatabaseConfig();

export const AppDataSource = new DataSource({
  ...config,
});

export default AppDataSource;
