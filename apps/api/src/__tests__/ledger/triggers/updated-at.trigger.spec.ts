import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../../setup/datasource.factory';
import { Expense } from '../../../entities/expense.entity';
import { Couple } from '../../../entities/couple.entity';
import { User } from '../../../entities/user.entity';
import { Participant } from '../../../entities/participant.entity';

jest.setTimeout(45000);

describe('updated_at triggers', () => {
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

  it('automatically updates updated_at timestamp on expenses', async () => {
    const user = await createUser('updated@example.com');
    const couple = await createCouple(user.id);
    const participant = await linkParticipant(couple.id, user.id);

    const expense = await expenses.save(
      expenses.create({
        coupleId: couple.id,
        createdBy: user.id,
        paidByParticipantId: participant.id,
        description: 'Groceries',
        amountCents: '2500',
        currency: 'USD',
        expenseDate: '2025-09-24',
      }),
    );

    const firstUpdated = expense.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 10));

    const saved = await expenses.save({ ...expense, notes: 'Updated note' });

    expect(saved.updatedAt.getTime()).toBeGreaterThan(firstUpdated.getTime());
  });
});
