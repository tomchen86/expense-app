import { ObjectLiteral, Repository } from 'typeorm';
import { SpaceService } from '../../services/space.service';
import { Entities } from '../../entities/runtime-entities';
import { LedgerService } from '../../services/ledger.service';
import { ApiForbiddenException } from '../../common/api-error';

type RepositoryMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
};

const repositoryMock = (): RepositoryMock => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn((value = {}) => ({ ...value })),
  save: jest.fn((value) => Promise.resolve(value)),
});

const asRepository = <T extends ObjectLiteral>(
  value: RepositoryMock,
): Repository<T> => value as unknown as Repository<T>;

describe('SpaceService', () => {
  const spaceRepository = repositoryMock();
  const memberRepository = repositoryMock();
  const userRepository = repositoryMock();
  const participantRepository = repositoryMock();
  const ledgerService = {
    getDefaultCategories: jest.fn(() => []),
    resolveSpaceForUser: jest.fn(),
  } as unknown as LedgerService;

  const service = new SpaceService(
    asRepository<InstanceType<typeof Entities.Couple>>(spaceRepository),
    asRepository<InstanceType<typeof Entities.CoupleMember>>(memberRepository),
    asRepository<InstanceType<typeof Entities.User>>(userRepository),
    asRepository<InstanceType<typeof Entities.Participant>>(
      participantRepository,
    ),
    ledgerService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    memberRepository.find.mockResolvedValue([]);
    memberRepository.findOne.mockResolvedValue(null);
    spaceRepository.find.mockResolvedValue([]);
    spaceRepository.findOne.mockResolvedValue(null);
    userRepository.find.mockResolvedValue([]);
    userRepository.findOne.mockResolvedValue(null);
    participantRepository.find.mockResolvedValue([]);
    participantRepository.findOne.mockResolvedValue({
      id: 'current-participant',
      coupleId: 'personal-1',
      userId: 'user-1',
    });
  });

  it('lists every active personal and shared space with its membership role', async () => {
    memberRepository.find.mockResolvedValue([
      {
        coupleId: 'personal-1',
        userId: 'user-1',
        role: 'owner',
        status: 'active',
        joinedAt: new Date('2024-01-01'),
      },
      {
        coupleId: 'trip-1',
        userId: 'user-1',
        role: 'member',
        status: 'active',
        joinedAt: new Date('2024-02-01'),
      },
    ]);
    spaceRepository.find.mockResolvedValue([
      {
        id: 'personal-1',
        name: 'Personal Ledger',
        kind: 'personal',
        createdBy: 'user-1',
        syncPolicy: 'cloud_sync',
        status: 'active',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
      {
        id: 'trip-1',
        name: 'Japan Trip',
        kind: 'shared',
        syncPolicy: 'cloud_sync',
        status: 'active',
        createdAt: new Date('2024-02-01'),
        updatedAt: new Date('2024-02-01'),
      },
    ]);
    participantRepository.find.mockResolvedValue([
      {
        id: 'participant-personal-1',
        coupleId: 'personal-1',
        userId: 'user-1',
      },
      {
        id: 'participant-trip-1',
        coupleId: 'trip-1',
        userId: 'user-1',
      },
    ]);

    await expect(service.listSpacesForUser('user-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'personal-1',
        currentParticipantId: 'participant-personal-1',
        kind: 'personal',
        role: 'owner',
        syncPolicy: 'cloud_sync',
      }),
      expect.objectContaining({
        id: 'trip-1',
        currentParticipantId: 'participant-trip-1',
        kind: 'shared',
        role: 'member',
        syncPolicy: 'cloud_sync',
      }),
    ]);
    expect(participantRepository.find).toHaveBeenCalledTimes(1);
  });

  it('returns the creator participant ID when it creates a shared space', async () => {
    const transaction = jest.fn((callback: (manager: unknown) => unknown) =>
      Promise.resolve().then(() =>
        callback({
          getRepository: (entity: unknown) => {
            if (entity === Entities.Couple) {
              return {
                create: jest.fn(() => ({})),
                save: jest.fn((space) =>
                  Promise.resolve({
                    ...space,
                    id: 'trip-new',
                    createdAt: new Date('2024-03-01'),
                    updatedAt: new Date('2024-03-01'),
                  }),
                ),
              };
            }
            if (entity === Entities.CoupleMember) {
              return {
                create: jest.fn(() => ({})),
                save: jest.fn((members) => Promise.resolve(members)),
              };
            }
            return {
              create: jest.fn(() => ({})),
              save: jest.fn((participants: Array<{ userId: string }>) =>
                Promise.resolve().then(() =>
                  participants.map((participant) => ({
                    ...participant,
                    id:
                      participant.userId === 'user-1'
                        ? 'participant-creator'
                        : 'participant-friend',
                  })),
                ),
              ),
            };
          },
        }),
      ),
    );
    Object.assign(spaceRepository, { manager: { transaction } });
    userRepository.find.mockResolvedValue([
      {
        id: 'user-1',
        displayName: 'Creator',
        email: 'creator@example.com',
        defaultCurrency: 'AUD',
      },
      {
        id: 'user-2',
        displayName: 'Friend',
        email: 'friend@example.com',
        defaultCurrency: 'AUD',
      },
    ]);

    await expect(
      service.createSharedSpace('user-1', {
        name: 'Japan Trip',
        member_user_ids: ['user-2'],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'trip-new',
        currentParticipantId: 'participant-creator',
      }),
    );
  });

  it('does not let an ordinary member add another account', async () => {
    memberRepository.findOne.mockResolvedValue({
      coupleId: 'trip-1',
      userId: 'user-1',
      role: 'member',
      status: 'active',
    });

    await expect(
      service.addAccountMember('user-1', 'trip-1', 'user-2'),
    ).rejects.toBeInstanceOf(ApiForbiddenException);

    expect(memberRepository.save).not.toHaveBeenCalled();
  });

  it('rejects local-only policy for a shared space', async () => {
    memberRepository.findOne.mockResolvedValue({
      coupleId: 'trip-1',
      userId: 'user-1',
      role: 'owner',
      status: 'active',
    });
    spaceRepository.findOne.mockResolvedValue({
      id: 'trip-1',
      kind: 'shared',
      status: 'active',
    });

    await expect(
      service.updateSyncPolicy('user-1', 'trip-1', 'local_only'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({
          code: 'SHARED_SPACE_REQUIRES_CLOUD_SYNC',
        }),
      }),
    });
  });

  it('persists a personal-space sync policy instead of returning transient state', async () => {
    memberRepository.findOne.mockResolvedValue({
      coupleId: 'personal-1',
      userId: 'user-1',
      role: 'owner',
      status: 'active',
    });
    const space = {
      id: 'personal-1',
      name: 'Personal Ledger',
      kind: 'personal',
      createdBy: 'user-1',
      syncPolicy: 'local_only',
      status: 'active',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    };
    spaceRepository.findOne.mockResolvedValue(space);
    spaceRepository.save.mockImplementation((value) => Promise.resolve(value));

    await expect(
      service.updateSyncPolicy('user-1', 'personal-1', 'cloud_sync'),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'personal-1',
        currentParticipantId: 'current-participant',
        syncPolicy: 'cloud_sync',
      }),
    );

    expect(spaceRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ syncPolicy: 'cloud_sync' }),
    );
  });

  it('requires a completed replica handoff before cloud sync can be disabled', async () => {
    memberRepository.findOne.mockResolvedValue({
      coupleId: 'personal-1',
      userId: 'user-1',
      role: 'owner',
      status: 'active',
    });
    spaceRepository.findOne.mockResolvedValue({
      id: 'personal-1',
      kind: 'personal',
      createdBy: 'user-1',
      syncPolicy: 'cloud_sync',
      status: 'active',
    });

    await expect(
      service.updateSyncPolicy('user-1', 'personal-1', 'local_only'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({
          code: 'SYNC_POLICY_HANDOFF_REQUIRED',
        }),
      }),
    });

    expect(spaceRepository.save).not.toHaveBeenCalled();
  });

  it('lets only the space owner change its sync policy', async () => {
    memberRepository.findOne.mockResolvedValue({
      coupleId: 'personal-1',
      userId: 'user-1',
      role: 'member',
      status: 'active',
    });

    await expect(
      service.updateSyncPolicy('user-1', 'personal-1', 'cloud_sync'),
    ).rejects.toBeInstanceOf(ApiForbiddenException);

    expect(spaceRepository.findOne).not.toHaveBeenCalled();
    expect(spaceRepository.save).not.toHaveBeenCalled();
  });

  it('does not trust a stray owner membership on another account personal space', async () => {
    memberRepository.findOne.mockResolvedValue({
      coupleId: 'personal-2',
      userId: 'user-1',
      role: 'owner',
      status: 'active',
    });
    spaceRepository.findOne.mockResolvedValue({
      id: 'personal-2',
      kind: 'personal',
      createdBy: 'user-2',
      syncPolicy: 'cloud_sync',
      status: 'active',
    });

    await expect(
      service.updateSyncPolicy('user-1', 'personal-2', 'cloud_sync'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: 'SPACE_NOT_FOUND' }),
      }),
    });

    expect(spaceRepository.save).not.toHaveBeenCalled();
  });
});
