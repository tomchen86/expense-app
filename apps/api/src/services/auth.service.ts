// Authentication Service - Mobile-First TDD Implementation
// GREEN Phase: Business logic to support the controller

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../entities/user.entity';
import { UserSettings } from '../entities/user-settings.entity';

interface RegisterResult {
  user: User;
  accessToken: string;
  refreshToken: string;
}

interface LoginResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  settings?: {
    preferredCurrency: string;
    dateFormat: string;
    defaultSplitMethod: string;
    persistenceMode: string;
  };
}

interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

interface UserWithSettings {
  user: User;
  settings?: {
    preferredCurrency: string;
    dateFormat: string;
    defaultSplitMethod: string;
    persistenceMode: string;
  };
}

interface PersistenceUpdateResult {
  settings: {
    preferredCurrency: string;
    dateFormat: string;
    defaultSplitMethod: string;
    persistenceMode: string;
  };
  persistenceChangeTimestamp: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserSettings)
    private readonly userSettingsRepository: Repository<UserSettings>,
    private readonly jwtService: JwtService,
  ) {}

  async register(
    email: string,
    password: string,
    displayName: string,
  ): Promise<RegisterResult> {
    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { email },
    });
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = new User();
    user.email = email;
    user.passwordHash = passwordHash;
    user.displayName = displayName;
    user.defaultCurrency = 'USD';
    user.timezone = 'UTC';
    user.onboardingStatus = 'completed';

    const savedUser = await this.userRepository.save(user);

    // Create default user settings (mobile app starts with local_only)
    const settings = new UserSettings();
    settings.user = savedUser;
    settings.userId = savedUser.id;
    settings.language = 'en-US';
    settings.persistenceMode = 'local_only';
    settings.pushEnabled = true;

    await this.userSettingsRepository.save(settings);

    // Generate tokens
    const tokens = await this.generateTokens(savedUser);

    return {
      user: savedUser,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    // Find user with settings
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new Error('Invalid credentials');
    }

    // Get user settings
    const userSettings = await this.userSettingsRepository.findOne({
      where: { userId: user.id },
    });

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      settings: userSettings
        ? {
            preferredCurrency: 'USD', // Hardcoded for now to match mobile expectations
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: userSettings.persistenceMode,
          }
        : undefined,
    };
  }

  async refreshToken(refreshToken: string): Promise<RefreshResult> {
    try {
      // Verify the refresh token
      const payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET || 'development-refresh-secret',
      });

      // Get user
      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
      });
      if (!user) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Generate new tokens
      const tokens = await this.generateTokens(user);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async getUserWithSettings(userId: string): Promise<UserWithSettings> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new Error('User not found');
    }

    const userSettings = await this.userSettingsRepository.findOne({
      where: { userId },
    });

    return {
      user,
      settings: userSettings
        ? {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: userSettings.persistenceMode,
          }
        : undefined,
    };
  }

  async updatePersistenceMode(
    userId: string,
    persistenceMode: 'local_only' | 'cloud_sync',
    deviceId?: string,
  ): Promise<PersistenceUpdateResult> {
    // Get or create user settings
    let userSettings = await this.userSettingsRepository.findOne({
      where: { userId },
    });

    if (!userSettings) {
      const user = await this.userRepository.findOne({ where: { id: userId } });
      if (!user) {
        throw new Error('User not found');
      }

      userSettings = new UserSettings();
      userSettings.user = user;
      userSettings.userId = userId;
      userSettings.language = 'en-US';
      userSettings.pushEnabled = true;
    }

    // Update persistence mode
    userSettings.persistenceMode = persistenceMode;
    userSettings.lastPersistenceChange = new Date();

    const savedSettings = await this.userSettingsRepository.save(userSettings);

    return {
      settings: {
        preferredCurrency: 'USD',
        dateFormat: 'MM/DD/YYYY',
        defaultSplitMethod: 'equal',
        persistenceMode: savedSettings.persistenceMode,
      },
      persistenceChangeTimestamp:
        savedSettings.lastPersistenceChange.toISOString(),
    };
  }

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.userRepository.findOne({ where: { email } });
    if (user && (await bcrypt.compare(password, user.passwordHash))) {
      return user;
    }
    return null;
  }

  private async generateTokens(
    user: User,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = {
      email: user.email,
      sub: user.id,
      displayName: user.displayName,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret:
        process.env.JWT_SECRET || 'development-secret-change-in-production',
      expiresIn: '15m', // Short-lived access token
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET || 'development-refresh-secret',
      expiresIn: '7d', // Long-lived refresh token
    });

    return { accessToken, refreshToken };
  }
}
