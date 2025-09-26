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

type GroupMemberStatus = GroupMemberEntity['status'];

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
  ): Promise<ParticipantResponse[]> {
    const { coupleId } = await this.ledgerService.ensureLedgerForUser(userId, {
      ensureParticipant: true,
    });

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
  ): Promise<ParticipantResponse> {
    const { coupleId } = await this.ledgerService.ensureLedgerForUser(userId, {
      ensureParticipant: true,
    });

    const normalizedName = payload.name.trim();
    if (!normalizedName) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Participant name is required',
        { field: 'name' },
      );
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
        throw new ApiConflictException(
          'PARTICIPANT_EMAIL_EXISTS',
          'A participant with this email already exists',
          { field: 'email' },
        );
      }
    }

    const participant = this.participantRepository.create();
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

    const saved = await this.participantRepository.save(participant);
    return this.mapParticipant(saved);
  }

  async updateParticipantForUser(
    userId: string,
    participantId: string,
    payload: UpdateParticipantDto,
  ): Promise<ParticipantResponse> {
    const { coupleId } = await this.ledgerService.ensureLedgerForUser(userId, {
      ensureParticipant: true,
    });

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
  ): Promise<void> {
    const { coupleId, participantId: selfParticipantId } =
      await this.ledgerService.ensureLedgerForUser(userId, {
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
          membership.status = 'left' as GroupMemberStatus;
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
