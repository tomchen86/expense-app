import { MigrationInterface, QueryRunner } from 'typeorm';

export class SoftDeleteParticipants0071738364606490
  implements MigrationInterface
{
  name = 'SoftDeleteParticipants0071738364606490';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE participants ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_participants_deleted_at ON participants(couple_id) WHERE deleted_at IS NULL;',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_participants_deleted_at;',
    );
    await queryRunner.query(
      'ALTER TABLE participants DROP COLUMN IF EXISTS deleted_at;',
    );
  }
}
