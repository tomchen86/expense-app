import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SpaceController } from '../controllers/space.controller';
import { Entities } from '../entities/runtime-entities';
import { SpaceService } from '../services/space.service';
import { LedgerModule } from './ledger.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Entities.Couple,
      Entities.CoupleMember,
      Entities.User,
      Entities.Participant,
    ]),
    LedgerModule,
  ],
  controllers: [SpaceController],
  providers: [SpaceService],
  exports: [SpaceService],
})
export class SpaceModule {}
