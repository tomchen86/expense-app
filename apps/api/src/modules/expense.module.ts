import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExpenseController } from '../controllers/expense.controller';
import { ExpenseService } from '../services/expense.service';
import { Entities } from '../entities/runtime-entities';
import { LedgerModule } from './ledger.module';
import { ParticipantModule } from './participant.module';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Entities.Expense,
      Entities.ExpenseSplit,
      Entities.Category,
      Entities.ExpenseGroup,
    ]),
    LedgerModule,
    ParticipantModule,
  ],
  controllers: [ExpenseController],
  providers: [ExpenseService, JwtAuthGuard],
  exports: [ExpenseService],
})
export class ExpenseModule {}
