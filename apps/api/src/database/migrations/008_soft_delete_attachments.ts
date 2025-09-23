import { MigrationInterface, QueryRunner } from 'typeorm';

export class SoftDeleteAttachments0081738364606491
  implements MigrationInterface
{
  name = 'SoftDeleteAttachments0081738364606491';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expense_attachments_deleted_at ON expense_attachments(expense_id) WHERE deleted_at IS NULL;',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_expense_attachments_deleted_at;',
    );
    await queryRunner.query(
      'ALTER TABLE expense_attachments DROP COLUMN IF EXISTS deleted_at;',
    );
  }
}
