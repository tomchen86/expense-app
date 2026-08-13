import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PersonalLedgerController } from '../controllers/personal-ledger.controller';
import { Entities } from '../entities/runtime-entities';
import { PersonalLedgerService } from '../services/personal-ledger.service';
import { LedgerModule } from './ledger.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Entities.Couple,
      Entities.CoupleMember,
      Entities.Participant,
      Entities.Expense,
      Entities.ExpenseSplit,
    ]),
    LedgerModule,
  ],
  controllers: [PersonalLedgerController],
  providers: [PersonalLedgerService],
})
export class PersonalLedgerModule {}
