import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  defaultCategories,
  DefaultCategory,
} from '../database/seeds/default-categories.seed';

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

type CoupleStatus = CoupleEntity['status'];
type CoupleMemberStatus = CoupleMemberEntity['status'];
type CoupleMemberRole = CoupleMemberEntity['role'];

type EnsureLedgerOptions = {
  ensureDefaultCategories?: boolean;
  ensureParticipant?: boolean;
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
  ): Promise<{ coupleId: string; participantId?: string }> {
    const coupleId = await this.ensureCoupleForUser(userId);

    let participantId: string | undefined;
    if (options.ensureParticipant) {
      const participant = await this.ensureParticipantForUser(userId, coupleId);
      participantId = participant.id;
    }

    if (options.ensureDefaultCategories) {
      await this.ensureDefaultCategoriesForCouple(coupleId, userId);
    }

    return { coupleId, participantId };
  }

  getDefaultCategories(): DefaultCategory[] {
    return defaultCategories;
  }

  private async ensureCoupleForUser(userId: string): Promise<string> {
    const existingMembership = await this.coupleMemberRepository.findOne({
      where: { userId, status: 'active' as CoupleMemberStatus },
      order: { joinedAt: 'ASC' },
    });

    if (existingMembership) {
      return existingMembership.coupleId;
    }

    const couple = this.coupleRepository.create();
    couple.name = 'Personal Ledger';
    couple.inviteCode = this.generateInviteCode();
    couple.status = 'active' as CoupleStatus;
    couple.createdBy = userId;

    const savedCouple = await this.coupleRepository.save(couple);

    const membership = this.coupleMemberRepository.create();
    membership.coupleId = savedCouple.id;
    membership.userId = userId;
    membership.role = 'owner' as CoupleMemberRole;
    membership.status = 'active' as CoupleMemberStatus;

    await this.coupleMemberRepository.save(membership);

    return savedCouple.id;
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
