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
import { ParticipantService } from '../services/participant.service';
import {
  CreateParticipantDto,
  ParticipantResponse,
  UpdateParticipantDto,
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

@Controller('api/participants')
@UseGuards(JwtAuthGuard)
export class ParticipantController {
  constructor(private readonly participantService: ParticipantService) {}

  @Get()
  async listParticipants(
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse<{ participants: ParticipantResponse[] }>> {
    const participants = await this.participantService.listParticipantsForUser(
      req.user.id,
    );

    return {
      success: true,
      data: {
        participants,
      },
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createParticipant(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ participant: ParticipantResponse }>> {
    const dto = this.validateDto(CreateParticipantDto, body, {
      messageOverride: 'Invalid participant payload',
    });

    const participant = await this.participantService.createParticipantForUser(
      req.user.id,
      dto,
    );

    return {
      success: true,
      data: {
        participant,
      },
    };
  }

  @Put(':participantId')
  async updateParticipant(
    @Req() req: AuthenticatedRequest,
    @Param('participantId') participantId: string,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ participant: ParticipantResponse }>> {
    const dto = this.validateDto(UpdateParticipantDto, body, {
      skipMissingProperties: true,
      messageOverride: 'Invalid participant payload',
    });

    const participant = await this.participantService.updateParticipantForUser(
      req.user.id,
      participantId,
      dto,
    );

    return {
      success: true,
      data: {
        participant,
      },
    };
  }

  @Delete(':participantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteParticipant(
    @Req() req: AuthenticatedRequest,
    @Param('participantId') participantId: string,
  ): Promise<void> {
    await this.participantService.deleteParticipantForUser(
      req.user.id,
      participantId,
    );
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
