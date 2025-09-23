import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { Expense } from '../../entities/expense.entity';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';
import { Participant } from '../../entities/participant.entity';

jest.setTimeout(45000);

describe('Expense Entity (Postgres)', () => {
  let dataSource: DataSource;
  let expenses: Repository<Expense>;
  let couples: Repository<Couple>;
  let users: Repository<User>;
  let participants: Repository<Participant>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    expenses = dataSource.getRepository(Expense);
    couples = dataSource.getRepository(Couple);
    users = dataSource.getRepository(User);
    participants = dataSource.getRepository(Participant);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query(
      'TRUNCATE TABLE "expense_attachments", "expense_splits", "expenses" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query(
      'TRUNCATE TABLE "categories" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query(
      'TRUNCATE TABLE "group_members", "expense_groups", "participants", "couple_invitations", "couple_members", "couples" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async (email: string) =>
    users.save(
      users.create({
        email,
        passwordHash: 'hash',
        displayName: email.split('@')[0],
      }),
    );

  const createCouple = async (createdBy: string) =>
    couples.save(
      couples.create({
        inviteCode: `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        createdBy,
      }),
    );

  const linkParticipant = async (coupleId: string, userId: string) =>
    participants.save(
      participants.create({
        coupleId,
        userId,
        displayName: 'Member',
        isRegistered: true,
      }),
    );

  it('rejects currency values that are not uppercase ISO codes', async () => {
    const user = await createUser('owner@example.com');
    const couple = await createCouple(user.id);

    await expect(
      expenses.save(
        expenses.create({
          coupleId: couple.id,
          description: 'Invalid currency',
          createdBy: user.id,
          amountCents: '1000',
          currency: 'usd',
          expenseDate: '2025-09-24',
        }),
      ),
    ).rejects.toThrow(/CHK_expenses_currency/i);
  });

  it('rejects split types outside accepted enum', async () => {
    const user = await createUser('owner2@example.com');
    const couple = await createCouple(user.id);
    const participant = await linkParticipant(couple.id, user.id);

    await expect(
      expenses.save(
        expenses.create({
          coupleId: couple.id,
          description: 'Invalid split',
          createdBy: user.id,
          paidByParticipantId: participant.id,
          amountCents: '5000',
          currency: 'USD',
          expenseDate: '2025-09-24',
          splitType: 'ratio' as Expense['splitType'],
        }),
      ),
    ).rejects.toThrow(/CHK_expenses_split_type/i);
  });
});
