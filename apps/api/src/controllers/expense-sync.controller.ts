import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ApiBadRequestException } from '../common/api-error';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import {
  ExpenseSyncPage,
  ExpenseSyncService,
} from '../services/expense-sync.service';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; displayName: string };
}

@Controller('api/spaces/:spaceId/sync/expenses')
@UseGuards(JwtAuthGuard)
export class ExpenseSyncController {
  constructor(private readonly sync: ExpenseSyncService) {}

  @Get()
  async listChanges(
    @Req() req: AuthenticatedRequest,
    @Param('spaceId') spaceId: string,
    @Query('after') after?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<{ success: true; data: ExpenseSyncPage }> {
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiBadRequestException(
        'VALIDATION_ERROR',
        'Sync limit must be an integer between 1 and 500',
        { field: 'limit' },
      );
    }

    try {
      return {
        success: true,
        data: await this.sync.listChanges(req.user.id, spaceId, after, limit),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid sync cursor') {
        throw new ApiBadRequestException(
          'INVALID_SYNC_CURSOR',
          'Invalid sync cursor',
          { field: 'after' },
        );
      }
      throw error;
    }
  }
}
