import { DataSource } from 'typeorm';

const DEMO_IDS = {
  userAlex: '11111111-1111-4111-8111-111111111111',
  userJamie: '22222222-2222-4222-8222-222222222222',
  couple: '33333333-3333-4333-8333-333333333333',
  group: '44444444-4444-4444-8444-444444444444',
  category: '55555555-5555-4555-8555-555555555555',
  expense: '66666666-6666-4666-8666-666666666666',
  splitAlex: '77777777-7777-4777-8777-777777777771',
  splitJamie: '77777777-7777-4777-8777-777777777772',
  attachment: '88888888-8888-4888-8888-888888888888',
  participantExternal: '99999999-9999-4999-8999-999999999999',
};

const DEMO_EMAILS = {
  alex: 'demo.alex@example.com',
  jamie: 'demo.jamie@example.com',
  external: 'pat@example.com',
};

/**
 * Seeds a deterministic set of demo data (users, couple membership, participants,
 * groups, categories, expenses, splits, and attachments). The operation is idempotent
 * and safe to rerun.
 */
export const seedSampleData = async (dataSource: DataSource): Promise<void> => {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    await queryRunner.query(
      `INSERT INTO users (id, email, password_hash, display_name, timezone, default_currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         timezone = EXCLUDED.timezone,
         default_currency = EXCLUDED.default_currency,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [
        DEMO_IDS.userAlex,
        DEMO_EMAILS.alex,
        'demo-password',
        'Alex Demo',
        'America/Los_Angeles',
        'USD',
      ],
    );

    await queryRunner.query(
      `INSERT INTO users (id, email, password_hash, display_name, timezone, default_currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         timezone = EXCLUDED.timezone,
         default_currency = EXCLUDED.default_currency,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [
        DEMO_IDS.userJamie,
        DEMO_EMAILS.jamie,
        'demo-password',
        'Jamie Demo',
        'America/New_York',
        'USD',
      ],
    );

    await queryRunner.query(
      `INSERT INTO couples (id, name, invite_code, status, created_by)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (invite_code) DO UPDATE SET
         name = EXCLUDED.name,
         status = 'active',
         created_by = EXCLUDED.created_by,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [DEMO_IDS.couple, 'Alex & Jamie', 'DEMOCOUPLE', DEMO_IDS.userAlex],
    );

    await queryRunner.query(
      `INSERT INTO couple_members (couple_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')
       ON CONFLICT (couple_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         status = EXCLUDED.status;
      `,
      [DEMO_IDS.couple, DEMO_IDS.userAlex],
    );

    await queryRunner.query(
      `INSERT INTO couple_members (couple_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')
       ON CONFLICT (couple_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         status = EXCLUDED.status;
      `,
      [DEMO_IDS.couple, DEMO_IDS.userJamie],
    );

    const notificationPreferences = JSON.stringify({
      expenses: true,
      invites: true,
      reminders: true,
    });

    await queryRunner.query(
      `INSERT INTO participants (id, couple_id, user_id, display_name, email, is_registered, default_currency, notification_preferences)
       VALUES ($1, $2, $3, $4, $5, true, 'USD', $6::jsonb)
       ON CONFLICT (couple_id, user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         deleted_at = NULL;
      `,
      [
        DEMO_IDS.userAlex,
        DEMO_IDS.couple,
        DEMO_IDS.userAlex,
        'Alex Demo',
        DEMO_EMAILS.alex,
        notificationPreferences,
      ],
    );

    await queryRunner.query(
      `INSERT INTO participants (id, couple_id, user_id, display_name, email, is_registered, default_currency, notification_preferences)
       VALUES ($1, $2, $3, $4, $5, true, 'USD', $6::jsonb)
       ON CONFLICT (couple_id, user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         deleted_at = NULL;
      `,
      [
        DEMO_IDS.userJamie,
        DEMO_IDS.couple,
        DEMO_IDS.userJamie,
        'Jamie Demo',
        DEMO_EMAILS.jamie,
        notificationPreferences,
      ],
    );

    await queryRunner.query(
      `INSERT INTO participants (id, couple_id, user_id, display_name, email, is_registered, default_currency, notification_preferences)
       VALUES ($1, $2, NULL, $3, $4, false, 'USD', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         deleted_at = NULL;
      `,
      [
        DEMO_IDS.participantExternal,
        DEMO_IDS.couple,
        'Pat Guest',
        DEMO_EMAILS.external,
        notificationPreferences,
      ],
    );

    await queryRunner.query(
      `INSERT INTO expense_groups (id, couple_id, name, description, color, default_currency, is_archived, created_by)
       VALUES ($1, $2, $3, $4, $5, 'USD', false, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         color = EXCLUDED.color,
         is_archived = EXCLUDED.is_archived,
         deleted_at = NULL,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [
        DEMO_IDS.group,
        DEMO_IDS.couple,
        'Household',
        'Shared household budget',
        '#4F46E5',
        DEMO_IDS.userAlex,
      ],
    );

    await queryRunner.query(
      `INSERT INTO categories (id, couple_id, name, color, icon, is_default, created_by)
       VALUES ($1, $2, $3, $4, $5, false, $6)
       ON CONFLICT (couple_id, name) DO UPDATE SET
         color = EXCLUDED.color,
         icon = EXCLUDED.icon,
         deleted_at = NULL,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [
        DEMO_IDS.category,
        DEMO_IDS.couple,
        'Household Supplies',
        '#10B981',
        'shopping-bag',
        DEMO_IDS.userAlex,
      ],
    );

    await queryRunner.query(
      `INSERT INTO expenses (id, couple_id, group_id, category_id, created_by, paid_by_participant_id, description, amount_cents, currency, expense_date, split_type, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'USD', $9, 'equal', $10)
       ON CONFLICT (id) DO UPDATE SET
         description = EXCLUDED.description,
         amount_cents = EXCLUDED.amount_cents,
         notes = EXCLUDED.notes,
         deleted_at = NULL,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [
        DEMO_IDS.expense,
        DEMO_IDS.couple,
        DEMO_IDS.group,
        DEMO_IDS.category,
        DEMO_IDS.userAlex,
        DEMO_IDS.userAlex,
        'Weekly groceries run',
        9000,
        '2025-09-20',
        'Split evenly between Alex and Jamie',
      ],
    );

    await queryRunner.query(
      `INSERT INTO expense_splits (id, expense_id, participant_id, share_cents, share_percent)
       VALUES ($1, $2, $3, $4, 50)
       ON CONFLICT (expense_id, participant_id) DO UPDATE SET
         share_cents = EXCLUDED.share_cents,
         share_percent = EXCLUDED.share_percent,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [DEMO_IDS.splitAlex, DEMO_IDS.expense, DEMO_IDS.userAlex, 4500],
    );

    await queryRunner.query(
      `INSERT INTO expense_splits (id, expense_id, participant_id, share_cents, share_percent)
       VALUES ($1, $2, $3, $4, 50)
       ON CONFLICT (expense_id, participant_id) DO UPDATE SET
         share_cents = EXCLUDED.share_cents,
         share_percent = EXCLUDED.share_percent,
         updated_at = CURRENT_TIMESTAMP;
      `,
      [DEMO_IDS.splitJamie, DEMO_IDS.expense, DEMO_IDS.userJamie, 4500],
    );

    await queryRunner.query(
      `INSERT INTO expense_attachments (id, expense_id, storage_path, file_type, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         storage_path = EXCLUDED.storage_path,
         file_type = EXCLUDED.file_type,
         file_size_bytes = EXCLUDED.file_size_bytes,
         deleted_at = NULL,
         created_at = expense_attachments.created_at;
      `,
      [
        DEMO_IDS.attachment,
        DEMO_IDS.expense,
        '/receipts/demo-groceries.png',
        'image/png',
        4096,
      ],
    );

    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
};
