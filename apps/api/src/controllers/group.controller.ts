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
  Req,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { GroupService } from '../services/group.service';
import {
  CreateGroupDto,
  GroupResponse,
  UpdateGroupDto,
} from '../dto/participant.dto';
import { ApiBadRequestException } from '../common/api-error';

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

@Controller('api/groups')
@UseGuards(JwtAuthGuard)
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

  @Get()
  async listGroups(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<{ groups: GroupResponse[] }>> {
    const groups = await this.groupService.listGroupsForUser(req.user.id);

    return {
      success: true,
      data: {
        groups,
      },
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createGroup(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ group: GroupResponse }>> {
    const dto = this.validateDto(CreateGroupDto, body, {
      messageOverride: 'Invalid group payload',
    });

    const group = await this.groupService.createGroupForUser(req.user.id, dto);

    return {
      success: true,
      data: {
        group,
      },
    };
  }

  @Put(':groupId')
  async updateGroup(
    @Req() req: AuthenticatedRequest,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ group: GroupResponse }>> {
    const dto = this.validateDto(UpdateGroupDto, body, {
      skipMissingProperties: true,
      messageOverride: 'Invalid group payload',
    });

    const group = await this.groupService.updateGroupForUser(
      req.user.id,
      groupId,
      dto,
    );

    return {
      success: true,
      data: {
        group,
      },
    };
  }

  @Delete(':groupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGroup(
    @Req() req: AuthenticatedRequest,
    @Param('groupId') groupId: string,
  ): Promise<void> {
    await this.groupService.deleteGroupForUser(req.user.id, groupId);
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
      const constraintMessage = primaryError.constraints
        ? Object.values(primaryError.constraints)[0]
        : 'Invalid payload';

      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        options.messageOverride ?? constraintMessage,
        { field: primaryError.property },
      );
    }

    return instance;
  }
}
