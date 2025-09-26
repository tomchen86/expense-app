import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserController } from '../controllers/user.controller';
import { Entities } from '../entities/runtime-entities';
import { UserService } from '../services/user.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Entities.User,
      Entities.UserSettings,
      Entities.UserDevice,
    ]),
  ],
  controllers: [UserController],
  providers: [UserService, JwtAuthGuard],
  exports: [UserService],
})
export class UserModule {}
