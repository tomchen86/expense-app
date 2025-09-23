import { DataSource } from 'typeorm';

const REQUIRED_EXTENSIONS = ['uuid-ossp', 'citext'] as const;

export const ensureRequiredExtensions = async (
  dataSource: DataSource,
): Promise<string[]> => {
  for (const extension of REQUIRED_EXTENSIONS) {
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "${extension}";`);
  }

  const rows = await dataSource.query<Array<{ extname: string }>>(
    "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'citext')",
  );

  return rows.map((row) => row.extname);
};
