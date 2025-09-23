import { DataSource, Repository } from 'typeorm';
import { createPostgresDataSource } from '../setup/datasource.factory';
import { Participant } from '../../entities/participant.entity';
import { Couple } from '../../entities/couple.entity';
import { User } from '../../entities/user.entity';

jest.setTimeout(45000);

describe('Participant Entity (Postgres)', () => {
  let dataSource: DataSource;
  let participants: Repository<Participant>;
  let couples: Repository<Couple>;
  let users: Repository<User>;

  beforeAll(async () => {
    dataSource = await createPostgresDataSource();
    participants = dataSource.getRepository(Participant);
    couples = dataSource.getRepository(Couple);
    users = dataSource.getRepository(User);
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }
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

  it('prevents marking participant as registered without a linked user', async () => {
    const owner = await createUser('owner@example.com');
    const couple = await createCouple(owner.id);

    await expect(
      participants.save(
        participants.create({
          coupleId: couple.id,
          displayName: 'Ghost',
          isRegistered: true,
        }),
      ),
    ).rejects.toThrow(/CHK_participants_registered_user/i);
  });

  it('rejects invalid default currency values via regex check', async () => {
    const owner = await createUser('owner2@example.com');
    const couple = await createCouple(owner.id);

    await expect(
      participants.save(
        participants.create({
          coupleId: couple.id,
          displayName: 'Traveler',
          defaultCurrency: 'usd',
        }),
      ),
    ).rejects.toThrow(/CHK_participants_currency/i);
  });

  it('soft deletes participants using TypeORM softRemove', async () => {
    const owner = await createUser('softdelete@example.com');
    const couple = await createCouple(owner.id);

    const participant = await participants.save(
      participants.create({
        coupleId: couple.id,
        displayName: 'External Friend',
        email: 'friend@example.com',
      }),
    );

    await participants.softRemove(participant);

    const active = await participants.find({ where: { coupleId: couple.id } });
    expect(active).toHaveLength(0);

    const withDeleted = await participants.find({
      where: { coupleId: couple.id },
      withDeleted: true,
    });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).toBeInstanceOf(Date);
  });
});
