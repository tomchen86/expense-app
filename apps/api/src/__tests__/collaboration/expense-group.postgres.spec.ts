import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { ExpenseGroup } from '../../entities/expense-group.entity';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';

jest.setTimeout(45000);

describe('ExpenseGroup Entity (Postgres)', () => {
  let dataSource: DataSource;
  let expenseGroups: Repository<ExpenseGroup>;
  let couples: Repository<Couple>;
  let users: Repository<User>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    expenseGroups = dataSource.getRepository(ExpenseGroup);
    couples = dataSource.getRepository(Couple);
    users = dataSource.getRepository(User);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query(
      'TRUNCATE TABLE "group_members", "expense_groups" RESTART IDENTITY CASCADE;',
    );
    await dataSource.query(
      'TRUNCATE TABLE "participants", "couple_invitations", "couple_members", "couples" RESTART IDENTITY CASCADE;',
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

  it('rejects colors that do not match hex pattern', async () => {
    const owner = await createUser('owner@example.com');
    const couple = await createCouple(owner.id);

    await expect(
      expenseGroups.save(
        expenseGroups.create({
          coupleId: couple.id,
          name: 'Bad Color',
          createdBy: owner.id,
          color: '#12345',
        }),
      ),
    ).rejects.toThrow(/CHK_expense_groups_color/i);
  });

  it('rejects default currency values that are not uppercase ISO codes', async () => {
    const owner = await createUser('owner2@example.com');
    const couple = await createCouple(owner.id);

    await expect(
      expenseGroups.save(
        expenseGroups.create({
          coupleId: couple.id,
          name: 'Travel',
          createdBy: owner.id,
          defaultCurrency: 'usd',
        }),
      ),
    ).rejects.toThrow(/CHK_expense_groups_currency/i);
  });

  it('marks groups as deleted via softRemove while keeping archived flag intact', async () => {
    const owner = await createUser('softdelete@example.com');
    const couple = await createCouple(owner.id);

    const group = await expenseGroups.save(
      expenseGroups.create({
        coupleId: couple.id,
        name: 'Weekend Adventures',
        createdBy: owner.id,
      }),
    );

    await expenseGroups.softRemove(group);

    const activeGroups = await expenseGroups.find({
      where: { coupleId: couple.id },
    });
    expect(activeGroups).toHaveLength(0);

    const withDeleted = await expenseGroups.find({
      where: { coupleId: couple.id },
      withDeleted: true,
    });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).toBeInstanceOf(Date);
    expect(withDeleted[0]?.isArchived).toBe(false);
  });
});
