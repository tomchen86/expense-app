import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { UserService } from '../services/user.service';
import {
  UpdatePersistenceModeDto,
  UpdateUserSettingsDto,
  RegisterDeviceDto,
  UpdateDeviceSyncDto,
  UpdateUserProfileDto,
  UserProfileResponse,
  UserSearchQueryDto,
  UserSettingsResponse,
  UserSummary,
  UserDeviceResponse,
} from '../dto/user.dto';
import { ApiBadRequestException, ApiHttpException } from '../common/api-error';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
  };
}

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
}

@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('profile')
  async getProfile(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<UserProfileResponse>> {
    const profile = await this.userService.getUserProfile(req.user.id);

    return {
      success: true,
      data: {
        user: profile.user,
        settings: profile.settings,
      },
    };
  }

  @Put('profile')
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ user: UserProfileResponse['user'] }>> {
    const dto = this.validateDto(UpdateUserProfileDto, body, {
      skipMissingProperties: true,
      messageOverride: 'Invalid profile update payload',
    });

    const updatedUser = await this.userService.updateUserProfile(
      req.user.id,
      dto,
    );

    return {
      success: true,
      data: { user: updatedUser },
    };
  }

  @Post('avatar')
  uploadAvatar(): Promise<ApiResponse<never>> {
    throw new ApiHttpException(
      HttpStatus.NOT_IMPLEMENTED,
      'NOT_IMPLEMENTED',
      'Avatar uploads are not available yet',
    );
  }

  @Get('settings')
  async getSettings(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<{ settings: UserSettingsResponse }>> {
    const settings = await this.userService.getUserSettings(req.user.id);

    return {
      success: true,
      data: {
        settings,
      },
    };
  }

  @Put('settings')
  async updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ settings: UserSettingsResponse }>> {
    const dto = this.validateDto(UpdateUserSettingsDto, body, {
      skipMissingProperties: true,
      messageOverride: 'Invalid settings payload',
    });

    const settings = await this.userService.updateUserSettings(
      req.user.id,
      dto,
    );

    return {
      success: true,
      data: {
        settings,
      },
    };
  }

  @Put('settings/persistence')
  async updatePersistenceMode(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<
    ApiResponse<{
      settings: UserSettingsResponse;
      persistenceChangeTimestamp: string;
    }>
  > {
    const dto = this.validateDto(UpdatePersistenceModeDto, body, {
      messageOverride: 'Persistence mode must be local_only or cloud_sync',
    });

    const { settings, changedAt } =
      await this.userService.updatePersistenceMode(
        req.user.id,
        dto.persistenceMode,
      );

    return {
      success: true,
      data: {
        settings,
        persistenceChangeTimestamp: changedAt.toISOString(),
      },
    };
  }

  @Post('settings/devices')
  @HttpCode(HttpStatus.CREATED)
  async registerDevice(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ device: UserDeviceResponse }>> {
    const dto = this.validateDto(RegisterDeviceDto, body, {
      messageOverride: 'Invalid device registration payload',
    });

    const device = await this.userService.registerDevice(req.user.id, dto);

    return {
      success: true,
      data: {
        device,
      },
    };
  }

  @Get('settings/devices')
  async listDevices(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<{ devices: UserDeviceResponse[] }>> {
    const devices = await this.userService.listDevices(req.user.id);

    return {
      success: true,
      data: {
        devices,
      },
    };
  }

  @Put('settings/devices/:deviceUuid')
  async updateDevice(
    @Req() req: AuthenticatedRequest,
    @Param('deviceUuid') deviceUuid: string,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ device: UserDeviceResponse }>> {
    const dto = this.validateDto(UpdateDeviceSyncDto, body, {
      skipMissingProperties: true,
      messageOverride: 'Invalid device update payload',
    });

    const device = await this.userService.updateDevice(
      req.user.id,
      deviceUuid,
      dto,
    );

    return {
      success: true,
      data: {
        device,
      },
    };
  }

  @Delete('settings/devices/:deviceUuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDevice(
    @Req() req: AuthenticatedRequest,
    @Param('deviceUuid') deviceUuid: string,
  ): Promise<void> {
    await this.userService.removeDevice(req.user.id, deviceUuid);
  }

  @Get('search')
  async searchUsers(
    @Req() req: AuthenticatedRequest,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponse<{ users: UserSummary[] }>> {
    const dto = this.validateDto(
      UserSearchQueryDto,
      { q, limit },
      {
        messageOverride: 'Search query is required',
      },
    );

    const users = await this.userService.searchUsers(
      req.user.id,
      dto.q,
      dto.limit ?? 10,
    );

    return {
      success: true,
      data: {
        users,
      },
    };
  }

  private validateDto<T>(
    cls: new () => T,
    payload: unknown,
    options: {
      skipMissingProperties?: boolean;
      messageOverride?: string;
    } = {},
  ): T {
    const instance = plainToInstance(cls, payload);
    const errors = validateSync(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
      skipMissingProperties: options.skipMissingProperties ?? false,
    });

    if (errors.length > 0) {
      const primaryError = errors[0];
      const nestedError =
        primaryError.children && primaryError.children.length > 0
          ? primaryError.children[0]
          : undefined;
      const constraintMessage = primaryError.constraints
        ? Object.values(primaryError.constraints)[0]
        : 'Invalid payload';
      const field = (
        nestedError?.property
          ? `${primaryError.property}`
          : primaryError.property
      )
        .toString()
        .split('.')[0];

      const message = nestedError?.constraints
        ? Object.values(nestedError.constraints)[0]
        : constraintMessage;

      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        options.messageOverride ?? message,
        { field },
      );
    }

    return instance;
  }
}
