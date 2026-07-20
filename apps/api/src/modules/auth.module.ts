// Authentication Module - Wires up auth components for DI

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from '../controllers/auth.controller';
import { AuthService } from '../services/auth.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Entities } from '../entities/runtime-entities';
import { resolveJwtSecrets } from '../config/jwt-secret-policy';

@Module({
  imports: [
    TypeOrmModule.forFeature([Entities.User, Entities.UserSettings]),
    JwtModule.registerAsync({
      global: true, // Make JwtService available globally
      useFactory: () => ({
        secret: resolveJwtSecrets(process.env).accessSecret,
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard], // Export for use in other modules
})
export class AuthModule {}
