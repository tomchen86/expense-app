// Authentication Module - Wires up auth components for DI

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from '../controllers/auth.controller';
import { AuthService } from '../services/auth.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Entities } from '../entities/runtime-entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([Entities.User, Entities.UserSettings]),
    JwtModule.register({
      global: true, // Make JwtService available globally
      secret:
        process.env.JWT_SECRET || 'development-secret-change-in-production',
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard], // Export for use in other modules
})
export class AuthModule {}
