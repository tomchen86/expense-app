import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  UpdateUserProfileDto,
  UserProfileResponse,
  UserSettingsResponse,
  UserSummary,
} from '../dto/user.dto';

const DEFAULT_NOTIFICATIONS = {
  expenses: true,
  invites: true,
  reminders: true,
};

const ALLOWED_PERSISTENCE_MODES = ['local_only', 'cloud_sync'] as const;
export type PersistenceMode = (typeof ALLOWED_PERSISTENCE_MODES)[number];

type UserEntity = InstanceType<typeof Entities.User>;
type UserSettingsEntity = InstanceType<typeof Entities.UserSettings>;

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(Entities.User)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(Entities.UserSettings)
    private readonly userSettingsRepository: Repository<UserSettingsEntity>,
  ) {}

  async getUserProfile(userId: string): Promise<UserProfileResponse> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const settings = await this.getOrCreateUserSettings(userId);

    return {
      user: this.mapUserToProfile(user),
      settings: this.mapSettings(settings),
    };
  }

  async updateUserProfile(
    userId: string,
    payload: UpdateUserProfileDto,
  ): Promise<UserProfileResponse['user']> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (payload.defaultCurrency) {
      user.defaultCurrency = payload.defaultCurrency;
    }

    if (payload.displayName) {
      user.displayName = payload.displayName.trim();
    }

    if (payload.timezone) {
      user.timezone = payload.timezone;
    }

    if (payload.avatarUrl !== undefined) {
      user.avatarUrl = payload.avatarUrl || null;
    }

    const updatedUser = await this.userRepository.save(user);

    return this.mapUserToProfile(updatedUser);
  }

  async getUserSettings(userId: string): Promise<UserSettingsResponse> {
    const settings = await this.getOrCreateUserSettings(userId);
    return this.mapSettings(settings);
  }

  async updatePersistenceMode(
    userId: string,
    mode: PersistenceMode,
  ): Promise<{ settings: UserSettingsResponse; changedAt: Date }> {
    if (!ALLOWED_PERSISTENCE_MODES.includes(mode)) {
      throw new BadRequestException(
        'Persistence mode must be local_only or cloud_sync',
      );
    }

    const settings = await this.getOrCreateUserSettings(userId);

    if (settings.persistenceMode !== mode) {
      settings.persistenceMode = mode;
      settings.lastPersistenceChange = new Date();
      await this.userSettingsRepository.save(settings);
    }

    return {
      settings: this.mapSettings(settings),
      changedAt: settings.lastPersistenceChange,
    };
  }

  async searchUsers(
    requestingUserId: string,
    query: string,
    limit = 10,
  ): Promise<UserSummary[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new BadRequestException('Search query is required');
    }

    const finalLimit = Math.max(1, Math.min(limit, 25));

    const users = await this.userRepository.find({
      where: [
        { displayName: Like(`%${trimmedQuery}%`) },
        { email: Like(`%${trimmedQuery}%`) },
      ],
      take: finalLimit,
      order: {
        displayName: 'ASC',
      },
    });

    return users
      .filter((user) => user.id !== requestingUserId)
      .map((user) => this.mapUserToSummary(user));
  }

  private mapUserToProfile(user: UserEntity): UserProfileResponse['user'] {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? null,
      defaultCurrency: user.defaultCurrency ?? 'USD',
      timezone: user.timezone ?? 'UTC',
    };
  }

  private mapUserToSummary(user: UserEntity): UserSummary {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? null,
      defaultCurrency: user.defaultCurrency ?? 'USD',
      timezone: user.timezone ?? 'UTC',
    };
  }

  private mapSettings(settings: UserSettingsEntity): UserSettingsResponse {
    return {
      language: settings.language,
      notifications: settings.notifications ?? DEFAULT_NOTIFICATIONS,
      pushEnabled: settings.pushEnabled,
      persistenceMode: settings.persistenceMode,
      lastPersistenceChange: (
        settings.lastPersistenceChange || new Date()
      ).toISOString(),
    };
  }

  private async getOrCreateUserSettings(
    userId: string,
  ): Promise<UserSettingsEntity> {
    let settings = await this.userSettingsRepository.findOne({
      where: { userId },
    });

    if (!settings) {
      const user = await this.userRepository.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException('User not found');
      }

      settings = this.userSettingsRepository.create({
        user,
        userId: user.id,
        language: 'en-US',
        notifications: DEFAULT_NOTIFICATIONS,
        pushEnabled: true,
        persistenceMode: 'local_only',
        lastPersistenceChange: new Date(),
      });

      settings = await this.userSettingsRepository.save(settings);
    }

    if (!settings.notifications) {
      settings.notifications = DEFAULT_NOTIFICATIONS;
    }

    return settings;
  }
}
