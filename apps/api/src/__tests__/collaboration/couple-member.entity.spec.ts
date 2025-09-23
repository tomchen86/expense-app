import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { CoupleMemberSimple } from '../../entities/couple-member-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';

describe('CoupleMember Entity (sql.js)', () => {
  let dataSource: DataSource;
  let couples: Repository<CoupleSimple>;
  let coupleMembers: Repository<CoupleMemberSimple>;
  let users: Repository<UserSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    couples = dataSource.getRepository(CoupleSimple);
    coupleMembers = dataSource.getRepository(CoupleMemberSimple);
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

  it('defaults role to member and status to active', async () => {
    const owner = await createUser('owner@example.com');
    const member = await createUser('member@example.com');
    const couple = await createCouple(owner.id);

    const result = await coupleMembers.save(
      coupleMembers.create({ coupleId: couple.id, userId: member.id }),
    );

    expect(result.role).toBe('member');
    expect(result.status).toBe('active');
    expect(result.joinedAt).toBeInstanceOf(Date);
  });

  it('enforces uniqueness per couple and user combination', async () => {
    const owner = await createUser('owner2@example.com');
    const member = await createUser('member2@example.com');
    const couple = await createCouple(owner.id);

    await coupleMembers.save(
      coupleMembers.create({ coupleId: couple.id, userId: member.id }),
    );

    await expect(
      coupleMembers.insert({ coupleId: couple.id, userId: member.id }),
    ).rejects.toThrow();
  });
});
