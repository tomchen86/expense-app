import { DataSource, Repository } from 'typeorm';
import { createSqliteDataSource } from '../setup/datasource.factory';
import { CoupleSimple } from '../../entities/couple-simple.entity';
import { ParticipantSimple } from '../../entities/participant-simple.entity';
import { UserSimple } from '../../entities/user-simple.entity';

describe('Participant Entity (sql.js)', () => {
  let dataSource: DataSource;
  let participants: Repository<ParticipantSimple>;
  let couples: Repository<CoupleSimple>;
  let users: Repository<UserSimple>;

  beforeEach(async () => {
    dataSource = await createSqliteDataSource();
    await dataSource.initialize();
    participants = dataSource.getRepository(ParticipantSimple);
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

  it('stores default notification preferences for external participants', async () => {
    const owner = await createUser('owner@example.com');
    const couple = await createCouple(owner.id);

    const participant = await participants.save(
      participants.create({
        coupleId: couple.id,
        displayName: 'Roommate',
        email: 'roommate@example.com',
      }),
    );

    expect(participant.isRegistered).toBe(false);
    expect(participant.defaultCurrency).toBe('USD');
    expect(participant.notificationPreferences).toEqual({
      expenses: true,
      invites: true,
      reminders: true,
    });
  });

  it('enforces unique participants per couple and user', async () => {
    const owner = await createUser('owner2@example.com');
    const member = await createUser('member@example.com');
    const couple = await createCouple(owner.id);

    await participants.save(
      participants.create({
        coupleId: couple.id,
        userId: member.id,
        displayName: 'Member One',
        isRegistered: true,
      }),
    );

    await expect(
      participants.save(
        participants.create({
          coupleId: couple.id,
          userId: member.id,
          displayName: 'Member Duplicate',
          isRegistered: true,
        }),
      ),
    ).rejects.toThrow();
  });
});
