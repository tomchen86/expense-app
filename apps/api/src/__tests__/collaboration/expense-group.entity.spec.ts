import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { ExpenseGroupSimple } from '../../entities/expense-group-simple.entity';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';

describe('ExpenseGroup Entity (sql.js)', () => {
  let dataSource: DataSource;
  let expenseGroups: Repository<ExpenseGroupSimple>;
  let couples: Repository<CoupleSimple>;
  let users: Repository<UserSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    expenseGroups = dataSource.getRepository(ExpenseGroupSimple);
    couples = dataSource.getRepository(CoupleSimple);
    users = dataSource.getRepository(UserSimple);
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

  const createCouple = async (creatorId: string) =>
    couples.save(
      couples.create({
        inviteCode: `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        createdBy: creatorId,
      }),
    );

  it('persists with defaults and optional fields', async () => {
    const owner = await createUser('owner@example.com');
    const couple = await createCouple(owner.id);

    const group = await expenseGroups.save(
      expenseGroups.create({
        coupleId: couple.id,
        name: 'Household',
        createdBy: owner.id,
        color: '#ABCDEF',
      }),
    );

    expect(group.isArchived).toBe(false);
    expect(group.defaultCurrency).toBeNull();
  });

  it('rejects invalid color values via check constraint', async () => {
    const owner = await createUser('color@example.com');
    const couple = await createCouple(owner.id);

    await expect(
      expenseGroups.save(
        expenseGroups.create({
          coupleId: couple.id,
          name: 'Invalid Color',
          createdBy: owner.id,
          color: 'blue',
        }),
      ),
    ).rejects.toThrow();
  });
});
