import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnableExtensions0011738364606484 implements MigrationInterface {
  name = 'EnableExtensions0011738364606484';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS citext;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP EXTENSION IF EXISTS citext;');
    await queryRunner.query('DROP EXTENSION IF EXISTS "uuid-ossp";');
  }
}
