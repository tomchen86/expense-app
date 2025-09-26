// JWT Authentication Guard - Mobile-Compatible
// Protects routes and provides mobile-friendly error responses

import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { createApiError } from '../common/api-error';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const authHeader = request.headers.authorization;

    if (!authHeader) {
      // Mobile-compatible error response
      response
        .status(401)
        .json(
          createApiError('UNAUTHORIZED', 'Authorization header is required'),
        );
      return false;
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      response
        .status(401)
        .json(createApiError('UNAUTHORIZED', 'Bearer token is required'));
      return false;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret:
          process.env.JWT_SECRET || 'development-secret-change-in-production',
      });

      // Attach user to request for controller access
      (request as any).user = {
        id: payload.sub,
        email: payload.email,
        displayName: payload.displayName,
      };

      return true;
    } catch (error) {
      response
        .status(401)
        .json(
          createApiError('INVALID_TOKEN', 'JWT token is invalid or expired'),
        );
      return false;
    }
  }
}
