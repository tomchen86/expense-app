import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexesAndTriggers0051738364606488 implements MigrationInterface {
  name = 'IndexesAndTriggers0051738364606488';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    const triggerPairs: Array<{ table: string; trigger: string }> = [
      { table: 'users', trigger: 'trg_users_updated_at' },
      { table: 'user_settings', trigger: 'trg_user_settings_updated_at' },
      { table: 'user_devices', trigger: 'trg_user_devices_updated_at' },
      { table: 'couples', trigger: 'trg_couples_updated_at' },
      { table: 'expense_groups', trigger: 'trg_expense_groups_updated_at' },
      { table: 'categories', trigger: 'trg_categories_updated_at' },
      { table: 'participants', trigger: 'trg_participants_updated_at' },
      { table: 'expenses', trigger: 'trg_expenses_updated_at' },
    ];

    for (const { table, trigger } of triggerPairs) {
      await queryRunner.query(
        `
          CREATE TRIGGER "${trigger}"
          BEFORE UPDATE ON "${table}"
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
        `,
      );
    }

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_split_balance()
      RETURNS TRIGGER AS $$
      DECLARE
        total_shares BIGINT;
        expense_total BIGINT;
      BEGIN
        SELECT COALESCE(SUM(share_cents), 0) INTO total_shares FROM expense_splits WHERE expense_id = NEW.expense_id;
        SELECT amount_cents INTO expense_total FROM expenses WHERE id = NEW.expense_id;
        IF total_shares <> expense_total THEN
          RAISE EXCEPTION 'Split total % must equal expense amount %', total_shares, expense_total;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_expense_split_balance
      AFTER INSERT OR UPDATE OR DELETE ON expense_splits
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION assert_split_balance();
    `);

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_user_devices_status ON user_devices(sync_status);',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_couples_invite_code ON couples(invite_code);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_couples_status ON couples(status);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_couple_members_user ON couple_members(user_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_couple_members_status ON couple_members(status);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_couple_invitations_email ON couple_invitations(invited_email);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_couple_invitations_status ON couple_invitations(status);',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_categories_couple_id ON categories(couple_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_categories_default ON categories(is_default) WHERE is_default = true;',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_participants_couple ON participants(couple_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expense_groups_couple ON expense_groups(couple_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expense_groups_active ON expense_groups(is_archived) WHERE is_archived = false;',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_group_members_participant_id ON group_members(participant_id);',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expenses_created_by ON expenses(created_by);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expenses_couple_id ON expenses(couple_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expenses_group_id ON expenses(group_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expenses_category_id ON expenses(category_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expenses_paid_by_participant ON expenses(paid_by_participant_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expenses_deleted_at ON expenses(couple_id) WHERE deleted_at IS NULL;',
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expense_splits_expense_id ON expense_splits(expense_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_expense_splits_participant_id ON expense_splits(participant_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const indexStatements = [
      'idx_expense_splits_participant_id',
      'idx_expense_splits_expense_id',
      'idx_expenses_paid_by_participant',
      'idx_expenses_expense_date',
      'idx_expenses_category_id',
      'idx_expenses_group_id',
      'idx_expenses_couple_id',
      'idx_expenses_created_by',
      'idx_expenses_deleted_at',
      'idx_group_members_participant_id',
      'idx_group_members_group_id',
      'idx_expense_groups_active',
      'idx_expense_groups_couple',
      'idx_participants_user',
      'idx_participants_couple',
      'idx_categories_default',
      'idx_categories_couple_id',
      'idx_couple_invitations_status',
      'idx_couple_invitations_email',
      'idx_couple_members_status',
      'idx_couple_members_user',
      'idx_couples_status',
      'idx_couples_invite_code',
      'idx_user_devices_status',
      'idx_user_devices_user',
      'idx_user_settings_user_id',
      'idx_users_last_active',
    ];

    for (const indexName of indexStatements) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${indexName}";`);
    }

    await queryRunner.query(
      'DROP TRIGGER IF EXISTS trg_expense_split_balance ON expense_splits;',
    );
    await queryRunner.query('DROP FUNCTION IF EXISTS assert_split_balance();');

    const triggerPairs: Array<{ table: string; trigger: string }> = [
      { table: 'expenses', trigger: 'trg_expenses_updated_at' },
      { table: 'participants', trigger: 'trg_participants_updated_at' },
      { table: 'expense_groups', trigger: 'trg_expense_groups_updated_at' },
      { table: 'categories', trigger: 'trg_categories_updated_at' },
      { table: 'couples', trigger: 'trg_couples_updated_at' },
      { table: 'user_devices', trigger: 'trg_user_devices_updated_at' },
      { table: 'user_settings', trigger: 'trg_user_settings_updated_at' },
      { table: 'users', trigger: 'trg_users_updated_at' },
    ];

    for (const { table, trigger } of triggerPairs) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "${table}";`,
      );
    }

    await queryRunner.query(
      'DROP FUNCTION IF EXISTS update_updated_at_column();',
    );
  }
}
