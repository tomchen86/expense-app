import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
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
  UpdateUserProfileDto,
  UserProfileResponse,
  UserSearchQueryDto,
  UserSettingsResponse,
  UserSummary,
} from '../dto/user.dto';

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
    @Body() body: any,
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
  async uploadAvatar(): Promise<ApiResponse<never>> {
    throw new HttpException(
      {
        success: false,
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'Avatar uploads are not available yet',
        },
      },
      HttpStatus.NOT_IMPLEMENTED,
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

  @Put('settings/persistence')
  async updatePersistenceMode(
    @Req() req: AuthenticatedRequest,
    @Body() body: any,
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
    payload: any,
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
      const constraintMessage = primaryError.constraints
        ? Object.values(primaryError.constraints)[0]
        : 'Invalid payload';

      throw new HttpException(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: options.messageOverride ?? constraintMessage,
            field: primaryError.property,
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return instance;
  }
}
