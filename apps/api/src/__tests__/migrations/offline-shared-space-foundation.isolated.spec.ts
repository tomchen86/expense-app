import { getMetadataArgsStorage, QueryRunner } from 'typeorm';
import { OfflineSharedSpaceFoundation0091738364606492 } from '../../database/migrations/009_offline_shared_space_foundation';
import { Category } from '../../entities/category.entity';
import { CategorySimple } from '../../entities/category-simple.entity';
import { Couple } from '../../entities/couple.entity';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { Expense } from '../../entities/expense.entity';
import { ExpenseSimple } from '../../entities/expense-simple.entity';
import { ExpenseGroup } from '../../entities/expense-group.entity';
import { ExpenseGroupSimple } from '../../entities/expense-group-simple.entity';
import { ExpenseSplit } from '../../entities/expense-split.entity';
import { ExpenseSplitSimple } from '../../entities/expense-split-simple.entity';
import { GroupMember } from '../../entities/group-member.entity';
import { GroupMemberSimple } from '../../entities/group-member-simple.entity';
import { Participant } from '../../entities/participant.entity';
import { ParticipantSimple } from '../../entities/participant-simple.entity';

const normalizeSql = (statements: string[]): string =>
  statements.join('\n').replace(/\s+/g, ' ').trim();

const captureMigration = async (direction: 'up' | 'down'): Promise<string> => {
  const statements: string[] = [];
  const queryRunner = {
    query: jest.fn((sql: string) => {
      statements.push(sql);
      return Promise.resolve(undefined);
    }),
  } as unknown as QueryRunner;

  const migration = new OfflineSharedSpaceFoundation0091738364606492();
  await migration[direction](queryRunner);
  return normalizeSql(statements);
};

type EntityClass = new () => object;

const columnFor = (target: EntityClass, propertyName: string) =>
  getMetadataArgsStorage().columns.find(
    (column) =>
      column.target === target && column.propertyName === propertyName,
  );

const indexFor = (target: EntityClass, name: string) =>
  getMetadataArgsStorage().indices.find(
    (index) => index.target === target && index.name === name,
  );

const uniqueFor = (target: EntityClass, name: string) =>
  getMetadataArgsStorage().uniques.find(
    (unique) => unique.target === target && unique.name === name,
  );

const relationFor = (target: EntityClass, propertyName: string) =>
  getMetadataArgsStorage().relations.find(
    (relation) =>
      relation.target === target && relation.propertyName === propertyName,
  );

const joinColumnsFor = (target: EntityClass, propertyName: string) =>
  getMetadataArgsStorage().joinColumns.filter(
    (column) =>
      column.target === target && column.propertyName === propertyName,
  );

const checkFor = (target: EntityClass, name: string) =>
  getMetadataArgsStorage().checks.find(
    (check) => check.target === target && check.name === name,
  );

