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
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Request } from 'express';

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
    details?: any;
  };
}

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
  async register(@Body() registerDto: RegisterDto): Promise<ApiResponse<any>> {
    try {
      // Validate required fields
      if (
        !registerDto.email ||
        !registerDto.password ||
        !registerDto.displayName
      ) {
        const missingFields: string[] = [];
        if (!registerDto.email) missingFields.push('email');
        if (!registerDto.password) missingFields.push('password');
        if (!registerDto.displayName) missingFields.push('displayName');

        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Required fields are missing',
            details: missingFields,
          },
        };
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
    } catch (error) {
      if (error.message.includes('already exists')) {
        return {
          success: false,
          error: {
            code: 'EMAIL_ALREADY_EXISTS',
            message: 'An account with this email already exists',
            field: 'email',
          },
        };
      }
      throw error;
    }
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto): Promise<ApiResponse<any>> {
    try {
      if (!loginDto.email || !loginDto.password) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Email and password are required',
          },
        };
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
            persistenceMode: result.settings?.persistenceMode || 'local_only',
          },
        },
      };
    } catch (error) {
      if (error.message.includes('Invalid credentials')) {
        return {
          success: false,
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid email or password',
          },
        };
      }
      throw error;
    }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Body('refreshToken') refreshToken: string,
  ): Promise<ApiResponse<any>> {
    try {
      if (!refreshToken) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Refresh token is required',
          },
        };
      }

      const result = await this.authService.refreshToken(refreshToken);

      return {
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Refresh token is invalid or expired',
        },
      };
    }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getCurrentUser(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<any>> {
    try {
      const userDetails = await this.authService.getUserWithSettings(
        req.user.id,
      );

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
              userDetails.settings?.persistenceMode || 'local_only',
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
      };
    }
  }

  @Put('settings/persistence')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updatePersistenceMode(
    @Req() req: AuthenticatedRequest,
    @Body() updateDto: UpdatePersistenceModeDto,
  ): Promise<ApiResponse<any>> {
    try {
      if (
        !updateDto.persistenceMode ||
        !['local_only', 'cloud_sync'].includes(updateDto.persistenceMode)
      ) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Persistence mode must be either local_only or cloud_sync',
            field: 'persistenceMode',
          },
        };
      }

      const result = await this.authService.updatePersistenceMode(
        req.user.id,
        updateDto.persistenceMode,
        updateDto.deviceId,
      );

      return {
        success: true,
        data: {
          settings: {
            preferredCurrency: result.settings.preferredCurrency || 'USD',
            dateFormat: result.settings.dateFormat || 'MM/DD/YYYY',
            defaultSplitMethod: result.settings.defaultSplitMethod || 'equal',
            persistenceMode: result.settings.persistenceMode,
          },
          persistenceChangeTimestamp: result.persistenceChangeTimestamp,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'UPDATE_FAILED',
          message: 'Failed to update persistence mode',
        },
      };
    }
  }
}
