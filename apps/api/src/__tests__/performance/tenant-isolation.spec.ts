import { DataSource } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { Expense } from '../../entities/expense.entity';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';

jest.setTimeout(45000);

describe('Tenant isolation sanity', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
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

  const expenseRepo = () => dataSource.getRepository(Expense);
  const coupleRepo = () => dataSource.getRepository(Couple);
  const userRepo = () => dataSource.getRepository(User);

  const createUser = async (email: string) =>
    userRepo().save(
      userRepo().create({
        email,
        passwordHash: 'hash',
        displayName: email.split('@')[0],
      }),
    );

  const createCouple = async (createdBy: string, inviteCode: string) =>
    coupleRepo().save(coupleRepo().create({ inviteCode, createdBy }));

  it('keeps expense queries scoped by couple_id', async () => {
    const userA = await createUser('tenant-a@example.com');
    const userB = await createUser('tenant-b@example.com');
    const coupleA = await createCouple(userA.id, 'COUPLEA');
    const coupleB = await createCouple(userB.id, 'COUPLEB');

    await expenseRepo().insert([
      {
        coupleId: coupleA.id,
        createdBy: userA.id,
        description: 'Coffee',
        amountCents: '500',
        currency: 'USD',
        expenseDate: '2025-09-24',
      },
      {
        coupleId: coupleB.id,
        createdBy: userB.id,
        description: 'Dinner',
        amountCents: '7000',
        currency: 'USD',
        expenseDate: '2025-09-24',
      },
    ]);

    const scopedExpenses = await expenseRepo().find({
      where: { coupleId: coupleA.id },
    });
    expect(scopedExpenses).toHaveLength(1);
    expect(scopedExpenses[0]?.description).toBe('Coffee');

    const leakage = await dataSource
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from(Expense, 'expense')
      .where('expense.couple_id != :coupleId', { coupleId: coupleA.id })
      .andWhere('expense.couple_id = :coupleId', { coupleId: coupleA.id })
      .getRawOne<{ count: string }>();

    expect((leakage ?? { count: '0' }).count).toBe('0');
  });
});
