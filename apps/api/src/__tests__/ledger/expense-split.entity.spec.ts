import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { ExpenseSplitSimple } from '../../entities/expense-split-simple.entity';
import { ExpenseSimple } from '../../entities/expense-simple.entity';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';
import { ParticipantSimple } from '../../entities/participant-simple.entity';

const randomInvite = () =>
  `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

describe('ExpenseSplit Entity (sql.js)', () => {
  let dataSource: DataSource;
  let splits: Repository<ExpenseSplitSimple>;
  let expenses: Repository<ExpenseSimple>;
  let couples: Repository<CoupleSimple>;
  let users: Repository<UserSimple>;
  let participants: Repository<ParticipantSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    splits = dataSource.getRepository(ExpenseSplitSimple);
    expenses = dataSource.getRepository(ExpenseSimple);
    couples = dataSource.getRepository(CoupleSimple);
    users = dataSource.getRepository(UserSimple);
    participants = dataSource.getRepository(ParticipantSimple);
  });

  afterEach(async () => {
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

  const createCouple = async (userId: string) =>
    couples.save(
      couples.create({ inviteCode: randomInvite(), createdBy: userId }),
    );

  const createParticipant = async (coupleId: string, userId: string) =>
    participants.save(
      participants.create({
        coupleId,
        userId,
        displayName: 'Member',
        isRegistered: true,
      }),
    );

  const createExpense = async (coupleId: string, createdBy: string) =>
    expenses.save(
      expenses.create({
        coupleId,
        createdBy,
        description: 'Dinner',
        amountCents: 5000,
        currency: 'USD',
        expenseDate: '2025-09-24',
      }),
    );

  it('enforces unique participant per expense', async () => {
    const user = await createUser('split@example.com');
    const couple = await createCouple(user.id);
    const participant = await createParticipant(couple.id, user.id);
    const expense = await createExpense(couple.id, user.id);

    await splits.save(
      splits.create({
        expenseId: expense.id,
        participantId: participant.id,
        shareCents: 2500,
      }),
    );

    await expect(
      splits.insert({
        expenseId: expense.id,
        participantId: participant.id,
        shareCents: 2500,
      }),
    ).rejects.toThrow();
  });

  it('rejects share percent values over 100', async () => {
    const user = await createUser('split-percent@example.com');
    const couple = await createCouple(user.id);
    const participant = await createParticipant(couple.id, user.id);
    const expense = await createExpense(couple.id, user.id);

    await expect(
      splits.insert({
        expenseId: expense.id,
        participantId: participant.id,
        shareCents: 2500,
        sharePercent: 120,
      }),
    ).rejects.toThrow();
  });
});