describe('offline/shared-space schema foundation', () => {
  it('adds space kind, optimistic versioning, and per-space idempotency', async () => {
    const sql = await captureMigration('up');

    expect(sql).toMatch(
      /ALTER TABLE "?couples"? ADD COLUMN "?kind"? character varying\(20\)/i,
    );
    expect(sql).toContain('Ambiguous legacy space kind');
    expect(sql).toMatch(
      /LOCK TABLE "couple_members", "couple_invitations" IN SHARE ROW EXCLUSIVE MODE/i,
    );
    expect(sql).toContain(`WHEN c."name" = 'Personal Ledger'`);
    expect(sql).toContain(`cm."user_id" = c."created_by"`);
    expect(sql).toContain(`cm."role" = 'owner'`);
    expect(sql).toContain(`cm."status" = 'active'`);
    expect(sql).toContain('FROM "couple_invitations" AS invitation');
    expect(sql).toContain(`THEN 'personal' ELSE 'shared'`);
    expect(sql).toMatch(
      /ALTER TABLE "?couples"? ALTER COLUMN "?kind"? SET DEFAULT 'personal'/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "?couples"? ALTER COLUMN "?kind"? SET NOT NULL/i,
    );
    expect(sql).toContain(`CHECK (kind IN ('personal','shared'))`);
    expect(sql).toMatch(
      /ALTER TABLE "?couples"? ADD COLUMN "?sync_policy"? character varying\(20\) NOT NULL DEFAULT 'local_only'/i,
    );
    expect(sql).toMatch(
      /UPDATE "?couples"? SET "?sync_policy"? = 'cloud_sync'/i,
    );
    expect(sql).toContain(`CHECK (sync_policy IN ('local_only','cloud_sync'))`);
    expect(sql).toContain(
      `CHECK (kind <> 'shared' OR sync_policy = 'cloud_sync')`,
    );
    expect(sql.indexOf(`SET "kind" = COALESCE`)).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf(`SET "kind" = COALESCE`)).toBeLessThan(
      sql.indexOf(`ADD COLUMN "sync_policy"`),
    );
    expect(sql.indexOf(`SET "sync_policy" = 'cloud_sync'`)).toBeLessThan(
      sql.indexOf(`ADD CONSTRAINT "CHK_couples_shared_cloud_sync"`),
    );
    expect(sql).toContain(
      'classify or archive duplicate legacy couples before migration',
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "UQ_couples_active_personal_creator" ON "?couples"? \("?created_by"?\) WHERE kind = 'personal' AND status = 'active'/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "?expenses"? ADD COLUMN "?version"? integer NOT NULL DEFAULT 1/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "?expenses"? ADD COLUMN "?client_mutation_id"? character varying\(128\)/i,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "UQ_expenses_couple_client_mutation_id" ON "?expenses"? \("?couple_id"?, "?client_mutation_id"?\) WHERE client_mutation_id IS NOT NULL/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX "IDX_expenses_couple_updated_id" ON "?expenses"? \("?couple_id"?, "?updated_at"?, "?id"?\)/i,
    );
  });

  it('moves soft-deleted names and emails to active-row uniqueness', async () => {
    const sql = await captureMigration('up');

    expect(sql).toContain(
      'ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "UQ_categories_couple_name"',
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "UQ_categories_couple_name_active" ON "?categories"? \("?couple_id"?, "?name"?\) WHERE deleted_at IS NULL/i,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "UQ_participants_couple_email_active" ON "?participants"? \("?couple_id"?, "?email"?\) WHERE email IS NOT NULL AND deleted_at IS NULL/i,
    );
  });

  it('migrates only untouched legacy default-category rows after a Health conflict preflight', async () => {
    const sql = await captureMigration('up');

    expect(sql).toContain(
      'Legacy Healthcare default conflicts with an active Health category; map categories manually before retrying migration 009',
    );
    expect(sql).toMatch(
      /legacy\."?is_default"? = true.*legacy\."?name"?::text = 'Healthcare'.*legacy\."?color"? = '#4CAF50'.*legacy\."?icon"? = 'local-hospital'.*legacy\."?deleted_at"? IS NULL.*conflict\."?deleted_at"? IS NULL.*conflict\."?name"? = 'Health'/i,
    );
    expect(sql).toContain('CREATE TABLE "category_catalog_migration_009"');
    expect(sql).toMatch(
      /INSERT INTO "category_catalog_migration_009".*FROM "categories" AS category.*WHERE category\."is_default" = true/i,
    );
    expect(sql).toContain(
      'category."name"::text = mapping."old_name" AND category."color" = mapping."old_color" AND category."icon" IS NOT DISTINCT FROM mapping."old_icon"',
    );

    for (const mapping of [
      [
        'Food & Dining',
        '#FF5722',
        'restaurant',
        'Food & Dining',
        '#FF6384',
        'restaurant',
      ],
      [
        'Transportation',
        '#2196F3',
        'directions-car',
        'Transportation',
        '#36A2EB',
        'directions-car',
      ],
      [
        'Shopping',
        '#9C27B0',
        'shopping-cart',
        'Shopping',
        '#FFCE56',
        'shopping-cart',
      ],
      [
        'Entertainment',
        '#FF9800',
        'movie',
        'Entertainment',
        '#4BC0C0',
        'movie',
      ],
      [
        'Bills & Utilities',
        '#F44336',
        'receipt',
        'Bills & Utilities',
        '#9966FF',
        'receipt',
      ],
      [
        'Healthcare',
        '#4CAF50',
        'local-hospital',
        'Health',
        '#FF9F40',
        'local-hospital',
      ],
      ['Travel', '#00BCD4', 'flight', 'Travel', '#C9CBCF', 'flight'],
      ['Other', '#607D8B', 'category', 'Other', '#61C0BF', 'category'],
    ]) {
      expect(sql).toContain(`('${mapping.join("', '")}')`);
    }

    expect(sql).toMatch(
      /UPDATE "categories" AS category SET "name" = tracked\."new_name", "color" = tracked\."new_color", "icon" = tracked\."new_icon" FROM "category_catalog_migration_009" AS tracked WHERE category\."id" = tracked\."category_id"/i,
    );
  });

  it('reverts only tracked, unchanged canonical category rows and fails closed otherwise', async () => {
    const sql = await captureMigration('down');

    expect(sql).toContain(
      'Tracked canonical category changed or disappeared; map categories manually before reverting migration 009',
    );
    expect(sql).toContain(
      'Reverting Health would conflict with an existing Healthcare category; map categories manually before reverting migration 009',
    );
    expect(sql).toContain(
      'LOWER(conflict."name"::text) = LOWER(tracked."old_name")',
    );
    expect(sql).toMatch(
      /category\."name"::text IS DISTINCT FROM tracked\."new_name".*category\."color" IS DISTINCT FROM tracked\."new_color".*category\."icon" IS DISTINCT FROM tracked\."new_icon"/i,
    );
    expect(sql).toMatch(
      /UPDATE "categories" AS category SET "name" = tracked\."old_name", "color" = tracked\."old_color", "icon" = tracked\."old_icon" FROM "category_catalog_migration_009" AS tracked WHERE category\."id" = tracked\."category_id"/i,
    );
    expect(sql.indexOf('SET "name" = tracked."old_name"')).toBeLessThan(
      sql.indexOf('DROP TABLE "category_catalog_migration_009"'),
    );
  });

  it('checks the affected expense after split deletion and amount changes', async () => {
    const sql = await captureMigration('up');

    expect(sql).toContain("IF TG_OP = 'DELETE' THEN");
    expect(sql).toContain('affected_expense_id := OLD.expense_id');
    expect(sql).toContain('affected_expense_id := NEW.expense_id');
    expect(sql).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_expense_amount_split_balance AFTER UPDATE OF amount_cents ON expenses DEFERRABLE INITIALLY DEFERRED/i,
    );
  });

  it('enforces same-space references with explicit legacy-data guards', async () => {
    const sql = await captureMigration('up');

    expect(sql).toContain(
      'Cross-space expense references must be repaired before migration',
    );
    expect(sql).toContain(
      'Cross-space expense splits must be repaired before migration',
    );
    expect(sql).toContain(
      'Cross-space group members must be repaired before migration',
    );
    expect(sql).toMatch(
      /ALTER TABLE "expense_splits" ADD COLUMN "couple_id" uuid/i,
    );
    expect(sql).toMatch(
      /UPDATE "expense_splits" AS child SET "couple_id" = parent\."couple_id" FROM "expenses" AS parent WHERE child\."expense_id" = parent\."id"/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "group_members" ADD COLUMN "couple_id" uuid/i,
    );
    expect(sql).toMatch(
      /UPDATE "group_members" AS child SET "couple_id" = parent\."couple_id" FROM "expense_groups" AS parent WHERE child\."group_id" = parent\."id"/i,
    );
    expect(sql).toContain(
      'CONSTRAINT "UQ_expenses_id_couple" UNIQUE ("id", "couple_id")',
    );
    expect(sql).toContain(
      'CONSTRAINT "UQ_expense_groups_id_couple" UNIQUE ("id", "couple_id")',
    );
    expect(sql).toContain(
      'CONSTRAINT "UQ_categories_id_couple" UNIQUE ("id", "couple_id")',
    );
    expect(sql).toContain(
      'CONSTRAINT "UQ_participants_id_couple" UNIQUE ("id", "couple_id")',
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("group_id", "couple_id"\) REFERENCES "expense_groups"\("id", "couple_id"\) ON DELETE NO ACTION/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("category_id", "couple_id"\) REFERENCES "categories"\("id", "couple_id"\) ON DELETE NO ACTION/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("paid_by_participant_id", "couple_id"\) REFERENCES "participants"\("id", "couple_id"\) ON DELETE NO ACTION/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("expense_id", "couple_id"\) REFERENCES "expenses"\("id", "couple_id"\) ON DELETE CASCADE/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("participant_id", "couple_id"\) REFERENCES "participants"\("id", "couple_id"\) ON DELETE CASCADE/i,
    );
  });

  it('caps persisted cent values at the JavaScript safe-integer boundary', async () => {
    const sql = await captureMigration('up');

    expect(sql).toContain(
      'CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991)',
    );
    expect(sql).toContain(
      'CHECK (share_cents >= 0 AND share_cents <= 9007199254740991)',
    );
  });

  it('provides a down path for every schema object introduced by the migration', async () => {
    const sql = await captureMigration('down');

    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS trg_expense_amount_split_balance ON expenses',
    );
    expect(sql).toContain(
      'DROP INDEX IF EXISTS "UQ_participants_couple_email_active"',
    );
    expect(sql).toContain(
      'DROP INDEX IF EXISTS "UQ_categories_couple_name_active"',
    );
    expect(sql).toContain(
      'DROP INDEX IF EXISTS "UQ_expenses_couple_client_mutation_id"',
    );
    expect(sql).toContain(
      'DROP INDEX IF EXISTS "IDX_expenses_couple_updated_id"',
    );
    expect(sql).toContain(
      'ALTER TABLE "expenses" DROP COLUMN IF EXISTS "client_mutation_id"',
    );
    expect(sql).toContain(
      'ALTER TABLE "expenses" DROP COLUMN IF EXISTS "version"',
    );
    expect(sql).toContain('ALTER TABLE "couples" DROP COLUMN IF EXISTS "kind"');
    expect(sql).toContain(
      'ALTER TABLE "couples" DROP COLUMN IF EXISTS "sync_policy"',
    );
    expect(sql).toContain(
      'DROP INDEX IF EXISTS "UQ_couples_active_personal_creator"',
    );
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "FK_expenses_group_couple"',
    );
    expect(sql).toContain(
      'ALTER TABLE "expense_splits" DROP COLUMN IF EXISTS "couple_id"',
    );
    expect(sql).toContain(
      'ALTER TABLE "group_members" DROP COLUMN IF EXISTS "couple_id"',
    );
    expect(sql).toContain(
      'CONSTRAINT "FK_expenses_group" FOREIGN KEY ("group_id") REFERENCES "expense_groups"("id") ON DELETE SET NULL',
    );
    expect(sql).toContain("IF TG_OP = 'DELETE' THEN");
    expect(sql).toContain('affected_expense_id := OLD.expense_id');
  });

  it.each([Couple, CoupleSimple])(
    '%p exposes the legacy-space kind discriminator',
    (entity) => {
      const kind = columnFor(entity, 'kind');
      const syncPolicy = columnFor(entity, 'syncPolicy');
      expect(kind?.options).toMatchObject({ length: 20, default: 'personal' });
      expect(syncPolicy?.options).toMatchObject({
        name: 'sync_policy',
        length: 20,
        default: 'local_only',
      });
      expect(checkFor(entity, 'CHK_couples_sync_policy')?.expression).toBe(
        "sync_policy IN ('local_only','cloud_sync')",
      );
      expect(
        checkFor(entity, 'CHK_couples_shared_cloud_sync')?.expression,
      ).toBe("kind <> 'shared' OR sync_policy = 'cloud_sync'");
      expect(
        indexFor(entity, 'UQ_couples_active_personal_creator'),
      ).toMatchObject({
        unique: true,
        where: '"kind" = \'personal\' AND "status" = \'active\'',
      });
    },
  );

  it.each([Expense, ExpenseSimple])(
    '%p exposes version and client mutation metadata',
    (entity) => {
      const version = columnFor(entity, 'version');
      const mutationId = columnFor(entity, 'clientMutationId');
      const idempotencyIndex = indexFor(
        entity,
        'UQ_expenses_couple_client_mutation_id',
      );

      expect(version?.mode).toBe('version');
      expect(version?.options).toMatchObject({ type: 'integer', default: 1 });
      expect(mutationId?.options).toMatchObject({
        name: 'client_mutation_id',
        length: 128,
        nullable: true,
      });
      expect(idempotencyIndex).toMatchObject({
        unique: true,
        where: '"client_mutation_id" IS NOT NULL',
      });
      expect(indexFor(entity, 'IDX_expenses_couple_updated_id')).toMatchObject({
        columns: ['coupleId', 'updatedAt', 'id'],
      });
      expect(uniqueFor(entity, 'UQ_expenses_id_couple')).toMatchObject({
        columns: ['id', 'coupleId'],
      });
      expect(
        checkFor(entity, 'CHK_expenses_amount_positive')?.expression,
      ).toContain('9007199254740991');
      for (const relation of ['group', 'category', 'payer']) {
        expect(relationFor(entity, relation)?.options.onDelete).toBe(
          'NO ACTION',
        );
        expect(joinColumnsFor(entity, relation)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'couple_id',
              referencedColumnName: 'coupleId',
            }),
          ]),
        );
      }
    },
  );

  it.each([
    [ExpenseGroup, 'UQ_expense_groups_id_couple'],
    [ExpenseGroupSimple, 'UQ_expense_groups_id_couple'],
    [Category, 'UQ_categories_id_couple'],
    [CategorySimple, 'UQ_categories_id_couple'],
    [Participant, 'UQ_participants_id_couple'],
    [ParticipantSimple, 'UQ_participants_id_couple'],
  ] as const)('%p exposes a composite tenant parent key', (entity, name) => {
    expect(uniqueFor(entity, name)).toMatchObject({
      columns: ['id', 'coupleId'],
    });
  });

  it.each([ExpenseSplit, ExpenseSplitSimple])(
    '%p carries the expense tenant into both composite references',
    (entity) => {
      expect(columnFor(entity, 'coupleId')?.options).toMatchObject({
        name: 'couple_id',
        nullable: false,
      });
      expect(
        checkFor(entity, 'CHK_expense_splits_share_cents')?.expression,
      ).toContain('9007199254740991');
      for (const relation of ['expense', 'participant']) {
        expect(joinColumnsFor(entity, relation)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'couple_id',
              referencedColumnName: 'coupleId',
            }),
          ]),
        );
      }
    },
  );

  it.each([GroupMember, GroupMemberSimple])(
    '%p carries the group tenant into both composite references',
    (entity) => {
      expect(columnFor(entity, 'coupleId')?.options).toMatchObject({
        name: 'couple_id',
        nullable: false,
      });
      for (const relation of ['group', 'participant']) {
        expect(joinColumnsFor(entity, relation)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'couple_id',
              referencedColumnName: 'coupleId',
            }),
          ]),
        );
      }
    },
  );

  it.each([Category, CategorySimple])(
    '%p uses active-row category-name uniqueness',
    (entity) => {
      expect(
        indexFor(entity, 'UQ_categories_couple_name_active'),
      ).toMatchObject({
        unique: true,
        where: '"deleted_at" IS NULL',
      });
      expect(
        getMetadataArgsStorage().uniques.find(
          (unique) =>
            unique.target === entity &&
            unique.name === 'UQ_categories_couple_name',
        ),
      ).toBeUndefined();
    },
  );

  it.each([Participant, ParticipantSimple])(
    '%p uses active-row participant-email uniqueness',
    (entity) => {
      expect(
        indexFor(entity, 'UQ_participants_couple_email_active'),
      ).toMatchObject({
        unique: true,
        where: '"email" IS NOT NULL AND "deleted_at" IS NULL',
      });
    },
  );
});
