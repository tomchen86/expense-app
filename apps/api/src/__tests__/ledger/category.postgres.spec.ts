import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { Category } from '../../entities/category.entity';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';

jest.setTimeout(45000);

describe('Category Entity (Postgres)', () => {
  let dataSource: DataSource;
  let categories: Repository<Category>;
  let couples: Repository<Couple>;
  let users: Repository<User>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    categories = dataSource.getRepository(Category);
    couples = dataSource.getRepository(Couple);
    users = dataSource.getRepository(User);
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

  it('enforces case-insensitive uniqueness for category names per couple', async () => {
    const user = await createUser('owner@example.com');
    const couple = await createCouple(user.id);

    await categories.save(
      categories.create({
        coupleId: couple.id,
        name: 'Utilities',
        color: '#ABCDEF',
      }),
    );

    await expect(
      categories.save(
        categories.create({
          coupleId: couple.id,
          name: 'utilities',
          color: '#FEDCBA',
        }),
      ),
    ).rejects.toThrow(/uq_categories_couple_name/i);
  });

  it('rejects colors that do not meet hex pattern', async () => {
    const user = await createUser('owner2@example.com');
    const couple = await createCouple(user.id);

    await expect(
      categories.save(
        categories.create({
          coupleId: couple.id,
          name: 'Travel',
          color: 'blue',
        }),
      ),
    ).rejects.toThrow(/CHK_categories_color/i);
  });

  it('supports soft deleting categories via TypeORM softRemove', async () => {
    const user = await createUser('softdelete@example.com');
    const couple = await createCouple(user.id);

    const category = await categories.save(
      categories.create({
        coupleId: couple.id,
        name: 'Temp Category',
        color: '#123456',
      }),
    );

    await categories.softRemove(category);

    const active = await categories.find({ where: { coupleId: couple.id } });
    expect(active).toHaveLength(0);

    const withDeleted = await categories.find({
      where: { coupleId: couple.id },
      withDeleted: true,
    });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).toBeInstanceOf(Date);
  });
});
