import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  defaultCategories,
  DefaultCategory,
} from '../database/seeds/default-categories.seed';
import { ApiNotFoundException } from '../common/api-error';

const DEFAULT_PARTICIPANT_NOTIFICATIONS = {
  expenses: true,
  invites: true,
  reminders: true,
};

type CategoryEntity = InstanceType<typeof Entities.Category>;
type CoupleEntity = InstanceType<typeof Entities.Couple>;
type CoupleMemberEntity = InstanceType<typeof Entities.CoupleMember>;
type ParticipantEntity = InstanceType<typeof Entities.Participant>;
type UserEntity = InstanceType<typeof Entities.User>;

type CoupleMemberStatus = CoupleMemberEntity['status'];

export type SpaceKind = 'personal' | 'shared';
export type SpaceRole = 'owner' | 'member';

type EnsureLedgerOptions = {
  ensureDefaultCategories?: boolean;
  ensureParticipant?: boolean;
};

export type ResolvedSpace = {
  spaceId: string;
  /** Legacy persistence name retained until the physical table migration. */
  coupleId: string;
  kind: SpaceKind;
  role: SpaceRole;
  participantId?: string;
};

@Injectable()
export class LedgerService {
  constructor(
    @InjectRepository(Entities.Couple)
    private readonly coupleRepository: Repository<CoupleEntity>,
    @InjectRepository(Entities.CoupleMember)
    private readonly coupleMemberRepository: Repository<CoupleMemberEntity>,
    @InjectRepository(Entities.Participant)
    private readonly participantRepository: Repository<ParticipantEntity>,
    @InjectRepository(Entities.User)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(Entities.Category)
    private readonly categoryRepository: Repository<CategoryEntity>,
  ) {}

  async ensureLedgerForUser(
    userId: string,
    options: EnsureLedgerOptions = {},
  ): Promise<ResolvedSpace> {
    return this.resolveSpaceForUser(userId, undefined, options);
  }

  /**
   * Resolves either the exact requested space or the user's personal space.
   * Callers must never infer context from membership order.
   */
  async resolveSpaceForUser(
    userId: string,
    requestedSpaceId?: string,
    options: EnsureLedgerOptions = {},
  ): Promise<ResolvedSpace> {
    const authorized = requestedSpaceId
      ? await this.getAuthorizedSpace(userId, requestedSpaceId)
      : {
          space: await this.ensurePersonalSpaceForUser(userId),
          role: 'owner' as const,
        };
    const { space, role } = authorized;
    const coupleId = space.id;

    let participantId: string | undefined;
    if (options.ensureParticipant) {
      const participant = await this.ensureParticipantForUser(userId, coupleId);
      participantId = participant.id;
    }

    if (options.ensureDefaultCategories) {
      await this.ensureDefaultCategoriesForCouple(coupleId, userId);
    }

    return {
      spaceId: coupleId,
      coupleId,
      kind: this.readSpaceKind(space),
      role,
      participantId,
    };
  }

  getDefaultCategories(): DefaultCategory[] {
    return defaultCategories;
  }

  private async getAuthorizedSpace(
    userId: string,
    spaceId: string,
  ): Promise<{ space: CoupleEntity; role: SpaceRole }> {
    const membership = await this.coupleMemberRepository.findOne({
      where: {
        coupleId: spaceId,
        userId,
        status: 'active' as CoupleMemberStatus,
      },
    });

    if (!membership) {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }

    const space = await this.coupleRepository.findOne({
      where: { id: spaceId, status: 'active' },
    });

    if (!space) {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }

    if (
      this.readSpaceKind(space) === 'personal' &&
      space.createdBy !== userId
    ) {
      throw new ApiNotFoundException('SPACE_NOT_FOUND', 'Space not found');
    }

    return { space, role: membership.role as SpaceRole };
  }

