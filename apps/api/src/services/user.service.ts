import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { Entities } from '../entities/runtime-entities';
import {
  RegisterDeviceDto,
  UpdateDeviceSyncDto,
  UpdateUserProfileDto,
  UpdateUserSettingsDto,
  UserDeviceResponse,
  UserProfileResponse,
  UserSettingsResponse,
  UserSummary,
} from '../dto/user.dto';
import {
  ApiBadRequestException,
  ApiNotFoundException,
} from '../common/api-error';

const defaultNotifications = () => ({
  expenses: true,
  invites: true,
  reminders: true,
});

const ALLOWED_PERSISTENCE_MODES = ['local_only', 'cloud_sync'] as const;
export type PersistenceMode = (typeof ALLOWED_PERSISTENCE_MODES)[number];
type UserEntity = InstanceType<typeof Entities.User>;
type UserSettingsEntity = InstanceType<typeof Entities.UserSettings>;
type UserDeviceEntity = InstanceType<typeof Entities.UserDevice>;

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(Entities.User)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(Entities.UserSettings)
    private readonly userSettingsRepository: Repository<UserSettingsEntity>,
    @InjectRepository(Entities.UserDevice)
    private readonly userDeviceRepository: Repository<UserDeviceEntity>,
  ) {}

  async getUserProfile(userId: string): Promise<UserProfileResponse> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new ApiNotFoundException('USER_NOT_FOUND', 'User not found');
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
      throw new ApiNotFoundException('USER_NOT_FOUND', 'User not found');
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

  async updateUserSettings(
    userId: string,
    payload: UpdateUserSettingsDto,
  ): Promise<UserSettingsResponse> {
    const settings = await this.getOrCreateUserSettings(userId);

    if (payload.language) {
      settings.language = payload.language;
    }

    if (typeof payload.pushEnabled === 'boolean') {
      settings.pushEnabled = payload.pushEnabled;
    }

    if (payload.notifications) {
      const current = {
        ...defaultNotifications(),
        ...(settings.notifications ?? {}),
      };

      if (typeof payload.notifications.expenses === 'boolean') {
        current.expenses = payload.notifications.expenses;
      }

      if (typeof payload.notifications.invites === 'boolean') {
        current.invites = payload.notifications.invites;
      }

      if (typeof payload.notifications.reminders === 'boolean') {
        current.reminders = payload.notifications.reminders;
      }

      settings.notifications = current;
    }

    const saved = await this.userSettingsRepository.save(settings);
    return this.mapSettings(saved);
  }

  async updatePersistenceMode(
    userId: string,
    mode: PersistenceMode,
  ): Promise<{ settings: UserSettingsResponse; changedAt: Date }> {
    if (!ALLOWED_PERSISTENCE_MODES.includes(mode)) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
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

  async listDevices(userId: string): Promise<UserDeviceResponse[]> {
    const devices = await this.userDeviceRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });

    return devices.map((device) => this.mapDevice(device));
  }

  async registerDevice(
    userId: string,
    payload: RegisterDeviceDto,
  ): Promise<UserDeviceResponse> {
    const deviceUuid = payload.deviceUuid.trim();

    if (!deviceUuid) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Device UUID is required',
        { field: 'deviceUuid' },
      );
    }

    let device = await this.userDeviceRepository.findOne({
      where: { userId, deviceUuid },
    });

    if (!device) {
      device = this.userDeviceRepository.create({
        userId,
        deviceUuid,
      });
    }

    if (payload.deviceName !== undefined) {
      device.deviceName = payload.deviceName || undefined;
    }

    if (payload.platform !== undefined) {
      device.platform = payload.platform || undefined;
    }

    if (payload.appVersion !== undefined) {
      device.appVersion = payload.appVersion || undefined;
    }

    if (payload.persistenceModeAtSync) {
      device.persistenceModeAtSync = payload.persistenceModeAtSync;
    }

    if (!device.persistenceModeAtSync) {
      device.persistenceModeAtSync = 'local_only';
    }

    device.syncStatus = device.syncStatus ?? 'idle';

    const saved = await this.userDeviceRepository.save(device);
    return this.mapDevice(saved);
  }

  async updateDevice(
    userId: string,
    deviceUuid: string,
    payload: UpdateDeviceSyncDto,
  ): Promise<UserDeviceResponse> {
    const normalizedDeviceUuid = deviceUuid.trim();

    if (!normalizedDeviceUuid) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Device identifier is required',
        { field: 'deviceUuid' },
      );
    }

    const device = await this.userDeviceRepository.findOne({
      where: { userId, deviceUuid: normalizedDeviceUuid },
    });

    if (!device) {
      throw new ApiNotFoundException('DEVICE_NOT_FOUND', 'Device not found', {
        field: 'deviceUuid',
      });
    }

    if (payload.persistenceModeAtSync) {
      device.persistenceModeAtSync = payload.persistenceModeAtSync;
    }

    if (payload.syncStatus) {
      device.syncStatus = payload.syncStatus;
    }

    if (payload.lastSyncAt) {
      device.lastSyncAt = new Date(payload.lastSyncAt);
    }

    if (payload.lastSnapshotHash !== undefined) {
      device.lastSnapshotHash = payload.lastSnapshotHash || undefined;
    }

    if (payload.lastError !== undefined) {
      device.lastError = payload.lastError || undefined;
    }

    const saved = await this.userDeviceRepository.save(device);
    return this.mapDevice(saved);
  }

  async removeDevice(userId: string, deviceUuid: string): Promise<void> {
    const normalizedDeviceUuid = deviceUuid.trim();

    if (!normalizedDeviceUuid) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Device identifier is required',
        { field: 'deviceUuid' },
      );
    }

    const device = await this.userDeviceRepository.findOne({
      where: { userId, deviceUuid: normalizedDeviceUuid },
    });

    if (!device) {
      return;
    }

    await this.userDeviceRepository.remove(device);
  }

  async searchUsers(
    requestingUserId: string,
    query: string,
    limit = 10,
  ): Promise<UserSummary[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Search query is required',
        { field: 'q' },
      );
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
      notifications: {
        ...defaultNotifications(),
        ...(settings.notifications ?? {}),
      },
      pushEnabled: settings.pushEnabled,
      persistenceMode: settings.persistenceMode,
      lastPersistenceChange: (
        settings.lastPersistenceChange || new Date()
      ).toISOString(),
    };
  }

  private mapDevice(device: UserDeviceEntity): UserDeviceResponse {
    const toIso = (input?: Date | string | null): string | null => {
      if (!input) {
        return null;
      }

      if (input instanceof Date) {
        return input.toISOString();
      }

      const parsed = new Date(input);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    };

    return {
      id: device.id,
      deviceUuid: device.deviceUuid,
      deviceName: device.deviceName ?? null,
      platform: device.platform ?? null,
      appVersion: device.appVersion ?? null,
      persistenceModeAtSync: device.persistenceModeAtSync,
      syncStatus: device.syncStatus ?? 'idle',
      lastSyncAt: toIso(device.lastSyncAt),
      lastSnapshotHash: device.lastSnapshotHash ?? null,
      lastError: device.lastError ?? null,
      createdAt: toIso(device.createdAt) ?? new Date().toISOString(),
      updatedAt: toIso(device.updatedAt) ?? new Date().toISOString(),
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
        throw new ApiNotFoundException('USER_NOT_FOUND', 'User not found');
      }

      settings = this.userSettingsRepository.create({
        user,
        userId: user.id,
        language: 'en-US',
        notifications: defaultNotifications(),
        pushEnabled: true,
        persistenceMode: 'local_only',
        lastPersistenceChange: new Date(),
      });

      settings = await this.userSettingsRepository.save(settings);
    }

    if (!settings.notifications) {
      settings.notifications = defaultNotifications();
    }

    return settings;
  }
}
