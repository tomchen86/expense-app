import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Entities } from '../entities/runtime-entities';
import { LedgerService } from '../services/ledger.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Entities.Couple,
      Entities.CoupleMember,
      Entities.Participant,
      Entities.User,
      Entities.Category,
    ]),
  ],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
