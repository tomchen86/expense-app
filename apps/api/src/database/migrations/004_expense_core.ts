import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExpenseCore0041738364606487 implements MigrationInterface {
  name = 'ExpenseCore0041738364606487';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "categories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "couple_id" uuid NOT NULL,
        "name" citext NOT NULL,
        "color" character varying(7) NOT NULL,
        "icon" character varying,
        "is_default" boolean NOT NULL DEFAULT false,
        "created_by" uuid,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_categories_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_categories_color" CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
        CONSTRAINT "UQ_categories_couple_name" UNIQUE ("couple_id", "name"),
        CONSTRAINT "FK_categories_couple" FOREIGN KEY ("couple_id") REFERENCES "couples"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_categories_creator" FOREIGN KEY ("created_by") REFERENCES "users"("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "expenses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "couple_id" uuid NOT NULL,
        "group_id" uuid,
        "category_id" uuid,
        "created_by" uuid NOT NULL,
        "paid_by_participant_id" uuid,
        "description" character varying(200) NOT NULL,
        "amount_cents" bigint NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'USD',
        "exchange_rate" numeric(12,6),
        "expense_date" date NOT NULL,
        "split_type" character varying(20) NOT NULL DEFAULT 'equal',
        "notes" text,
        "receipt_url" character varying,
        "location" character varying(200),
        "deleted_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_expenses_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_expenses_amount_positive" CHECK (amount_cents > 0),
        CONSTRAINT "CHK_expenses_currency" CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT "CHK_expenses_split_type" CHECK (split_type IN ('equal','custom','percentage')),
        CONSTRAINT "FK_expenses_couple" FOREIGN KEY ("couple_id") REFERENCES "couples"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_expenses_group" FOREIGN KEY ("group_id") REFERENCES "expense_groups"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_expenses_category" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_expenses_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id"),
        CONSTRAINT "FK_expenses_paid_by_participant" FOREIGN KEY ("paid_by_participant_id") REFERENCES "participants"("id") ON DELETE SET NULL
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "expense_splits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "expense_id" uuid NOT NULL,
        "participant_id" uuid NOT NULL,
        "share_cents" bigint NOT NULL,
        "share_percent" numeric(5,2),
        "settled_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_expense_splits_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_expense_splits_share_cents" CHECK (share_cents >= 0),
        CONSTRAINT "CHK_expense_splits_share_percent" CHECK (share_percent IS NULL OR (share_percent >= 0 AND share_percent <= 100)),
        CONSTRAINT "UQ_expense_splits_expense_participant" UNIQUE ("expense_id", "participant_id"),
        CONSTRAINT "FK_expense_splits_expense" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_expense_splits_participant" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "expense_attachments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "expense_id" uuid NOT NULL,
        "storage_path" character varying NOT NULL,
        "file_type" character varying(20),
        "file_size_bytes" integer,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_expense_attachments_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_expense_attachments_expense" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "expense_attachments";');
    await queryRunner.query('DROP TABLE IF EXISTS "expense_splits";');
    await queryRunner.query('DROP TABLE IF EXISTS "expenses";');
    await queryRunner.query('DROP TABLE IF EXISTS "categories";');
  }
}
