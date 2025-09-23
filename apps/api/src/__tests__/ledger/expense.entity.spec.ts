import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { ExpenseSimple } from '../../entities/expense-simple.entity';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';
import { ParticipantSimple } from '../../entities/participant-simple.entity';
import { ExpenseGroupSimple } from '../../entities/expense-group-simple.entity';
import { CategorySimple } from '../../entities/category-simple.entity';

const randomInvite = () =>
  `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

describe('Expense Entity (sql.js)', () => {
  let dataSource: DataSource;
  let expenses: Repository<ExpenseSimple>;
  let couples: Repository<CoupleSimple>;
  let users: Repository<UserSimple>;
  let participants: Repository<ParticipantSimple>;
  let groups: Repository<ExpenseGroupSimple>;
  let categories: Repository<CategorySimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    expenses = dataSource.getRepository(ExpenseSimple);
    couples = dataSource.getRepository(CoupleSimple);
    users = dataSource.getRepository(UserSimple);
    participants = dataSource.getRepository(ParticipantSimple);
    groups = dataSource.getRepository(ExpenseGroupSimple);
    categories = dataSource.getRepository(CategorySimple);
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

  const createParticipant = async (
    coupleId: string,
    overrides: Partial<ParticipantSimple> = {},
  ) =>
    participants.save(
      participants.create({
        coupleId,
        displayName: overrides.displayName ?? 'Participant',
        userId: overrides.userId,
        email: overrides.email,
        isRegistered: overrides.isRegistered ?? Boolean(overrides.userId),
      }),
    );

  const createExpenseGroup = async (coupleId: string, createdBy: string) =>
    groups.save(
      groups.create({
        coupleId,
        name: 'Household',
        createdBy,
      }),
    );

  const createCategory = async (coupleId: string) =>
    categories.save(
      categories.create({
        coupleId,
        name: `Category-${Date.now()}`,
        color: '#112233',
      }),
    );

  it('persists expenses with defaults and relationships', async () => {
    const user = await createUser('owner@example.com');
    const couple = await createCouple(user.id);
    const group = await createExpenseGroup(couple.id, user.id);
    const category = await createCategory(couple.id);
    const participant = await createParticipant(couple.id, {
      userId: user.id,
      isRegistered: true,
    });

    const expense = await expenses.save(
      expenses.create({
        coupleId: couple.id,
        groupId: group.id,
        categoryId: category.id,
        createdBy: user.id,
        paidByParticipantId: participant.id,
        description: 'Weekly groceries',
        amountCents: 1299,
        currency: 'USD',
        expenseDate: '2025-09-24',
      }),
    );

    expect(expense.splitType).toBe('equal');
    expect(expense.createdAt).toBeInstanceOf(Date);
    expect(expense.updatedAt).toBeInstanceOf(Date);
    expect(expense.deletedAt).toBeNull();
  });

  it('rejects negative amounts via check constraint', async () => {
    const user = await createUser('owner-neg@example.com');
    const couple = await createCouple(user.id);

    await expect(
      expenses.insert({
        coupleId: couple.id,
        createdBy: user.id,
        description: 'Invalid',
        amountCents: -500,
        currency: 'USD',
        expenseDate: '2025-09-24',
      }),
    ).rejects.toThrow();
  });
});
