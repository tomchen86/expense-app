import { DataSource } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import {
  seedDefaultCategories,
  defaultCategories,
} from '../../database/seeds/default-categories.seed';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';
import { Category } from '../../entities/category.entity';

jest.setTimeout(45000);

describe('seedDefaultCategories', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
    await dataSource.query(
      'TRUNCATE TABLE "expense_attachments", "expense_splits", "expenses", "categories" RESTART IDENTITY CASCADE;',
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

  const createUserAndCouple = async () => {
    const userRepo = dataSource.getRepository(User);
    const coupleRepo = dataSource.getRepository(Couple);

    const user = await userRepo.save(
      userRepo.create({
        email: 'seed@example.com',
        passwordHash: 'hash',
        displayName: 'Seeder',
      }),
    );

    const couple = await coupleRepo.save(
      coupleRepo.create({ inviteCode: 'SEED12345', createdBy: user.id }),
    );

    return { user, couple };
  };

  it('inserts default categories for a couple and is idempotent', async () => {
    const { couple, user } = await createUserAndCouple();
    const categoryRepo = dataSource.getRepository(Category);

    await seedDefaultCategories(dataSource, {
      coupleId: couple.id,
      createdBy: user.id,
    });

    const firstRun = await categoryRepo.find({
      where: { coupleId: couple.id },
    });
    expect(firstRun).toHaveLength(defaultCategories.length);

    await seedDefaultCategories(dataSource, {
      coupleId: couple.id,
      createdBy: user.id,
    });

    const secondRun = await categoryRepo.find({
      where: { coupleId: couple.id },
    });
    expect(secondRun).toHaveLength(defaultCategories.length);
  });

  it('supports overriding default category set', async () => {
    const { couple } = await createUserAndCouple();
    const categoryRepo = dataSource.getRepository(Category);

    await seedDefaultCategories(dataSource, {
      coupleId: couple.id,
      categories: [{ name: 'Custom Only', color: '#123456' }],
    });

    const categories = await categoryRepo.find({
      where: { coupleId: couple.id },
    });
    expect(categories).toHaveLength(1);
    expect(categories[0]?.name).toBe('Custom Only');
  });
});
