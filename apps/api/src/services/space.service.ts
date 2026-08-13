import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  ApiBadRequestException,
  ApiConflictException,
  ApiForbiddenException,
  ApiNotFoundException,
} from '../common/api-error';
import {
  CreateSpaceDto,
  SpaceMemberResponse,
  SpaceResponse,
} from '../dto/space.dto';
import { LedgerService, SpaceKind } from './ledger.service';

type SpaceEntity = InstanceType<typeof Entities.Couple>;
type SpaceMemberEntity = InstanceType<typeof Entities.CoupleMember>;
type UserEntity = InstanceType<typeof Entities.User>;
type ParticipantEntity = InstanceType<typeof Entities.Participant>;

const DEFAULT_PARTICIPANT_NOTIFICATIONS = {
  expenses: true,
  invites: true,
  reminders: true,
};

@Injectable()
export class SpaceService {
  constructor(
    @InjectRepository(Entities.Couple)
    private readonly spaceRepository: Repository<SpaceEntity>,
    @InjectRepository(Entities.CoupleMember)
    private readonly memberRepository: Repository<SpaceMemberEntity>,
    @InjectRepository(Entities.User)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(Entities.Participant)
    private readonly participantRepository: Repository<ParticipantEntity>,
    private readonly ledgerService: LedgerService,
  ) {}

  async listSpacesForUser(userId: string): Promise<SpaceResponse[]> {
    await this.ledgerService.resolveSpaceForUser(userId);

    const memberships = await this.memberRepository.find({
      where: { userId, status: 'active' },
      order: { joinedAt: 'ASC' },
    });

    if (memberships.length === 0) {
      return [];
    }

    const spaces = await this.spaceRepository.find({
      where: {
        id: In(memberships.map((membership) => membership.coupleId)),
        status: 'active',
      },
    });
    const byId = new Map(
      spaces
        .filter(
          (space) =>
            this.readKind(space) === 'shared' || space.createdBy === userId,
        )
        .map((space) => [space.id, space]),
    );
    const participants = await this.participantRepository.find({
      where: {
        coupleId: In(memberships.map((membership) => membership.coupleId)),
        userId,
        deletedAt: IsNull(),
      },
    });
    const participantIdBySpace = new Map(
      participants.map((participant) => [participant.coupleId, participant.id]),
    );

    const resolvedSpaces = await Promise.all(
      memberships.map(async (membership) => {
        const space = byId.get(membership.coupleId);
        if (!space) {
          return undefined;
        }
        const currentParticipantId =
          participantIdBySpace.get(membership.coupleId) ??
          (await this.ensureCurrentParticipantId(userId, membership.coupleId));
        return this.mapSpace(space, membership.role, currentParticipantId);
      }),
    );

    return resolvedSpaces.filter(
      (space): space is SpaceResponse => space !== undefined,
    );
  }

