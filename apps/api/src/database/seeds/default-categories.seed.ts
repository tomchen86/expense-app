import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';

export type DefaultCategory = {
  name: string;
  color: string;
  icon?: string | null;
};

const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'Food & Dining', color: '#FF6384', icon: 'restaurant' },
  { name: 'Transportation', color: '#36A2EB', icon: 'directions-car' },
  { name: 'Shopping', color: '#FFCE56', icon: 'shopping-cart' },
  { name: 'Entertainment', color: '#4BC0C0', icon: 'movie' },
  { name: 'Bills & Utilities', color: '#9966FF', icon: 'receipt' },
  { name: 'Health', color: '#FF9F40', icon: 'local-hospital' },
  { name: 'Travel', color: '#C9CBCF', icon: 'flight' },
  { name: 'Other', color: '#61C0BF', icon: 'category' },
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
          ON CONFLICT (couple_id, name) WHERE deleted_at IS NULL DO NOTHING;
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
