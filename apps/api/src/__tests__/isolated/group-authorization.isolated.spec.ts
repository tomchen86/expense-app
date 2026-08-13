import { GroupService } from '../../services/group.service';
import { ApiForbiddenException } from '../../common/api-error';

const repository = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn((value = {}) => ({ ...value })),
  save: jest.fn((value) => Promise.resolve(value)),
  createQueryBuilder: jest.fn(),
});

describe('GroupService object-level authorization', () => {
  const groupRepository = repository();
  const memberRepository = repository();
  const participantRepository = repository();
  const ledgerService = {
    resolveSpaceForUser: jest.fn(() =>
      Promise.resolve({
        coupleId: 'space-1',
        spaceId: 'space-1',
        kind: 'shared',
        participantId: 'self-participant',
      }),
    ),
  };
  const participantService = {
    assertParticipantsBelongToCouple: jest.fn(),
    mapParticipantEntity: jest.fn(),
  };

  const service = new GroupService(
    groupRepository as never,
    memberRepository as never,
    participantRepository as never,
    ledgerService as never,
    participantService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    groupRepository.findOne.mockResolvedValue({
      id: 'group-1',
      coupleId: 'space-1',
      name: 'Trip',
      isArchived: false,
    });
    memberRepository.findOne.mockResolvedValue({
      groupId: 'group-1',
      participantId: 'self-participant',
      role: 'member',
      status: 'active',
    });
    memberRepository.find.mockResolvedValue([]);
    participantRepository.find.mockResolvedValue([]);
  });

  it('rejects update by a non-owner group member', async () => {
    await expect(
      service.updateGroupForUser(
        'user-1',
        'group-1',
        { name: 'Changed' },
        'space-1',
      ),
    ).rejects.toBeInstanceOf(ApiForbiddenException);

    expect(groupRepository.save).not.toHaveBeenCalled();
  });

  it('rejects deletion by a non-owner group member', async () => {
    await expect(
      service.deleteGroupForUser('user-1', 'group-1', 'space-1'),
    ).rejects.toBeInstanceOf(ApiForbiddenException);

    expect(groupRepository.save).not.toHaveBeenCalled();
  });

  it('persists the resolved space on every new group membership', async () => {
    const participants = [
      { id: 'self-participant', coupleId: 'space-1' },
      { id: 'friend-participant', coupleId: 'space-1' },
    ];
    participantService.assertParticipantsBelongToCouple.mockResolvedValue(
      participants,
    );
    participantService.mapParticipantEntity.mockImplementation(
      (participant) => participant,
    );
    groupRepository.create.mockReturnValue({});
    groupRepository.save.mockImplementation((group) =>
      Promise.resolve({
        ...group,
        id: 'group-1',
        createdAt: new Date('2026-08-13T00:00:00.000Z'),
        updatedAt: new Date('2026-08-13T00:00:00.000Z'),
      }),
    );
    memberRepository.create.mockImplementation(() => ({}));

    await service.createGroupForUser(
      'user-1',
      {
        name: 'Trip',
        participantIds: ['self-participant', 'friend-participant'],
      },
      'space-1',
    );

    expect(memberRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({
        coupleId: 'space-1',
        groupId: 'group-1',
        participantId: 'self-participant',
      }),
      expect.objectContaining({
        coupleId: 'space-1',
        groupId: 'group-1',
        participantId: 'friend-participant',
      }),
    ]);
  });
});
