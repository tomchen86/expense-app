import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { User } from '../../entities/user.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { UserAuthIdentity } from '../../entities/user-auth-identity.entity';
import { UserDevice } from '../../entities/user-device.entity';
import { Couple } from '../../entities/couple.entity';
import { CoupleMember } from '../../entities/couple-member.entity';
import { CoupleInvitation } from '../../entities/couple-invitation.entity';
import { Participant } from '../../entities/participant.entity';
import { ExpenseGroup } from '../../entities/expense-group.entity';
import { GroupMember } from '../../entities/group-member.entity';
import { Category } from '../../entities/category.entity';
import { Expense } from '../../entities/expense.entity';
import { ExpenseSplit } from '../../entities/expense-split.entity';
import { ExpenseAttachment } from '../../entities/expense-attachment.entity';
import { UserSimple } from '../../entities/user-simple.entity';
import { UserSettingsSimple } from '../../entities/user-settings-simple.entity';
import { UserAuthIdentitySimple } from '../../entities/user-auth-identity-simple.entity';
import { UserDeviceSimple } from '../../entities/user-device-simple.entity';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { CoupleMemberSimple } from '../../entities/couple-member-simple.entity';
import { CoupleInvitationSimple } from '../../entities/couple-invitation-simple.entity';
import { ParticipantSimple } from '../../entities/participant-simple.entity';
import { ExpenseGroupSimple } from '../../entities/expense-group-simple.entity';
import { GroupMemberSimple } from '../../entities/group-member-simple.entity';
import { CategorySimple } from '../../entities/category-simple.entity';
import { ExpenseSimple } from '../../entities/expense-simple.entity';
import { ExpenseSplitSimple } from '../../entities/expense-split-simple.entity';
import { ExpenseAttachmentSimple } from '../../entities/expense-attachment-simple.entity';

import { ensureTestPostgresUri } from './postgres-test-container';
import { EnableExtensions0011738364606484 } from '../../database/migrations/001_enable_extensions';
import { IdentityTables0021738364606485 } from '../../database/migrations/002_identity_tables';
import { CollaborationTables0031738364606486 } from '../../database/migrations/003_collaboration_tables';
import { ExpenseCore0041738364606487 } from '../../database/migrations/004_expense_core';
import { IndexesAndTriggers0051738364606488 } from '../../database/migrations/005_indexes_and_triggers';
import { SoftDeleteExtensions0061738364606489 } from '../../database/migrations/006_soft_delete_extensions';
import { SoftDeleteParticipants0071738364606490 } from '../../database/migrations/007_soft_delete_participants';
import { SoftDeleteAttachments0081738364606491 } from '../../database/migrations/008_soft_delete_attachments';

type CreatePostgresOptions = {
  runMigrations?: boolean;
};

export const createSqliteDataSource = (): Promise<DataSource> =>
  Promise.resolve(
    new DataSource({
      type: 'sqljs',
      location: ':memory:',
      autoSave: false,
      entities: [
        UserSimple,
        UserSettingsSimple,
        UserAuthIdentitySimple,
        UserDeviceSimple,
        CoupleSimple,
        CoupleMemberSimple,
        CoupleInvitationSimple,
        ParticipantSimple,
        ExpenseGroupSimple,
        GroupMemberSimple,
        CategorySimple,
        ExpenseSimple,
        ExpenseSplitSimple,
        ExpenseAttachmentSimple,
      ],
      synchronize: true,
      logging: false,
    }),
  );

const isConnectionAvailable = async (
  connectionString: string,
): Promise<boolean> => {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => undefined);
    return false;
  }
};

export const createPostgresDataSource = async (
  options: CreatePostgresOptions = {},
): Promise<DataSource> => {
  const { runMigrations = true } = options;

  const candidateUrls = [
    process.env.TEST_DATABASE_URL,
    process.env.COMPOSE_TEST_DATABASE_URL,
    'postgres://dev_user:dev_password@127.0.0.1:5432/expense_tracker_dev',
  ].filter((value): value is string => Boolean(value));

  let connectionString: string | undefined;

  for (const candidate of candidateUrls) {
    if (await isConnectionAvailable(candidate)) {
      connectionString = candidate;
      break;
    }
  }

  if (!connectionString) {
    connectionString = await ensureTestPostgresUri();
  }

  process.env.TEST_DATABASE_URL = connectionString;

  const dataSource = new DataSource({
    type: 'postgres',
    url: connectionString,
    entities: [
      User,
      UserSettings,
      UserAuthIdentity,
      UserDevice,
      Couple,
      CoupleMember,
      CoupleInvitation,
      Participant,
      ExpenseGroup,
      GroupMember,
      Category,
      Expense,
      ExpenseSplit,
      ExpenseAttachment,
    ],
    synchronize: false,
    migrationsRun: false,
    migrations: [
      EnableExtensions0011738364606484,
      IdentityTables0021738364606485,
      CollaborationTables0031738364606486,
      ExpenseCore0041738364606487,
      IndexesAndTriggers0051738364606488,
      SoftDeleteExtensions0061738364606489,
      SoftDeleteParticipants0071738364606490,
      SoftDeleteAttachments0081738364606491,
    ],
    logging: false,
  });

  await dataSource.initialize();
  if (runMigrations) {
    await dataSource.runMigrations({ transaction: 'all' });
  }

  return dataSource;
};
