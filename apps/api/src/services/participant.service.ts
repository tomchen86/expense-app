import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  CreateParticipantDto,
  ParticipantResponse,
  UpdateParticipantDto,
} from '../dto/participant.dto';
import {
  ApiBadRequestException,
  ApiConflictException,
  ApiNotFoundException,
} from '../common/api-error';
import { LedgerService } from './ledger.service';

const DEFAULT_NOTIFICATIONS = {
  expenses: true,
  invites: true,
  reminders: true,
};

type ParticipantEntity = InstanceType<typeof Entities.Participant>;
type GroupMemberEntity = InstanceType<typeof Entities.GroupMember>;

type NotificationPrefs = ParticipantEntity['notificationPreferences'];

@Injectable()
export class ParticipantService {
  constructor(
    @InjectRepository(Entities.Participant)
    private readonly participantRepository: Repository<ParticipantEntity>,
    @InjectRepository(Entities.GroupMember)
    private readonly groupMemberRepository: Repository<GroupMemberEntity>,
    private readonly ledgerService: LedgerService,
  ) {}

  async listParticipantsForUser(
    userId: string,
    spaceId?: string,
  ): Promise<ParticipantResponse[]> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      { ensureParticipant: true },
    );

    const participants = await this.participantRepository
      .createQueryBuilder('participant')
      .where('participant.coupleId = :coupleId', { coupleId })
      .andWhere('participant.deletedAt IS NULL')
      .orderBy('participant.displayName', 'ASC')
      .getMany();

    return participants.map((participant) => this.mapParticipant(participant));
  }

  async createParticipantForUser(
    userId: string,
    payload: CreateParticipantDto,
    spaceId?: string,
  ): Promise<ParticipantResponse> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      { ensureParticipant: true },
    );

    const normalizedName = payload.name.trim();
    if (!normalizedName) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Participant name is required',
        { field: 'name' },
      );
    }

    if (payload.id) {
      const existingById = await this.participantRepository.findOne({
        where: { id: payload.id },
        withDeleted: true,
      });
      if (existingById) {
        return this.resolveCreateReplay(
          existingById,
          coupleId,
          normalizedName,
          payload,
        );
      }
    }

    if (payload.email) {
      const existingWithEmail = await this.participantRepository.findOne({
        where: {
          coupleId,
          email: payload.email,
          deletedAt: IsNull(),
        },
      });

      if (existingWithEmail) {
        if (payload.id && existingWithEmail.id === payload.id) {
          return this.resolveCreateReplay(
            existingWithEmail,
            coupleId,
            normalizedName,
            payload,
          );
        }
        throw new ApiConflictException(
          'PARTICIPANT_EMAIL_EXISTS',
          'A participant with this email already exists',
          { field: 'email' },
        );
      }
    }

    const participant = this.participantRepository.create();
    if (payload.id) {
      participant.id = payload.id;
    }
    participant.coupleId = coupleId;
    participant.userId = undefined;
    participant.displayName = normalizedName;
    participant.email = payload.email ?? undefined;
    participant.isRegistered = false;
    participant.defaultCurrency = payload.defaultCurrency ?? 'USD';
    participant.notificationPreferences = this.mergeNotifications(
      undefined,
      payload.notifications,
    );

    try {
      const saved = await this.participantRepository.save(participant);
      return this.mapParticipant(saved);
    } catch (error) {
      if (payload.id && this.isUniqueConstraintViolation(error)) {
        const existingById = await this.participantRepository.findOne({
          where: { id: payload.id },
          withDeleted: true,
        });
        if (existingById) {
          return this.resolveCreateReplay(
            existingById,
            coupleId,
            normalizedName,
            payload,
          );
        }
      }
      throw error;
    }
  }

  async updateParticipantForUser(
    userId: string,
    participantId: string,
    payload: UpdateParticipantDto,
    spaceId?: string,
  ): Promise<ParticipantResponse> {
    const { coupleId } = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      { ensureParticipant: true },
    );

    const participant = await this.participantRepository.findOne({
      where: { id: participantId, coupleId },
      withDeleted: true,
    });

    if (!participant || participant.deletedAt) {
      throw new ApiNotFoundException(
        'PARTICIPANT_NOT_FOUND',
        'Participant not found',
      );
    }

    if (payload.name) {
      const normalizedName = payload.name.trim();
      if (!normalizedName) {
        throw new ApiBadRequestException(
          'VALIDATION_ERROR',
          'Participant name is required',
          { field: 'name' },
        );
      }
      participant.displayName = normalizedName;
    }

    if (payload.email !== undefined) {
      if (payload.email) {
        const existingWithEmail = await this.participantRepository.findOne({
          where: {
            coupleId,
            email: payload.email,
            deletedAt: IsNull(),
          },
        });

        if (existingWithEmail && existingWithEmail.id !== participant.id) {
          throw new ApiConflictException(
            'PARTICIPANT_EMAIL_EXISTS',
            'A participant with this email already exists',
            { field: 'email' },
          );
        }

        participant.email = payload.email;
      } else {
        participant.email = undefined;
      }
    }

    if (payload.defaultCurrency) {
      participant.defaultCurrency = payload.defaultCurrency;
    }

    if (payload.notifications) {
      participant.notificationPreferences = this.mergeNotifications(
        participant.notificationPreferences,
        payload.notifications,
      );
    }

    const saved = await this.participantRepository.save(participant);
    return this.mapParticipant(saved);
  }

  async deleteParticipantForUser(
    userId: string,
    participantId: string,
    spaceId?: string,
  ): Promise<void> {
    const { coupleId, participantId: selfParticipantId } =
      await this.ledgerService.resolveSpaceForUser(userId, spaceId, {
        ensureParticipant: true,
      });

    if (participantId === selfParticipantId) {
      throw new ApiBadRequestException(
        'CANNOT_REMOVE_SELF',
        'You cannot remove yourself from the ledger',
      );
    }

    const participant = await this.participantRepository.findOne({
      where: { id: participantId, coupleId },
    });

    if (!participant || participant.deletedAt) {
      throw new ApiNotFoundException(
        'PARTICIPANT_NOT_FOUND',
        'Participant not found',
      );
    }

    participant.deletedAt = new Date();
    await this.participantRepository.save(participant);

    const groupMemberships = await this.groupMemberRepository.find({
      where: { participantId },
    });

    if (groupMemberships.length > 0) {
      await this.groupMemberRepository.save(
        groupMemberships.map((membership) => {
          membership.status = 'left';
          return membership;
        }),
      );
    }
  }

  async assertParticipantsBelongToCouple(
    coupleId: string,
    participantIds: string[],
  ): Promise<ParticipantEntity[]> {
    if (participantIds.length === 0) {
      return [];
    }

    const participants = await this.participantRepository.find({
      where: {
        coupleId,
        id: In(participantIds),
        deletedAt: IsNull(),
      },
    });

    if (participants.length !== participantIds.length) {
      throw new ApiBadRequestException(
        'INVALID_PARTICIPANTS',
        'One or more participants are invalid for this ledger',
        { field: 'participantIds' },
      );
    }

    return participants;
  }

  private mergeNotifications(
    current: NotificationPrefs | undefined,
    updates: Partial<NotificationPrefs> | undefined,
  ): NotificationPrefs {
    const baseline = {
      ...DEFAULT_NOTIFICATIONS,
      ...(current ?? {}),
    };

    if (!updates) {
      return baseline;
    }

    const merged = { ...baseline };
    if (typeof updates.expenses === 'boolean') {
      merged.expenses = updates.expenses;
    }
    if (typeof updates.invites === 'boolean') {
      merged.invites = updates.invites;
    }
    if (typeof updates.reminders === 'boolean') {
      merged.reminders = updates.reminders;
    }

    return merged;
  }

  private resolveCreateReplay(
    participant: ParticipantEntity,
    coupleId: string,
    normalizedName: string,
    payload: CreateParticipantDto,
  ): ParticipantResponse {
    const requestedNotifications = this.mergeNotifications(
      undefined,
      payload.notifications,
    );
    const storedNotifications = this.mergeNotifications(
      undefined,
      participant.notificationPreferences,
    );
    const isExactReplay =
      participant.coupleId === coupleId &&
      !participant.deletedAt &&
      participant.userId == null &&
      participant.isRegistered === false &&
      participant.displayName === normalizedName &&
      (participant.email ?? undefined) === (payload.email ?? undefined) &&
      participant.defaultCurrency === (payload.defaultCurrency ?? 'USD') &&
      storedNotifications.expenses === requestedNotifications.expenses &&
      storedNotifications.invites === requestedNotifications.invites &&
      storedNotifications.reminders === requestedNotifications.reminders;

    if (!isExactReplay) {
      throw new ApiConflictException(
        'PARTICIPANT_ID_CONFLICT',
        'Participant ID is already in use by a different participant',
        { field: 'id' },
      );
    }

    return this.mapParticipant(participant);
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const candidate = error as { code?: unknown; message?: unknown };
    return (
      candidate.code === '23505' ||
      (typeof candidate.message === 'string' &&
        /duplicate key|unique constraint failed/i.test(candidate.message))
    );
  }

  private mapParticipant(participant: ParticipantEntity): ParticipantResponse {
    const prefs = participant.notificationPreferences || DEFAULT_NOTIFICATIONS;

    return {
      id: participant.id,
      name: participant.displayName,
      email: participant.email ?? null,
      avatar: null,
      isRegistered: participant.isRegistered ?? false,
      defaultCurrency: participant.defaultCurrency ?? 'USD',
      lastActiveAt: null,
      notifications: {
        expenses: prefs.expenses ?? true,
        invites: prefs.invites ?? true,
        reminders: prefs.reminders ?? true,
      },
    };
  }

  mapParticipantEntity(participant: ParticipantEntity): ParticipantResponse {
    return this.mapParticipant(participant);
  }
}
