import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { CategorySimple } from '../../entities/category-simple.entity';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';

describe('Category Entity (sql.js)', () => {
  let dataSource: DataSource;
  let categories: Repository<CategorySimple>;
  let couples: Repository<CoupleSimple>;
  let users: Repository<UserSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    categories = dataSource.getRepository(CategorySimple);
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

  const createCouple = async (createdBy: string) =>
    couples.save(
      couples.create({
        inviteCode: `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        createdBy,
      }),
    );

  it('stores required fields with defaults', async () => {
    const user = await createUser('owner@example.com');
    const couple = await createCouple(user.id);

    const category = await categories.save(
      categories.create({
        coupleId: couple.id,
        name: 'Groceries',
        color: '#34A853',
      }),
    );

    expect(category.isDefault).toBe(false);
    expect(category.createdAt).toBeInstanceOf(Date);
    expect(category.updatedAt).toBeInstanceOf(Date);
  });

  it('enforces unique names per couple even with same casing', async () => {
    const user = await createUser('owner2@example.com');
    const couple = await createCouple(user.id);

    await categories.save(
      categories.create({
        coupleId: couple.id,
        name: 'Dining Out',
        color: '#123456',
      }),
    );

    await expect(
      categories.insert({
        coupleId: couple.id,
        name: 'Dining Out',
        color: '#654321',
      }),
    ).rejects.toThrow();
  });
});
