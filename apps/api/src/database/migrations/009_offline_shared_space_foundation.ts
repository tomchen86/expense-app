import { MigrationInterface, QueryRunner } from 'typeorm';

export class OfflineSharedSpaceFoundation0091738364606492 implements MigrationInterface {
  name = 'OfflineSharedSpaceFoundation0091738364606492';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "couples"
      ADD COLUMN "kind" character varying(20);
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "space_kind_migration_overrides" (
        "couple_id" uuid PRIMARY KEY,
        "kind" character varying(20) NOT NULL
          CHECK (kind IN ('personal','shared'))
      );
    `);
    await queryRunner.query(`
      LOCK TABLE "couple_members", "couple_invitations"
      IN SHARE ROW EXCLUSIVE MODE;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM space_kind_migration_overrides AS override
          LEFT JOIN couples AS c ON c.id = override.couple_id
          WHERE c.id IS NULL
        ) THEN
          RAISE EXCEPTION 'Space kind override references an unknown legacy space';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM couples AS c
          WHERE (
            SELECT COUNT(*)
            FROM couple_members AS cm
            WHERE cm.couple_id = c.id
          ) <= 1
          AND NOT EXISTS (
            SELECT 1
            FROM couple_invitations AS invitation
            WHERE invitation.couple_id = c.id
          )
          AND NOT (
            c.name = 'Personal Ledger'
            AND (
              SELECT COUNT(*)
              FROM couple_members AS cm
              WHERE cm.couple_id = c.id
            ) = 1
            AND EXISTS (
              SELECT 1
              FROM couple_members AS cm
              WHERE cm.couple_id = c.id
                AND cm.user_id = c.created_by
                AND cm.role = 'owner'
                AND cm.status = 'active'
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM space_kind_migration_overrides AS override
            WHERE override.couple_id = c.id
          )
        ) THEN
          RAISE EXCEPTION 'Ambiguous legacy space kind: create and populate space_kind_migration_overrides before retrying';
        END IF;
      END;
      $$;
    `);
    await queryRunner.query(`
      UPDATE "couples" AS c
      SET "kind" = COALESCE(
        (
          SELECT override."kind"
          FROM "space_kind_migration_overrides" AS override
          WHERE override."couple_id" = c."id"
        ),
        CASE
          WHEN c."name" = 'Personal Ledger'
          AND (
            SELECT COUNT(*)
            FROM "couple_members" AS cm
            WHERE cm."couple_id" = c."id"
          ) = 1
          AND EXISTS (
            SELECT 1
            FROM "couple_members" AS cm
            WHERE cm."couple_id" = c."id"
              AND cm."user_id" = c."created_by"
              AND cm."role" = 'owner'
              AND cm."status" = 'active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "couple_invitations" AS invitation
            WHERE invitation."couple_id" = c."id"
          )
          THEN 'personal'
          ELSE 'shared'
        END
      );
    `);
    await queryRunner.query(`
      DROP TABLE "space_kind_migration_overrides";
    `);
    await queryRunner.query(`
      ALTER TABLE "couples"
      ALTER COLUMN "kind" SET DEFAULT 'personal';
    `);
    await queryRunner.query(`
      ALTER TABLE "couples"
      ALTER COLUMN "kind" SET NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "couples"
      ADD CONSTRAINT "CHK_couples_kind"
      CHECK (kind IN ('personal','shared'));
    `);
    await queryRunner.query(`
      ALTER TABLE "couples"
      ADD COLUMN "sync_policy" character varying(20) NOT NULL DEFAULT 'local_only';
    `);
    await queryRunner.query(`
      UPDATE "couples"
      SET "sync_policy" = 'cloud_sync';
    `);
    await queryRunner.query(`
      ALTER TABLE "couples"
      ADD CONSTRAINT "CHK_couples_sync_policy"
      CHECK (sync_policy IN ('local_only','cloud_sync'));
    `);
    await queryRunner.query(`
      ALTER TABLE "couples"
      ADD CONSTRAINT "CHK_couples_shared_cloud_sync"
      CHECK (kind <> 'shared' OR sync_policy = 'cloud_sync');
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT created_by
          FROM couples
          WHERE kind = 'personal' AND status = 'active'
          GROUP BY created_by
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION 'Cannot enforce one active personal space per creator: classify or archive duplicate legacy couples before migration';
        END IF;
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_couples_active_personal_creator"
      ON "couples" ("created_by")
      WHERE kind = 'personal' AND status = 'active';
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD COLUMN "version" integer NOT NULL DEFAULT 1;
    `);
    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD COLUMN "client_mutation_id" character varying(128);
    `);
    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD CONSTRAINT "CHK_expenses_version_positive"
      CHECK (version > 0);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_expenses_couple_client_mutation_id"
      ON "expenses" ("couple_id", "client_mutation_id")
      WHERE client_mutation_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_expenses_couple_updated_id"
      ON "expenses" ("couple_id", "updated_at", "id");
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      DROP CONSTRAINT "CHK_expenses_amount_positive";
    `);
    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD CONSTRAINT "CHK_expenses_amount_positive"
      CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991);
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      DROP CONSTRAINT "CHK_expense_splits_share_cents";
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      ADD CONSTRAINT "CHK_expense_splits_share_cents"
      CHECK (share_cents >= 0 AND share_cents <= 9007199254740991);
    `);

    await queryRunner.query(`
      LOCK TABLE
        "expenses",
        "expense_splits",
        "expense_groups",
        "categories",
        "participants",
        "group_members"
      IN SHARE ROW EXCLUSIVE MODE;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM expenses AS expense
          JOIN expense_groups AS expense_group
            ON expense_group.id = expense.group_id
          WHERE expense_group.couple_id <> expense.couple_id
          UNION ALL
          SELECT 1
          FROM expenses AS expense
          JOIN categories AS category
            ON category.id = expense.category_id
          WHERE category.couple_id <> expense.couple_id
          UNION ALL
          SELECT 1
          FROM expenses AS expense
          JOIN participants AS payer
            ON payer.id = expense.paid_by_participant_id
          WHERE payer.couple_id <> expense.couple_id
        ) THEN
          RAISE EXCEPTION 'Cross-space expense references must be repaired before migration';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM expense_splits AS expense_split
          JOIN expenses AS expense
            ON expense.id = expense_split.expense_id
          JOIN participants AS participant
            ON participant.id = expense_split.participant_id
          WHERE participant.couple_id <> expense.couple_id
        ) THEN
          RAISE EXCEPTION 'Cross-space expense splits must be repaired before migration';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM group_members AS group_member
          JOIN expense_groups AS expense_group
            ON expense_group.id = group_member.group_id
          JOIN participants AS participant
            ON participant.id = group_member.participant_id
          WHERE participant.couple_id <> expense_group.couple_id
        ) THEN
          RAISE EXCEPTION 'Cross-space group members must be repaired before migration';
        END IF;
      END;
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      ADD COLUMN "couple_id" uuid;
    `);
    await queryRunner.query(`
      UPDATE "expense_splits" AS child
      SET "couple_id" = parent."couple_id"
      FROM "expenses" AS parent
      WHERE child."expense_id" = parent."id";
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      ALTER COLUMN "couple_id" SET NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "group_members"
      ADD COLUMN "couple_id" uuid;
    `);
    await queryRunner.query(`
      UPDATE "group_members" AS child
      SET "couple_id" = parent."couple_id"
      FROM "expense_groups" AS parent
      WHERE child."group_id" = parent."id";
    `);
    await queryRunner.query(`
      ALTER TABLE "group_members"
      ALTER COLUMN "couple_id" SET NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD CONSTRAINT "UQ_expenses_id_couple" UNIQUE ("id", "couple_id");
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_groups"
      ADD CONSTRAINT "UQ_expense_groups_id_couple" UNIQUE ("id", "couple_id");
    `);
    await queryRunner.query(`
      ALTER TABLE "categories"
      ADD CONSTRAINT "UQ_categories_id_couple" UNIQUE ("id", "couple_id");
    `);
    await queryRunner.query(`
      ALTER TABLE "participants"
      ADD CONSTRAINT "UQ_participants_id_couple" UNIQUE ("id", "couple_id");
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      DROP CONSTRAINT "FK_expenses_group",
      DROP CONSTRAINT "FK_expenses_category",
      DROP CONSTRAINT "FK_expenses_paid_by_participant";
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      DROP CONSTRAINT "FK_expense_splits_expense",
      DROP CONSTRAINT "FK_expense_splits_participant";
    `);
    await queryRunner.query(`
      ALTER TABLE "group_members"
      DROP CONSTRAINT "FK_group_members_group",
      DROP CONSTRAINT "FK_group_members_participant";
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD CONSTRAINT "FK_expenses_group_couple"
        FOREIGN KEY ("group_id", "couple_id")
        REFERENCES "expense_groups"("id", "couple_id")
        ON DELETE NO ACTION,
      ADD CONSTRAINT "FK_expenses_category_couple"
        FOREIGN KEY ("category_id", "couple_id")
        REFERENCES "categories"("id", "couple_id")
        ON DELETE NO ACTION,
      ADD CONSTRAINT "FK_expenses_payer_couple"
        FOREIGN KEY ("paid_by_participant_id", "couple_id")
        REFERENCES "participants"("id", "couple_id")
        ON DELETE NO ACTION;
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      ADD CONSTRAINT "FK_expense_splits_expense_couple"
        FOREIGN KEY ("expense_id", "couple_id")
        REFERENCES "expenses"("id", "couple_id")
        ON DELETE CASCADE,
      ADD CONSTRAINT "FK_expense_splits_participant_couple"
        FOREIGN KEY ("participant_id", "couple_id")
        REFERENCES "participants"("id", "couple_id")
        ON DELETE CASCADE;
    `);
    await queryRunner.query(`
      ALTER TABLE "group_members"
      ADD CONSTRAINT "FK_group_members_group_couple"
        FOREIGN KEY ("group_id", "couple_id")
        REFERENCES "expense_groups"("id", "couple_id")
        ON DELETE CASCADE,
      ADD CONSTRAINT "FK_group_members_participant_couple"
        FOREIGN KEY ("participant_id", "couple_id")
        REFERENCES "participants"("id", "couple_id")
        ON DELETE CASCADE;
    `);

    await queryRunner.query(`
      ALTER TABLE "categories"
      DROP CONSTRAINT IF EXISTS "UQ_categories_couple_name";
    `);
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_categories_couple_name_unique";',
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_categories_couple_name_active"
      ON "categories" ("couple_id", "name")
      WHERE deleted_at IS NULL;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "categories" AS legacy
          JOIN "categories" AS conflict
            ON conflict."couple_id" = legacy."couple_id"
            AND conflict."id" <> legacy."id"
          WHERE legacy."is_default" = true
            AND legacy."name"::text = 'Healthcare'
            AND legacy."color" = '#4CAF50'
            AND legacy."icon" = 'local-hospital'
            AND legacy."deleted_at" IS NULL
            AND conflict."deleted_at" IS NULL
            AND conflict."name" = 'Health'
        ) THEN
          RAISE EXCEPTION 'Legacy Healthcare default conflicts with an active Health category; map categories manually before retrying migration 009';
        END IF;
      END;
      $$;
    `);
    await queryRunner.query(`
      CREATE TABLE "category_catalog_migration_009" (
        "category_id" uuid PRIMARY KEY,
        "couple_id" uuid NOT NULL,
        "old_name" text NOT NULL,
        "old_color" character varying(7) NOT NULL,
        "old_icon" character varying(64),
        "new_name" text NOT NULL,
        "new_color" character varying(7) NOT NULL,
        "new_icon" character varying(64)
      );
    `);
    await queryRunner.query(`
      INSERT INTO "category_catalog_migration_009" (
        "category_id",
        "couple_id",
        "old_name",
        "old_color",
        "old_icon",
        "new_name",
        "new_color",
        "new_icon"
      )
      SELECT
        category."id",
        category."couple_id",
        mapping."old_name",
        mapping."old_color",
        mapping."old_icon",
        mapping."new_name",
        mapping."new_color",
        mapping."new_icon"
      FROM "categories" AS category
      JOIN (
        VALUES
          ('Food & Dining', '#FF5722', 'restaurant', 'Food & Dining', '#FF6384', 'restaurant'),
          ('Transportation', '#2196F3', 'directions-car', 'Transportation', '#36A2EB', 'directions-car'),
          ('Shopping', '#9C27B0', 'shopping-cart', 'Shopping', '#FFCE56', 'shopping-cart'),
          ('Entertainment', '#FF9800', 'movie', 'Entertainment', '#4BC0C0', 'movie'),
          ('Bills & Utilities', '#F44336', 'receipt', 'Bills & Utilities', '#9966FF', 'receipt'),
          ('Healthcare', '#4CAF50', 'local-hospital', 'Health', '#FF9F40', 'local-hospital'),
          ('Travel', '#00BCD4', 'flight', 'Travel', '#C9CBCF', 'flight'),
          ('Other', '#607D8B', 'category', 'Other', '#61C0BF', 'category')
      ) AS mapping (
        "old_name",
        "old_color",
        "old_icon",
        "new_name",
        "new_color",
        "new_icon"
      )
        ON category."name"::text = mapping."old_name"
        AND category."color" = mapping."old_color"
        AND category."icon" IS NOT DISTINCT FROM mapping."old_icon"
      WHERE category."is_default" = true;
    `);
    await queryRunner.query(`
      UPDATE "categories" AS category
      SET
        "name" = tracked."new_name",
        "color" = tracked."new_color",
        "icon" = tracked."new_icon"
      FROM "category_catalog_migration_009" AS tracked
      WHERE category."id" = tracked."category_id";
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_participants_couple_email_active"
      ON "participants" ("couple_id", "email")
      WHERE email IS NOT NULL AND deleted_at IS NULL;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_split_balance()
      RETURNS TRIGGER AS $$
      DECLARE
        affected_expense_id uuid;
        total_shares BIGINT;
        expense_total BIGINT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          affected_expense_id := OLD.expense_id;
        ELSE
          affected_expense_id := NEW.expense_id;
        END IF;

        SELECT amount_cents
        INTO expense_total
        FROM expenses
        WHERE id = affected_expense_id;

        IF NOT FOUND THEN
          IF TG_OP = 'DELETE' THEN
            RETURN OLD;
          END IF;
          RETURN NEW;
        END IF;

        SELECT COALESCE(SUM(share_cents), 0)
        INTO total_shares
        FROM expense_splits
        WHERE expense_id = affected_expense_id;

        IF total_shares <> expense_total THEN
          RAISE EXCEPTION 'Split total % must equal expense amount %', total_shares, expense_total;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_expense_amount_split_balance()
      RETURNS TRIGGER AS $$
      DECLARE
        total_shares BIGINT;
      BEGIN
        SELECT COALESCE(SUM(share_cents), 0)
        INTO total_shares
        FROM expense_splits
        WHERE expense_id = NEW.id;

        IF total_shares <> NEW.amount_cents THEN
          RAISE EXCEPTION 'Split total % must equal expense amount %', total_shares, NEW.amount_cents;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_expense_amount_split_balance
      AFTER UPDATE OF amount_cents ON expenses
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION assert_expense_amount_split_balance();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      LOCK TABLE "categories"
      IN SHARE ROW EXCLUSIVE MODE;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "category_catalog_migration_009" AS tracked
          LEFT JOIN "categories" AS category
            ON category."id" = tracked."category_id"
          WHERE category."id" IS NULL
            OR category."couple_id" IS DISTINCT FROM tracked."couple_id"
            OR category."is_default" IS DISTINCT FROM true
            OR category."name"::text IS DISTINCT FROM tracked."new_name"
            OR category."color" IS DISTINCT FROM tracked."new_color"
            OR category."icon" IS DISTINCT FROM tracked."new_icon"
        ) THEN
          RAISE EXCEPTION 'Tracked canonical category changed or disappeared; map categories manually before reverting migration 009';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM "category_catalog_migration_009" AS tracked
          JOIN "categories" AS category
            ON category."id" = tracked."category_id"
          JOIN "categories" AS conflict
            ON conflict."couple_id" = tracked."couple_id"
            AND conflict."id" <> tracked."category_id"
            AND LOWER(conflict."name"::text) = LOWER(tracked."old_name")
          WHERE tracked."old_name" = 'Healthcare'
            AND tracked."new_name" = 'Health'
        ) THEN
          RAISE EXCEPTION 'Reverting Health would conflict with an existing Healthcare category; map categories manually before reverting migration 009';
        END IF;
      END;
      $$;
    `);
    await queryRunner.query(`
      UPDATE "categories" AS category
      SET
        "name" = tracked."old_name",
        "color" = tracked."old_color",
        "icon" = tracked."old_icon"
      FROM "category_catalog_migration_009" AS tracked
      WHERE category."id" = tracked."category_id";
    `);
    await queryRunner.query('DROP TABLE "category_catalog_migration_009";');

    await queryRunner.query(
      'DROP TRIGGER IF EXISTS trg_expense_amount_split_balance ON expenses;',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS assert_expense_amount_split_balance();',
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_split_balance()
      RETURNS TRIGGER AS $$
      DECLARE
        affected_expense_id uuid;
        total_shares BIGINT;
        expense_total BIGINT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          affected_expense_id := OLD.expense_id;
        ELSE
          affected_expense_id := NEW.expense_id;
        END IF;

        SELECT COALESCE(SUM(share_cents), 0)
        INTO total_shares
        FROM expense_splits
        WHERE expense_id = affected_expense_id;

        SELECT amount_cents
        INTO expense_total
        FROM expenses
        WHERE id = affected_expense_id;

        IF total_shares <> expense_total THEN
          RAISE EXCEPTION 'Split total % must equal expense amount %', total_shares, expense_total;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      DROP CONSTRAINT IF EXISTS "FK_expenses_group_couple",
      DROP CONSTRAINT IF EXISTS "FK_expenses_category_couple",
      DROP CONSTRAINT IF EXISTS "FK_expenses_payer_couple";
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      DROP CONSTRAINT IF EXISTS "FK_expense_splits_expense_couple",
      DROP CONSTRAINT IF EXISTS "FK_expense_splits_participant_couple";
    `);
    await queryRunner.query(`
      ALTER TABLE "group_members"
      DROP CONSTRAINT IF EXISTS "FK_group_members_group_couple",
      DROP CONSTRAINT IF EXISTS "FK_group_members_participant_couple";
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD CONSTRAINT "FK_expenses_group"
        FOREIGN KEY ("group_id") REFERENCES "expense_groups"("id") ON DELETE SET NULL,
      ADD CONSTRAINT "FK_expenses_category"
        FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL,
      ADD CONSTRAINT "FK_expenses_paid_by_participant"
        FOREIGN KEY ("paid_by_participant_id") REFERENCES "participants"("id") ON DELETE SET NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      ADD CONSTRAINT "FK_expense_splits_expense"
        FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_expense_splits_participant"
        FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE;
    `);
    await queryRunner.query(`
      ALTER TABLE "group_members"
      ADD CONSTRAINT "FK_group_members_group"
        FOREIGN KEY ("group_id") REFERENCES "expense_groups"("id") ON DELETE CASCADE,
      ADD CONSTRAINT "FK_group_members_participant"
        FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE;
    `);

    await queryRunner.query(
      'ALTER TABLE "expense_splits" DROP COLUMN IF EXISTS "couple_id";',
    );
    await queryRunner.query(
      'ALTER TABLE "group_members" DROP COLUMN IF EXISTS "couple_id";',
    );

    await queryRunner.query(`
      ALTER TABLE "expenses"
      DROP CONSTRAINT IF EXISTS "UQ_expenses_id_couple";
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_groups"
      DROP CONSTRAINT IF EXISTS "UQ_expense_groups_id_couple";
    `);
    await queryRunner.query(`
      ALTER TABLE "categories"
      DROP CONSTRAINT IF EXISTS "UQ_categories_id_couple";
    `);
    await queryRunner.query(`
      ALTER TABLE "participants"
      DROP CONSTRAINT IF EXISTS "UQ_participants_id_couple";
    `);

    await queryRunner.query(`
      ALTER TABLE "expenses"
      DROP CONSTRAINT "CHK_expenses_amount_positive";
    `);
    await queryRunner.query(`
      ALTER TABLE "expenses"
      ADD CONSTRAINT "CHK_expenses_amount_positive"
      CHECK (amount_cents > 0);
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      DROP CONSTRAINT "CHK_expense_splits_share_cents";
    `);
    await queryRunner.query(`
      ALTER TABLE "expense_splits"
      ADD CONSTRAINT "CHK_expense_splits_share_cents"
      CHECK (share_cents >= 0);
    `);

    await queryRunner.query(
      'DROP INDEX IF EXISTS "UQ_participants_couple_email_active";',
    );

    await queryRunner.query(
      'DROP INDEX IF EXISTS "UQ_categories_couple_name_active";',
    );
    await queryRunner.query(`
      ALTER TABLE "categories"
      ADD CONSTRAINT "UQ_categories_couple_name"
      UNIQUE ("couple_id", "name");
    `);

    await queryRunner.query(
      'DROP INDEX IF EXISTS "UQ_expenses_couple_client_mutation_id";',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_expenses_couple_updated_id";',
    );
    await queryRunner.query(`
      ALTER TABLE "expenses"
      DROP CONSTRAINT IF EXISTS "CHK_expenses_version_positive";
    `);
    await queryRunner.query(
      'ALTER TABLE "expenses" DROP COLUMN IF EXISTS "client_mutation_id";',
    );
    await queryRunner.query(
      'ALTER TABLE "expenses" DROP COLUMN IF EXISTS "version";',
    );

    await queryRunner.query(
      'DROP INDEX IF EXISTS "UQ_couples_active_personal_creator";',
    );
    await queryRunner.query(`
      ALTER TABLE "couples"
      DROP CONSTRAINT IF EXISTS "CHK_couples_shared_cloud_sync";
    `);
    await queryRunner.query(`
      ALTER TABLE "couples"
      DROP CONSTRAINT IF EXISTS "CHK_couples_sync_policy";
    `);
    await queryRunner.query(
      'ALTER TABLE "couples" DROP COLUMN IF EXISTS "sync_policy";',
    );
    await queryRunner.query(`
      ALTER TABLE "couples"
      DROP CONSTRAINT IF EXISTS "CHK_couples_kind";
    `);
    await queryRunner.query(
      'ALTER TABLE "couples" DROP COLUMN IF EXISTS "kind";',
    );
  }
}
