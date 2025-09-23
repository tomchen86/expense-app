import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';

describe('Couple Entity (sql.js)', () => {
  let dataSource: DataSource;
  let couples: Repository<CoupleSimple>;
  let users: Repository<UserSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    couples = dataSource.getRepository(CoupleSimple);
    users = dataSource.getRepository(UserSimple);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  const createUser = async (overrides: Partial<UserSimple> = {}) =>
    users.save(
      users.create({
        email: overrides.email ?? `user-${Math.random()}@example.com`,
        passwordHash: 'hash',
        displayName: overrides.displayName ?? 'Owner',
      }),
    );

  it('persists couples with defaults and creator reference', async () => {
    const creator = await createUser();

    const couple = await couples.save(
      couples.create({ inviteCode: 'CODE123456', createdBy: creator.id }),
    );

    expect(couple.id).toBeDefined();
    expect(couple.status).toBe('active');
    expect(couple.createdAt).toBeInstanceOf(Date);
    expect(couple.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects duplicate invite codes', async () => {
    const creator = await createUser();

    await couples.save(
      couples.create({ inviteCode: 'CODE999999', createdBy: creator.id }),
    );

    await expect(
      couples.save(
        couples.create({ inviteCode: 'CODE999999', createdBy: creator.id }),
      ),
    ).rejects.toThrow();
  });
});
