import { MigrationInterface, QueryRunner } from 'typeorm';

export class CollaborationTables0031738364606486 implements MigrationInterface {
  name = 'CollaborationTables0031738364606486';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "couples" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(100),
        "invite_code" character varying(10) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "created_by" uuid NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_couples_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_couples_invite_code" UNIQUE ("invite_code"),
        CONSTRAINT "CHK_couples_status" CHECK (status IN ('active','pending','archived')),
        CONSTRAINT "FK_couples_created_by_user" FOREIGN KEY ("created_by") REFERENCES "users"("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "couple_members" (
        "couple_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" character varying(20) NOT NULL DEFAULT 'member',
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_couple_members" PRIMARY KEY ("couple_id", "user_id"),
        CONSTRAINT "CHK_couple_members_role" CHECK (role IN ('owner','member')),
        CONSTRAINT "CHK_couple_members_status" CHECK (status IN ('active','invited','removed')),
        CONSTRAINT "FK_couple_members_couple" FOREIGN KEY ("couple_id") REFERENCES "couples"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_couple_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "couple_invitations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "couple_id" uuid NOT NULL,
        "inviter_id" uuid NOT NULL,
        "invited_user_id" uuid,
        "invited_email" citext NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "message" text,
        "expires_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_couple_invitations_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_couple_invitations_status" CHECK (status IN ('pending','accepted','declined','expired')),
        CONSTRAINT "FK_couple_invitations_couple" FOREIGN KEY ("couple_id") REFERENCES "couples"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_couple_invitations_inviter" FOREIGN KEY ("inviter_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_couple_invitations_invited_user" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "participants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "couple_id" uuid NOT NULL,
        "user_id" uuid,
        "display_name" character varying(100) NOT NULL,
        "email" citext,
        "is_registered" boolean NOT NULL DEFAULT false,
        "default_currency" character varying(3) NOT NULL DEFAULT 'USD',
        "notification_preferences" jsonb NOT NULL DEFAULT '{"expenses":true,"invites":true,"reminders":true}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_participants_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_participants_couple_user" UNIQUE ("couple_id", "user_id"),
        CONSTRAINT "CHK_participants_currency" CHECK (default_currency ~ '^[A-Z]{3}$'),
        CONSTRAINT "CHK_participants_registered_user" CHECK (user_id IS NOT NULL OR is_registered = false),
        CONSTRAINT "FK_participants_couple" FOREIGN KEY ("couple_id") REFERENCES "couples"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_participants_user" FOREIGN KEY ("user_id") REFERENCES "users"("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "expense_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "couple_id" uuid NOT NULL,
        "name" character varying(100) NOT NULL,
        "description" text,
        "color" character varying(7),
        "default_currency" character varying(3),
        "is_archived" boolean NOT NULL DEFAULT false,
        "created_by" uuid NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_expense_groups_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_expense_groups_color" CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
        CONSTRAINT "CHK_expense_groups_currency" CHECK (default_currency IS NULL OR default_currency ~ '^[A-Z]{3}$'),
        CONSTRAINT "FK_expense_groups_couple" FOREIGN KEY ("couple_id") REFERENCES "couples"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_expense_groups_creator" FOREIGN KEY ("created_by") REFERENCES "users"("id")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "group_members" (
        "group_id" uuid NOT NULL,
        "participant_id" uuid NOT NULL,
        "role" character varying(20) NOT NULL DEFAULT 'member',
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_group_members" PRIMARY KEY ("group_id", "participant_id"),
        CONSTRAINT "CHK_group_members_role" CHECK (role IN ('owner','member')),
        CONSTRAINT "CHK_group_members_status" CHECK (status IN ('active','invited','left')),
        CONSTRAINT "FK_group_members_group" FOREIGN KEY ("group_id") REFERENCES "expense_groups"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_group_members_participant" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "group_members";');
    await queryRunner.query('DROP TABLE IF EXISTS "expense_groups";');
    await queryRunner.query('DROP TABLE IF EXISTS "participants";');
    await queryRunner.query('DROP TABLE IF EXISTS "couple_invitations";');
    await queryRunner.query('DROP TABLE IF EXISTS "couple_members";');
    await queryRunner.query('DROP TABLE IF EXISTS "couples";');
  }
}
