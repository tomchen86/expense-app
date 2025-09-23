import { DataSource } from 'typeorm';

/**
 * Inserts default user_settings rows for any users missing a settings record.
 * Returns the number of rows inserted during the invocation.
 */
export const seedDefaultUserSettings = async (
  dataSource: DataSource,
): Promise<number> => {
  const result = await dataSource.query<{ count: string }[]>(
    `WITH inserted AS (
       INSERT INTO user_settings (user_id)
       SELECT u.id
       FROM users u
       WHERE NOT EXISTS (
         SELECT 1 FROM user_settings us WHERE us.user_id = u.id
       )
       RETURNING user_id
     )
     SELECT COUNT(*)::text AS count FROM inserted;`,
  );

  const insertedCount = result[0]?.count ?? '0';
  return Number.parseInt(insertedCount, 10);
};
