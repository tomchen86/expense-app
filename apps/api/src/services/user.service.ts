import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../entities/user.entity';
import { UserSettings } from '../entities/user-settings.entity';
import {
  CreateUserDto,
  UpdateUserDto,
  UserResponseDto,
  UserSettingsDto,
} from '../dto/user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserSettings)
    private userSettingsRepository: Repository<UserSettings>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 12);

    const user = this.userRepository.create({
      ...createUserDto,
      email: createUserDto.email.toLowerCase(),
      password_hash: hashedPassword,
    });

    const savedUser = await this.userRepository.save(user);

    // Create default user settings
    const userSettings = this.userSettingsRepository.create({
      user_id: savedUser.id,
      language: 'en-US',
      notifications: {
        expenses: true,
        invites: true,
        reminders: true,
      },
      push_enabled: true,
      persistence_mode: 'local_only',
    });

    await this.userSettingsRepository.save(userSettings);

    return this.toResponseDto(savedUser);
  }

  async findById(id: string): Promise<UserResponseDto> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toResponseDto(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.userRepository.update(id, updateUserDto);
    const updatedUser = await this.userRepository.findOne({ where: { id } });
    return this.toResponseDto(updatedUser!);
  }

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.findByEmail(email);
    if (user && (await bcrypt.compare(password, user.password_hash))) {
      return user;
    }
    return null;
  }

  async updateLastActive(id: string): Promise<void> {
    await this.userRepository.update(id, {
      last_active_at: new Date(),
    });
  }

  async getUserSettings(userId: string): Promise<UserSettingsDto> {
    const settings = await this.userSettingsRepository.findOne({
      where: { user_id: userId },
    });

    if (!settings) {
      throw new NotFoundException('User settings not found');
    }

    return {
      language: settings.language,
      notifications: settings.notifications,
      push_enabled: settings.push_enabled,
      persistence_mode: settings.persistence_mode as
        | 'local_only'
        | 'cloud_sync',
    };
  }

  async updateUserSettings(
    userId: string,
    settingsDto: UserSettingsDto,
  ): Promise<UserSettingsDto> {
    const settings = await this.userSettingsRepository.findOne({
      where: { user_id: userId },
    });

    if (!settings) {
      throw new NotFoundException('User settings not found');
    }

    await this.userSettingsRepository.update(
      { user_id: userId },
      {
        ...settingsDto,
        last_persistence_change:
          settingsDto.persistence_mode !== settings.persistence_mode
            ? new Date()
            : settings.last_persistence_change,
      },
    );

    return this.getUserSettings(userId);
  }

  private toResponseDto(user: User): UserResponseDto {
    const { password_hash, ...userResponse } = user;
    return userResponse as UserResponseDto;
  }
}
