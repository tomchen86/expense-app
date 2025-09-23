import { MigrationInterface, QueryRunner } from 'typeorm';

export class IdentityTables0021738364606485 implements MigrationInterface {
  name = 'IdentityTables0021738364606485';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" citext NOT NULL,
        "password_hash" character varying NOT NULL,
        "display_name" character varying(100) NOT NULL,
        "avatar_url" character varying,
        "default_currency" character varying(3) NOT NULL DEFAULT 'USD',
        "timezone" character varying(50) NOT NULL DEFAULT 'UTC',
        "onboarding_status" character varying(20) NOT NULL DEFAULT 'invited',
        "email_verified_at" TIMESTAMPTZ,
        "last_active_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CHK_users_default_currency" CHECK (default_currency ~ '^[A-Z]{3}$'),
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "user_settings" (
        "user_id" uuid NOT NULL,
        "language" character varying(8) NOT NULL DEFAULT 'en-US',
        "notifications" jsonb NOT NULL DEFAULT '{"expenses":true,"invites":true,"reminders":true}'::jsonb,
        "push_enabled" boolean NOT NULL DEFAULT true,
        "persistence_mode" character varying(20) NOT NULL DEFAULT 'local_only',
        "last_persistence_change" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_user_settings_user_id" PRIMARY KEY ("user_id"),
        CONSTRAINT "CHK_user_settings_persistence_mode" CHECK (persistence_mode IN ('local_only','cloud_sync')),
        CONSTRAINT "FK_user_settings_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "user_auth_identities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "provider" character varying(32) NOT NULL,
        "provider_account_id" character varying(128) NOT NULL,
        "access_token" text,
        "refresh_token" text,
        "metadata" jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_user_auth_identities_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_auth_identities_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_user_auth_provider_account" UNIQUE ("provider", "provider_account_id"),
        CONSTRAINT "UQ_user_auth_user_provider" UNIQUE ("user_id", "provider")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "user_devices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "device_uuid" character varying(128) NOT NULL,
        "device_name" character varying(100),
        "platform" character varying(20),
        "app_version" character varying(20),
        "last_sync_at" TIMESTAMPTZ,
        "last_snapshot_hash" character varying(64),
        "persistence_mode_at_sync" character varying(20) NOT NULL DEFAULT 'local_only',
        "sync_status" character varying(20) NOT NULL DEFAULT 'idle',
        "last_error" text,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_user_devices_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_devices_user_device_uuid" UNIQUE ("user_id", "device_uuid"),
        CONSTRAINT "CHK_user_devices_persistence_mode" CHECK (persistence_mode_at_sync IN ('local_only','cloud_sync')),
        CONSTRAINT "CHK_user_devices_sync_status" CHECK (sync_status IN ('idle','syncing','error')),
        CONSTRAINT "FK_user_devices_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "user_devices";');
    await queryRunner.query('DROP TABLE IF EXISTS "user_auth_identities";');
    await queryRunner.query('DROP TABLE IF EXISTS "user_settings";');
    await queryRunner.query('DROP TABLE IF EXISTS "users";');
  }
}
