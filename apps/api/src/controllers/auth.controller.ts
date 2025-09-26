// Authentication Controller - Mobile-First TDD Implementation
// GREEN Phase: Making the failing tests pass

import {
  Controller,
  Post,
  Body,
  Get,
  Put,
  UseGuards,
  Req,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Request } from 'express';
import { ApiBadRequestException } from '../common/api-error';

// Mobile-compatible DTOs
interface RegisterDto {
  email: string;
  password: string;
  displayName: string;
}

interface LoginDto {
  email: string;
  password: string;
}

interface UpdatePersistenceModeDto {
  persistenceMode: 'local_only' | 'cloud_sync';
  deviceId?: string;
}

// Mobile-compatible response format
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
    details?: unknown;
  };
}

interface AuthUserPayload {
  id: string;
  displayName: string;
  email: string;
}

interface UserSettingsPayload {
  preferredCurrency: string;
  dateFormat: string;
  defaultSplitMethod: string;
  persistenceMode: 'local_only' | 'cloud_sync';
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

type RegisterResponsePayload = TokenPair & {
  user: AuthUserPayload;
};

type LoginResponsePayload = TokenPair & {
  user: AuthUserPayload;
  settings: UserSettingsPayload;
};

type RefreshResponsePayload = TokenPair;

type CurrentUserResponsePayload = {
  user: AuthUserPayload;
  settings: UserSettingsPayload;
};

type UpdatePersistenceResponsePayload = {
  settings: UserSettingsPayload;
  persistenceChangeTimestamp: string | Date;
};

// Authenticated user interface for requests
interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() registerDto: RegisterDto,
  ): Promise<ApiResponse<RegisterResponsePayload>> {
    // Validate required fields up front so we can return a 400 with the mobile error envelope.
    if (
      !registerDto.email ||
      !registerDto.password ||
      !registerDto.displayName
    ) {
      const missingFields: string[] = [];
      if (!registerDto.email) missingFields.push('email');
      if (!registerDto.password) missingFields.push('password');
      if (!registerDto.displayName) missingFields.push('displayName');

      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Required fields are missing',
        {
          details: missingFields,
        },
      );
    }

    const result = await this.authService.register(
      registerDto.email,
      registerDto.password,
      registerDto.displayName,
    );

    return {
      success: true,
      data: {
        user: {
          id: result.user.id,
          displayName: result.user.displayName,
          email: result.user.email,
        },
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
  ): Promise<ApiResponse<LoginResponsePayload>> {
    if (!loginDto.email || !loginDto.password) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Email and password are required',
      );
    }

    const result = await this.authService.login(
      loginDto.email,
      loginDto.password,
    );

    return {
      success: true,
      data: {
        user: {
          id: result.user.id,
          displayName: result.user.displayName,
          email: result.user.email,
        },
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        settings: {
          preferredCurrency: result.settings?.preferredCurrency || 'USD',
          dateFormat: result.settings?.dateFormat || 'MM/DD/YYYY',
          defaultSplitMethod: result.settings?.defaultSplitMethod || 'equal',
          persistenceMode:
            (result.settings?.persistenceMode as 'local_only' | 'cloud_sync') ||
            'local_only',
        },
      },
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Body('refreshToken') refreshToken: string,
  ): Promise<ApiResponse<RefreshResponsePayload>> {
    if (!refreshToken) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Refresh token is required',
      );
    }

    const result = await this.authService.refreshToken(refreshToken);

    return {
      success: true,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getCurrentUser(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<CurrentUserResponsePayload>> {
    const userDetails = await this.authService.getUserWithSettings(req.user.id);

    return {
      success: true,
      data: {
        user: {
          id: userDetails.user.id,
          displayName: userDetails.user.displayName,
          email: userDetails.user.email,
        },
        settings: {
          preferredCurrency: userDetails.settings?.preferredCurrency || 'USD',
          dateFormat: userDetails.settings?.dateFormat || 'MM/DD/YYYY',
          defaultSplitMethod:
            userDetails.settings?.defaultSplitMethod || 'equal',
          persistenceMode:
            (userDetails.settings?.persistenceMode as
              | 'local_only'
              | 'cloud_sync') || 'local_only',
        },
      },
    };
  }

  @Put('settings/persistence')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updatePersistenceMode(
    @Req() req: AuthenticatedRequest,
    @Body() updateDto: UpdatePersistenceModeDto,
  ): Promise<ApiResponse<UpdatePersistenceResponsePayload>> {
    if (
      !updateDto.persistenceMode ||
      !['local_only', 'cloud_sync'].includes(updateDto.persistenceMode)
    ) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Persistence mode must be local_only or cloud_sync',
        { field: 'persistenceMode' },
      );
    }

    try {
      const result = await this.authService.updatePersistenceMode(
        req.user.id,
        updateDto.persistenceMode,
      );

      return {
        success: true,
        data: {
          settings: {
            preferredCurrency: result.settings.preferredCurrency || 'USD',
            dateFormat: result.settings.dateFormat || 'MM/DD/YYYY',
            defaultSplitMethod: result.settings.defaultSplitMethod || 'equal',
            persistenceMode: result.settings.persistenceMode as
              | 'local_only'
              | 'cloud_sync',
          },
          persistenceChangeTimestamp: result.persistenceChangeTimestamp,
        },
      };
    } catch {
      throw new ApiBadRequestException(
        'UPDATE_FAILED',
        'Failed to update persistence mode',
      );
    }
  }
}
