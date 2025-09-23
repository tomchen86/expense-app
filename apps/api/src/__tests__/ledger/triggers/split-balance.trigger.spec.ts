import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../../setup/datasource.factory';
import { Expense } from '../../../entities/expense.entity';
import { ExpenseSplit } from '../../../entities/expense-split.entity';
import { Couple } from '../../../entities/couple.entity';
import { User } from '../../../entities/user.entity';
import { Participant } from '../../../entities/participant.entity';

jest.setTimeout(45000);

describe('expense split balance trigger', () => {
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

  const linkParticipant = async (
    coupleId: string,
    userId: string,
    name: string,
  ) =>
    participants.save(
      participants.create({
        coupleId,
        userId,
        displayName: name,
        isRegistered: true,
      }),
    );

  const createExpense = async (
    coupleId: string,
    createdBy: string,
    payerId: string,
  ) =>
    expenses.save(
      expenses.create({
        coupleId,
        createdBy,
        paidByParticipantId: payerId,
        description: 'Dinner',
        amountCents: '10000',
        currency: 'USD',
        expenseDate: '2025-09-24',
      }),
    );

  it('allows splits that sum to the expense total', async () => {
    const userA = await createUser('balance-ok-a@example.com');
    const userB = await createUser('balance-ok-b@example.com');
    const couple = await createCouple(userA.id);
    const participantA = await linkParticipant(couple.id, userA.id, 'A');
    const participantB = await linkParticipant(couple.id, userB.id, 'B');
    const expense = await createExpense(couple.id, userA.id, participantA.id);

    await expect(
      dataSource.transaction(async (manager) => {
        await manager.getRepository(ExpenseSplit).insert({
          expenseId: expense.id,
          participantId: participantA.id,
          shareCents: '6000',
        });

        await manager.getRepository(ExpenseSplit).insert({
          expenseId: expense.id,
          participantId: participantB.id,
          shareCents: '4000',
        });
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects splits whose totals differ from expense amount', async () => {
    const userA = await createUser('balance-bad-a@example.com');
    const userB = await createUser('balance-bad-b@example.com');
    const couple = await createCouple(userA.id);
    const participantA = await linkParticipant(couple.id, userA.id, 'A');
    const participantB = await linkParticipant(couple.id, userB.id, 'B');
    const expense = await createExpense(couple.id, userA.id, participantA.id);

    await expect(
      dataSource.transaction(async (manager) => {
        await manager.getRepository(ExpenseSplit).insert({
          expenseId: expense.id,
          participantId: participantA.id,
          shareCents: '5000',
        });

        await manager.getRepository(ExpenseSplit).insert({
          expenseId: expense.id,
          participantId: participantB.id,
          shareCents: '3000',
        });
      }),
    ).rejects.toThrow(/Split total/);
  });
});