  private async ensurePersonalSpaceForUser(
    userId: string,
  ): Promise<CoupleEntity> {
    const activeMemberships = await this.coupleMemberRepository.find({
      where: { userId, status: 'active' as CoupleMemberStatus },
      order: { joinedAt: 'ASC' },
    });

    if (activeMemberships.length > 0) {
      const spaces = await this.coupleRepository.find({
        where: {
          id: In(activeMemberships.map((membership) => membership.coupleId)),
          status: 'active',
        },
      });
      const personalSpace = spaces.find(
        (candidate) =>
          this.readSpaceKind(candidate) === 'personal' &&
          candidate.createdBy === userId,
      );

      if (personalSpace) {
        return personalSpace;
      }
    }

    const couple = this.coupleRepository.create();
    couple.name = 'Personal Ledger';
    couple.inviteCode = this.generateInviteCode();
    couple.status = 'active';
    couple.createdBy = userId;
    Object.assign(couple, {
      kind: 'personal' satisfies SpaceKind,
      // Reaching this constructor means the account is already using the
      // cloud API. Device-only personal spaces exist only in the client until
      // an explicit adoption/link flow creates their cloud replica.
      syncPolicy: 'cloud_sync' as const,
    });

    let savedCouple: CoupleEntity;
    try {
      savedCouple = await this.coupleRepository.save(couple);
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        const existing = await this.coupleRepository.findOne({
          where: {
            createdBy: userId,
            kind: 'personal',
            status: 'active',
          },
        });
        if (existing) {
          const membership = await this.coupleMemberRepository.findOne({
            where: {
              coupleId: existing.id,
              userId,
              status: 'active' as CoupleMemberStatus,
            },
          });
          if (!membership) {
            const ownerMembership = this.coupleMemberRepository.create();
            ownerMembership.coupleId = existing.id;
            ownerMembership.userId = userId;
            ownerMembership.role = 'owner';
            ownerMembership.status = 'active';
            await this.coupleMemberRepository.save(ownerMembership);
          }
          return existing;
        }
      }
      throw error;
    }

    const membership = this.coupleMemberRepository.create();
    membership.coupleId = savedCouple.id;
    membership.userId = userId;
    membership.role = 'owner';
    membership.status = 'active';

    await this.coupleMemberRepository.save(membership);

    return savedCouple;
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

  private readSpaceKind(space: CoupleEntity): SpaceKind {
    const kind = (space as CoupleEntity & { kind?: SpaceKind }).kind;
    return kind === 'shared' ? 'shared' : 'personal';
  }

  private async ensureParticipantForUser(
    userId: string,
    coupleId: string,
  ): Promise<ParticipantEntity> {
    const existing = await this.participantRepository.findOne({
      where: { coupleId, userId },
      withDeleted: true,
    });

    if (existing) {
      if (existing.deletedAt) {
        existing.deletedAt = undefined;
        existing.notificationPreferences = existing.notificationPreferences || {
          ...DEFAULT_PARTICIPANT_NOTIFICATIONS,
        };
        await this.participantRepository.save(existing);
      }
      return existing;
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });

    const participant = this.participantRepository.create();
    participant.coupleId = coupleId;
    participant.userId = userId;
    participant.displayName = user?.displayName ?? 'You';
    participant.email = user?.email ?? undefined;
    participant.isRegistered = true;
    participant.defaultCurrency = user?.defaultCurrency ?? 'USD';
    participant.notificationPreferences = {
      ...DEFAULT_PARTICIPANT_NOTIFICATIONS,
    };

    return await this.participantRepository.save(participant);
  }

  private async ensureDefaultCategoriesForCouple(
    coupleId: string,
    userId: string,
  ): Promise<void> {
    const existingCount = await this.categoryRepository
      .createQueryBuilder('category')
      .withDeleted()
      .where('category.coupleId = :coupleId', { coupleId })
      .getCount();

    if (existingCount > 0) {
      return;
    }

    const categories = defaultCategories.map((definition) => {
      const category = this.categoryRepository.create();
      category.coupleId = coupleId;
      category.createdBy = userId;
      category.name = definition.name;
      category.color = definition.color;
      category.icon = definition.icon ?? null;
      category.isDefault = true;
      return category;
    });

    await this.categoryRepository.save(categories);
  }

  private generateInviteCode(): string {
    const random = Math.random().toString(36).toUpperCase().slice(2, 10);
    return random.padEnd(10, 'X').slice(0, 10);
  }
}