  async createSharedSpace(
    userId: string,
    payload: CreateSpaceDto,
  ): Promise<SpaceResponse> {
    const name = payload.name.trim();
    if (!name) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Space name is required',
        { field: 'name' },
      );
    }

    const requestedUserIds = Array.from(
      new Set([userId, ...(payload.member_user_ids ?? [])]),
    );
    const users = await this.userRepository.find({
      where: { id: In(requestedUserIds) },
    });
    if (users.length !== requestedUserIds.length) {
      throw new ApiBadRequestException(
        'INVALID_SPACE_MEMBERS',
        'One or more space members do not exist',
        { field: 'member_user_ids' },
      );
    }

    const savedSpace = await this.spaceRepository.manager.transaction(
      async (manager) => {
        const spaces = manager.getRepository(Entities.Couple);
        const members = manager.getRepository(Entities.CoupleMember);
        const participants = manager.getRepository(Entities.Participant);

        const space = spaces.create();
        space.name = name;
        space.inviteCode = this.generateInviteCode();
        space.status = 'active';
        space.createdBy = userId;
        Object.assign(space, {
          kind: 'shared' satisfies SpaceKind,
          syncPolicy: 'cloud_sync' as const,
        });
        const createdSpace = await spaces.save(space);

        await members.save(
          users.map((user) => {
            const membership = members.create();
            membership.coupleId = createdSpace.id;
            membership.userId = user.id;
            membership.role = user.id === userId ? 'owner' : 'member';
            membership.status = 'active';
            return membership;
          }),
        );

        const savedParticipants = await participants.save(
          users.map((user) => {
            const participant = participants.create();
            participant.coupleId = createdSpace.id;
            participant.userId = user.id;
            participant.displayName = user.displayName;
            participant.email = user.email;
            participant.isRegistered = true;
            participant.defaultCurrency = user.defaultCurrency;
            participant.notificationPreferences = {
              ...DEFAULT_PARTICIPANT_NOTIFICATIONS,
            };
            return participant;
          }),
        );

        const creatorParticipant = savedParticipants.find(
          (participant) => participant.userId === userId,
        );
        if (!creatorParticipant) {
          throw new Error('Creator participant was not created');
        }

        return {
          space: createdSpace,
          currentParticipantId: creatorParticipant.id,
        };
      },
    );

    await this.ledgerService.resolveSpaceForUser(userId, savedSpace.space.id, {
      ensureDefaultCategories: true,
    });

    return this.mapSpace(
      savedSpace.space,
      'owner',
      savedSpace.currentParticipantId,
    );
  }

  async addAccountMember(
    requestingUserId: string,
    spaceId: string,
    targetUserId: string,
  ): Promise<SpaceMemberResponse> {
    const ownerMembership = await this.memberRepository.findOne({
      where: {
        coupleId: spaceId,
        userId: requestingUserId,
        status: 'active',
      },
    });

    if (!ownerMembership) {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }
    if (ownerMembership.role !== 'owner') {
      throw new ApiForbiddenException(
        'SPACE_OWNER_REQUIRED',
        'Only a space owner can add account members',
      );
    }

    const space = await this.spaceRepository.findOne({
      where: { id: spaceId, status: 'active' },
    });
    if (!space || this.readKind(space) !== 'shared') {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }

    const user = await this.userRepository.findOne({
      where: { id: targetUserId },
    });
    if (!user) {
      throw new ApiNotFoundException('USER_NOT_FOUND', 'User not found');
    }

    const result = await this.spaceRepository.manager.transaction(
      async (manager) => {
        const members = manager.getRepository(Entities.CoupleMember);
        const participants = manager.getRepository(Entities.Participant);

        let membership = await members.findOne({
          where: { coupleId: spaceId, userId: targetUserId },
        });
        if (!membership) {
          membership = members.create();
          membership.coupleId = spaceId;
          membership.userId = targetUserId;
          membership.role = 'member';
        }
        membership.status = 'active';
        await members.save(membership);

        let participant = await participants.findOne({
          where: { coupleId: spaceId, userId: targetUserId },
          withDeleted: true,
        });
        if (!participant) {
          participant = participants.create();
          participant.coupleId = spaceId;
          participant.userId = targetUserId;
        }
        participant.displayName = user.displayName;
        participant.email = user.email;
        participant.isRegistered = true;
        participant.defaultCurrency = user.defaultCurrency;
        participant.notificationPreferences =
          participant.notificationPreferences ?? {
            ...DEFAULT_PARTICIPANT_NOTIFICATIONS,
          };
        participant.deletedAt = undefined;
        const savedParticipant = await participants.save(participant);

        return { membership, participant: savedParticipant };
      },
    );

    return {
      userId: targetUserId,
      participantId: result.participant.id,
      role: result.membership.role,
      status: 'active',
    };
  }

  async updateSyncPolicy(
    requestingUserId: string,
    spaceId: string,
    syncPolicy: 'local_only' | 'cloud_sync',
  ): Promise<SpaceResponse> {
    const membership = await this.memberRepository.findOne({
      where: {
        coupleId: spaceId,
        userId: requestingUserId,
        status: 'active',
      },
    });
    if (!membership) {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }
    if (membership.role !== 'owner') {
      throw new ApiForbiddenException(
        'SPACE_OWNER_REQUIRED',
        'Only a space owner can change its sync policy',
      );
    }

    const space = await this.spaceRepository.findOne({
      where: { id: spaceId, status: 'active' },
    });
    if (!space) {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }
    const kind = this.readKind(space);
    if (kind === 'personal' && space.createdBy !== requestingUserId) {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }
    if (syncPolicy === 'local_only' && kind === 'shared') {
      throw new ApiBadRequestException(
        'SHARED_SPACE_REQUIRES_CLOUD_SYNC',
        'Shared spaces require cloud synchronization',
        { field: 'sync_policy' },
      );
    }
    if (
      syncPolicy === 'local_only' &&
      kind === 'personal' &&
      space.syncPolicy === 'cloud_sync'
    ) {
      throw new ApiConflictException(
        'SYNC_POLICY_HANDOFF_REQUIRED',
        'Cloud sync can be disabled only after a complete local replica is acknowledged',
        { field: 'sync_policy' },
      );
    }

    const currentParticipantId = await this.ensureCurrentParticipantId(
      requestingUserId,
      spaceId,
    );
    space.syncPolicy = syncPolicy;
    const savedSpace = await this.spaceRepository.save(space);
    return this.mapSpace(savedSpace, membership.role, currentParticipantId);
  }

  private mapSpace(
    space: SpaceEntity,
    role: SpaceMemberEntity['role'],
    currentParticipantId: string,
  ): SpaceResponse {
    const kind = this.readKind(space);
    return {
      id: space.id,
      currentParticipantId,
      name:
        space.name ??
        (kind === 'personal' ? 'Personal Ledger' : 'Shared Space'),
      kind,
      role,
      status: 'active',
      syncPolicy: space.syncPolicy,
      createdAt: this.toIso(space.createdAt),
      updatedAt: this.toIso(space.updatedAt),
    };
  }

  private async ensureCurrentParticipantId(
    userId: string,
    spaceId: string,
  ): Promise<string> {
    const participant = await this.participantRepository.findOne({
      where: { coupleId: spaceId, userId, deletedAt: IsNull() },
    });
    if (participant) {
      return participant.id;
    }

    const resolved = await this.ledgerService.resolveSpaceForUser(
      userId,
      spaceId,
      { ensureParticipant: true },
    );
    if (!resolved.participantId) {
      throw new Error('Current participant was not resolved');
    }
    return resolved.participantId;
  }

  private readKind(space: SpaceEntity): SpaceKind {
    return (space as SpaceEntity & { kind?: SpaceKind }).kind === 'shared'
      ? 'shared'
      : 'personal';
  }

  private toIso(value: Date | undefined): string {
    return value instanceof Date
      ? value.toISOString()
      : new Date(0).toISOString();
  }

  private generateInviteCode(): string {
    return randomBytes(8)
      .toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 10)
      .padEnd(10, 'X');
  }
}
