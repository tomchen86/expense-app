import { MigrationInterface, QueryRunner } from 'typeorm';

export class SoftDeleteExtensions0061738364606489
  implements MigrationInterface
{
  name = 'SoftDeleteExtensions0061738364606489';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;',
    );
    await queryRunner.query(
      'ALTER TABLE expense_groups ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_categories_deleted_at ON categories(couple_id) WHERE deleted_at IS NULL;',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expense_groups_deleted_at ON expense_groups(couple_id) WHERE deleted_at IS NULL;',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_expense_groups_deleted_at;',
    );
    await queryRunner.query('DROP INDEX IF EXISTS idx_categories_deleted_at;');

    await queryRunner.query(
      'ALTER TABLE expense_groups DROP COLUMN IF EXISTS deleted_at;',
    );
    await queryRunner.query(
      'ALTER TABLE categories DROP COLUMN IF EXISTS deleted_at;',
    );
  }
}
