// JWT Authentication Guard - Mobile-Compatible
// Protects routes and provides mobile-friendly error responses

import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { createApiError } from '../common/api-error';

interface JwtPayload {
  sub: string;
  email?: string;
  displayName?: string;
}

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    displayName?: string;
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
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
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret:
          process.env.JWT_SECRET || 'development-secret-change-in-production',
      });

      // Attach user to request for controller access
      request.user = {
        id: payload.sub,
        email: payload.email,
        displayName: payload.displayName,
      };

      return true;
    } catch {
      response
        .status(401)
        .json(
          createApiError('INVALID_TOKEN', 'JWT token is invalid or expired'),
        );
      return false;
    }
  }
}
