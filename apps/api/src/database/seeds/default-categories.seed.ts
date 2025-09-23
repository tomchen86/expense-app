import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';

export type DefaultCategory = {
  name: string;
  color: string;
  icon?: string | null;
};

const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'Food & Dining', color: '#FF5722' },
  { name: 'Transportation', color: '#2196F3' },
  { name: 'Shopping', color: '#9C27B0' },
  { name: 'Entertainment', color: '#FF9800' },
  { name: 'Bills & Utilities', color: '#F44336' },
  { name: 'Healthcare', color: '#4CAF50' },
  { name: 'Travel', color: '#00BCD4' },
  { name: 'Other', color: '#607D8B' },
];

export type SeedDefaultCategoriesOptions = {
  coupleId: string;
  createdBy?: string;
  categories?: DefaultCategory[];
};

export const seedDefaultCategories = async (
  dataSource: DataSource,
  options: SeedDefaultCategoriesOptions,
): Promise<void> => {
  const { coupleId, createdBy, categories = DEFAULT_CATEGORIES } = options;
  if (!coupleId) {
    throw new Error('seedDefaultCategories requires a coupleId');
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    for (const category of categories) {
      await queryRunner.query(
        `
          INSERT INTO categories (id, couple_id, name, color, icon, is_default, created_by, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, true, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (couple_id, name) DO NOTHING;
        `,
        [
          randomUUID(),
          coupleId,
          category.name,
          category.color,
          category.icon ?? null,
          createdBy ?? null,
        ],
      );
    }

    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
};

export const defaultCategories = DEFAULT_CATEGORIES;
