import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Request } from 'express';
import { ApiBadRequestException } from '../common/api-error';
import {
  AddSpaceMemberDto,
  CreateSpaceDto,
  SpaceMemberResponse,
  SpaceResponse,
  UpdateSpaceSyncPolicyDto,
} from '../dto/space.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { SpaceService } from '../services/space.service';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; displayName: string };
}

type ApiResponse<T> = { success: true; data: T };

@Controller('api/spaces')
@UseGuards(JwtAuthGuard)
export class SpaceController {
  constructor(private readonly spaceService: SpaceService) {}

  @Get()
  async listSpaces(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<{ spaces: SpaceResponse[] }>> {
    return {
      success: true,
      data: { spaces: await this.spaceService.listSpacesForUser(req.user.id) },
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSpace(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ space: SpaceResponse }>> {
    const dto = this.validate(CreateSpaceDto, body);
    return {
      success: true,
      data: {
        space: await this.spaceService.createSharedSpace(req.user.id, dto),
      },
    };
  }

  @Post(':spaceId/members')
  @HttpCode(HttpStatus.CREATED)
  async addMember(
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') spaceId: string,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ member: SpaceMemberResponse }>> {
    const dto = this.validate(AddSpaceMemberDto, body);
    return {
      success: true,
      data: {
        member: await this.spaceService.addAccountMember(
          req.user.id,
          spaceId,
          dto.user_id,
        ),
      },
    };
  }

  @Post(':spaceId/sync-policy')
  async updateSyncPolicy(
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') spaceId: string,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ space: SpaceResponse }>> {
    const dto = this.validate(UpdateSpaceSyncPolicyDto, body);
    return {
      success: true,
      data: {
        space: await this.spaceService.updateSyncPolicy(
          req.user.id,
          spaceId,
          dto.sync_policy,
        ),
      },
    };
  }

  private validate<T>(type: new () => T, payload: unknown): T {
    const dto = plainToInstance(type, payload);
    const errors = validateSync(dto as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Invalid space payload',
        { field: errors[0].property },
      );
    }
    return dto;
  }
}
