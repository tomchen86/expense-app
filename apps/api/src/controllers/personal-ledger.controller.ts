import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import {
  PersonalLedgerResponse,
  PersonalLedgerService,
} from '../services/personal-ledger.service';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; displayName: string };
}

@Controller('api/ledger')
@UseGuards(JwtAuthGuard)
export class PersonalLedgerController {
  constructor(private readonly ledger: PersonalLedgerService) {}

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ success: true; data: PersonalLedgerResponse }> {
    return {
      success: true,
      data: await this.ledger.listForUser(req.user.id),
    };
  }
}
