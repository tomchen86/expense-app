import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ObjectLiteral, Repository } from 'typeorm';
import { ApiConflictException } from '../../common/api-error';
import { CreateParticipantDto } from '../../dto/participant.dto';
import { Entities } from '../../entities/runtime-entities';
import { LedgerService } from '../../services/ledger.service';
import { ParticipantService } from '../../services/participant.service';

type RepositoryMock = {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
};

const repositoryMock = (): RepositoryMock => ({
  findOne: jest.fn(),
  create: jest.fn(() => ({})),
  save: jest.fn(async (value) => value),
});

const asRepository = <T extends ObjectLiteral>(
  value: RepositoryMock,
): Repository<T> => value as unknown as Repository<T>;

describe('Participant client identity', () => {
  const participantRepository = repositoryMock();
  const groupMemberRepository = repositoryMock();
  const ledgerService = {
    resolveSpaceForUser: jest.fn(),
  } as unknown as LedgerService;
  const service = new ParticipantService(
    asRepository<InstanceType<typeof Entities.Participant>>(
      participantRepository,
    ),
    asRepository<InstanceType<typeof Entities.GroupMember>>(
      groupMemberRepository,
    ),
    ledgerService,
  );
  const participantId = 'f3af3622-e6b6-4a70-8cf6-a81b8fa675a5';

  beforeEach(() => {
    jest.clearAllMocks();
    participantRepository.findOne.mockResolvedValue(null);
    (ledgerService.resolveSpaceForUser as jest.Mock).mockResolvedValue({
      coupleId: 'space-1',
      participantId: 'self-participant',
    });
  });

  it('accepts an optional client-generated v4 UUID', () => {
    const dto = plainToInstance(CreateParticipantDto, {
      id: participantId,
      name: 'Alex',
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect((dto as CreateParticipantDto & { id?: string }).id).toBe(
      participantId,
    );
  });

  it('rejects a non-UUID client ID', () => {
    const dto = plainToInstance(CreateParticipantDto, {
      id: 'participant-local-1',
      name: 'Alex',
    });

    expect(validateSync(dto)).toEqual([
      expect.objectContaining({ property: 'id' }),
    ]);
  });

  it('preserves a new client-generated participant ID', async () => {
    await service.createParticipantForUser(
      'user-1',
      { id: participantId, name: ' Alex ' } as CreateParticipantDto,
      'space-1',
    );

    expect(participantRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: participantId,
        coupleId: 'space-1',
        displayName: 'Alex',
      }),
    );
  });

  it('returns an exact same-space retry without inserting again', async () => {
    participantRepository.findOne.mockResolvedValue({
      id: participantId,
      coupleId: 'space-1',
      userId: undefined,
      displayName: 'Alex',
      email: 'alex@example.com',
      isRegistered: false,
      defaultCurrency: 'AUD',
      notificationPreferences: {
        expenses: true,
        invites: false,
        reminders: true,
      },
      deletedAt: undefined,
    });

    await expect(
      service.createParticipantForUser(
        'user-1',
        {
          id: participantId,
          name: ' Alex ',
          email: 'alex@example.com',
          defaultCurrency: 'AUD',
          notifications: { invites: false },
        } as CreateParticipantDto,
        'space-1',
      ),
    ).resolves.toEqual(expect.objectContaining({ id: participantId }));
    expect(participantRepository.save).not.toHaveBeenCalled();
  });

  it('converges on the existing participant after a concurrent ID insert', async () => {
    const existingParticipant = {
      id: participantId,
      coupleId: 'space-1',
      userId: undefined,
      displayName: 'Alex',
      email: undefined,
      isRegistered: false,
      defaultCurrency: 'USD',
      notificationPreferences: {
        expenses: true,
        invites: true,
        reminders: true,
      },
      deletedAt: undefined,
    };
    participantRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingParticipant);
    participantRepository.save.mockRejectedValueOnce({ code: '23505' });

    await expect(
      service.createParticipantForUser(
        'user-1',
        { id: participantId, name: 'Alex' } as CreateParticipantDto,
        'space-1',
      ),
    ).resolves.toEqual(expect.objectContaining({ id: participantId }));
  });

  it('conflicts when the client ID belongs to another space', async () => {
    participantRepository.findOne.mockResolvedValue({
      id: participantId,
      coupleId: 'space-2',
      displayName: 'Alex',
      isRegistered: false,
      defaultCurrency: 'USD',
      notificationPreferences: {
        expenses: true,
        invites: true,
        reminders: true,
      },
    });

    await expect(
      service.createParticipantForUser(
        'user-1',
        { id: participantId, name: 'Alex' } as CreateParticipantDto,
        'space-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: 'PARTICIPANT_ID_CONFLICT' }),
      }),
    });
    expect(participantRepository.save).not.toHaveBeenCalled();
  });

  it('conflicts when a same-space retry changes participant identity', async () => {
    participantRepository.findOne.mockResolvedValue({
      id: participantId,
      coupleId: 'space-1',
      userId: undefined,
      displayName: 'Alex',
      email: undefined,
      isRegistered: false,
      defaultCurrency: 'USD',
      notificationPreferences: {
        expenses: true,
        invites: true,
        reminders: true,
      },
      deletedAt: undefined,
    });

    await expect(
      service.createParticipantForUser(
        'user-1',
        { id: participantId, name: 'Different name' } as CreateParticipantDto,
        'space-1',
      ),
    ).rejects.toBeInstanceOf(ApiConflictException);
    expect(participantRepository.save).not.toHaveBeenCalled();
  });
});
