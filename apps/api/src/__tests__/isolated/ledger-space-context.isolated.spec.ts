import { ObjectLiteral, Repository } from 'typeorm';
import { LedgerService } from '../../services/ledger.service';
import { Entities } from '../../entities/runtime-entities';
import { ApiNotFoundException } from '../../common/api-error';

type RepositoryMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

const repositoryMock = (): RepositoryMock => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn((value = {}) => ({ ...value })),
  save: jest.fn(async (value) => value),
  createQueryBuilder: jest.fn(),
});

const asRepository = <T extends ObjectLiteral>(
  mock: RepositoryMock,
): Repository<T> => mock as unknown as Repository<T>;

describe('LedgerService explicit space context', () => {
  const coupleRepository = repositoryMock();
  const membershipRepository = repositoryMock();
  const participantRepository = repositoryMock();
  const userRepository = repositoryMock();
  const categoryRepository = repositoryMock();

  const service = new LedgerService(
    asRepository<InstanceType<typeof Entities.Couple>>(coupleRepository),
    asRepository<InstanceType<typeof Entities.CoupleMember>>(
      membershipRepository,
    ),
    asRepository<InstanceType<typeof Entities.Participant>>(
      participantRepository,
    ),
    asRepository<InstanceType<typeof Entities.User>>(userRepository),
    asRepository<InstanceType<typeof Entities.Category>>(categoryRepository),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    membershipRepository.find.mockResolvedValue([]);
    membershipRepository.findOne.mockResolvedValue(null);
    coupleRepository.findOne.mockResolvedValue(null);
    participantRepository.findOne.mockResolvedValue(null);
    categoryRepository.createQueryBuilder.mockReturnValue({
      withDeleted: () => ({
        where: () => ({
          getCount: async () => 1,
        }),
      }),
    });
  });

  it('resolves the exact requested active space instead of the earliest membership', async () => {
    membershipRepository.findOne.mockResolvedValue({
      coupleId: 'shared-space-2',
      userId: 'user-1',
      status: 'active',
    });
    coupleRepository.findOne.mockResolvedValue({
      id: 'shared-space-2',
      kind: 'shared',
      status: 'active',
    });

    await expect(
      service.resolveSpaceForUser('user-1', 'shared-space-2'),
    ).resolves.toMatchObject({
      spaceId: 'shared-space-2',
      coupleId: 'shared-space-2',
      kind: 'shared',
    });

    expect(membershipRepository.findOne).toHaveBeenCalledWith({
      where: {
        coupleId: 'shared-space-2',
        userId: 'user-1',
        status: 'active',
      },
    });
  });

  it('rejects a requested space without an active membership', async () => {
    await expect(
      service.resolveSpaceForUser('user-1', 'private-space'),
    ).rejects.toBeInstanceOf(ApiNotFoundException);

    expect(coupleRepository.findOne).not.toHaveBeenCalled();
  });

  it("rejects explicit access to another creator's personal space", async () => {
    membershipRepository.findOne.mockResolvedValue({
      coupleId: 'foreign-personal-space',
      userId: 'user-1',
      status: 'active',
    });
    coupleRepository.findOne.mockResolvedValue({
      id: 'foreign-personal-space',
      kind: 'personal',
      createdBy: 'user-2',
      status: 'active',
    });

    await expect(
      service.resolveSpaceForUser('user-1', 'foreign-personal-space'),
    ).rejects.toBeInstanceOf(ApiNotFoundException);
  });

  it('selects a personal space by kind rather than membership join time', async () => {
    membershipRepository.find.mockResolvedValue([
      {
        coupleId: 'old-shared-space',
        userId: 'user-1',
        status: 'active',
        joinedAt: new Date('2020-01-01'),
      },
      {
        coupleId: 'personal-space',
        userId: 'user-1',
        status: 'active',
        joinedAt: new Date('2024-01-01'),
      },
    ]);
    coupleRepository.find.mockResolvedValue([
      {
        id: 'old-shared-space',
        kind: 'shared',
        status: 'active',
      },
      {
        id: 'personal-space',
        kind: 'personal',
        createdBy: 'user-1',
        status: 'active',
      },
    ]);

    await expect(service.resolveSpaceForUser('user-1')).resolves.toMatchObject({
      spaceId: 'personal-space',
      kind: 'personal',
    });

    expect(coupleRepository.find).toHaveBeenCalledWith({
      where: {
        id: expect.anything(),
        status: 'active',
      },
    });
  });

  it("does not resolve another creator's personal space", async () => {
    membershipRepository.find.mockResolvedValue([
      {
        coupleId: 'foreign-personal-space',
        userId: 'user-1',
        status: 'active',
        joinedAt: new Date('2020-01-01'),
      },
      {
        coupleId: 'own-personal-space',
        userId: 'user-1',
        status: 'active',
        joinedAt: new Date('2024-01-01'),
      },
    ]);
    coupleRepository.find.mockResolvedValue([
      {
        id: 'foreign-personal-space',
        kind: 'personal',
        createdBy: 'user-2',
        status: 'active',
      },
      {
        id: 'own-personal-space',
        kind: 'personal',
        createdBy: 'user-1',
        status: 'active',
      },
    ]);

    await expect(service.resolveSpaceForUser('user-1')).resolves.toMatchObject({
      spaceId: 'own-personal-space',
      kind: 'personal',
    });
  });

  it('marks an API-provisioned personal space as cloud synchronized', async () => {
    coupleRepository.create.mockReturnValue({});
    coupleRepository.save.mockImplementation(async (space) => ({
      ...space,
      id: 'personal-space',
    }));

    await service.resolveSpaceForUser('user-1');

    expect(coupleRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'personal',
        syncPolicy: 'cloud_sync',
      }),
    );
  });
});
