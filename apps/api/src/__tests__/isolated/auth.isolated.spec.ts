// Isolated Auth Test - No database dependency - TRUE GREEN PHASE
// Tests auth endpoints in complete isolation

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthController } from '../../controllers/auth.controller';
import { AuthService } from '../../services/auth.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';

describe('Authentication Endpoints - TRUE GREEN PHASE (Isolated)', () => {
  let app: INestApplication;
  let authService: jest.Mocked<AuthService>;
  let jwtService: jest.Mocked<JwtService>;

  beforeAll(async () => {
    // Create complete mocks
    const mockAuthService = {
      register: jest.fn(),
      login: jest.fn(),
      refreshToken: jest.fn(),
      getUserWithSettings: jest.fn(),
      updatePersistenceMode: jest.fn(),
    };

    const mockJwtService = {
      sign: jest.fn(),
      verify: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: JwtService, useValue: mockJwtService },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    authService = app.get(AuthService);
    jwtService = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/register - TDD GREEN', () => {
    it('should successfully register a user', async () => {
      // Setup mock response
      authService.register.mockResolvedValue({
        user: {
          id: 'user-123',
          displayName: 'Test User',
          email: 'test@example.com',
        } as any,
        accessToken: 'jwt-access-token',
        refreshToken: 'jwt-refresh-token',
      });

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'password123',
          displayName: 'Test User',
        })
        .expect(201);

      // Verify mobile-compatible response format
      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: 'user-123',
            displayName: 'Test User',
            email: 'test@example.com',
          },
          accessToken: 'jwt-access-token',
          refreshToken: 'jwt-refresh-token',
        },
      });

      expect(authService.register).toHaveBeenCalledWith(
        'test@example.com',
        'password123',
        'Test User',
      );
    });

    it('should validate missing required fields', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({})
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Required fields are missing',
          details: ['email', 'password', 'displayName'],
        },
      });
    });

    it('should handle duplicate email error', async () => {
      authService.register.mockRejectedValue(
        new Error('User with this email already exists'),
      );

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'existing@example.com',
          password: 'password123',
          displayName: 'Test User',
        })
        .expect(409);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An account with this email already exists',
          field: 'email',
        },
      });
    });
  });

  describe('POST /auth/login - TDD GREEN', () => {
    it('should successfully login a user', async () => {
      authService.login.mockResolvedValue({
        user: {
          id: 'user-123',
          displayName: 'Test User',
          email: 'test@example.com',
        } as any,
        accessToken: 'jwt-access-token',
        refreshToken: 'jwt-refresh-token',
        settings: {
          preferredCurrency: 'USD',
          dateFormat: 'MM/DD/YYYY',
          defaultSplitMethod: 'equal',
          persistenceMode: 'local_only',
        },
      });

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'test@example.com',
          password: 'password123',
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: 'user-123',
            displayName: 'Test User',
            email: 'test@example.com',
          },
          accessToken: 'jwt-access-token',
          refreshToken: 'jwt-refresh-token',
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'local_only',
          },
        },
      });
    });

    it('should handle invalid credentials', async () => {
      authService.login.mockRejectedValue(new Error('Invalid credentials'));

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'wrong@example.com',
          password: 'wrongpassword',
        })
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        },
      });
    });
  });

  describe('POST /auth/refresh - TDD GREEN', () => {
    it('should successfully refresh tokens', async () => {
      authService.refreshToken.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'valid-refresh-token' })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
        },
      });
    });

    it('should handle invalid refresh token', async () => {
      authService.refreshToken.mockRejectedValue(
        new Error('Invalid refresh token'),
      );

      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'invalid-token' })
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Refresh token is invalid or expired',
        },
      });
    });
  });

  describe('GET /auth/me - TDD GREEN', () => {
    it('should return current user with valid JWT', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      authService.getUserWithSettings.mockResolvedValue({
        user: {
          id: 'user-123',
          displayName: 'Test User',
          email: 'test@example.com',
        } as any,
        settings: {
          preferredCurrency: 'USD',
          dateFormat: 'MM/DD/YYYY',
          defaultSplitMethod: 'equal',
          persistenceMode: 'local_only',
        },
      });

      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer valid-jwt-token')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: 'user-123',
            displayName: 'Test User',
            email: 'test@example.com',
          },
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'local_only',
          },
        },
      });
    });

    it('should reject request without authorization header', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        },
      });
    });

    it('should reject request with invalid JWT', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid-jwt-token')
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'JWT token is invalid or expired',
        },
      });
    });
  });

  describe('PUT /auth/settings/persistence - TDD GREEN', () => {
    it('should successfully update persistence mode', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      authService.updatePersistenceMode.mockResolvedValue({
        settings: {
          preferredCurrency: 'USD',
          dateFormat: 'MM/DD/YYYY',
          defaultSplitMethod: 'equal',
          persistenceMode: 'cloud_sync',
        },
        persistenceChangeTimestamp: '2025-09-25T14:30:00.000Z',
      });

      const response = await request(app.getHttpServer())
        .put('/auth/settings/persistence')
        .set('Authorization', 'Bearer valid-jwt-token')
        .send({
          persistenceMode: 'cloud_sync',
          deviceId: 'mobile_device_123',
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'cloud_sync',
          },
          persistenceChangeTimestamp: '2025-09-25T14:30:00.000Z',
        },
      });

      expect(authService.updatePersistenceMode).toHaveBeenCalledWith(
        'user-123',
        'cloud_sync',
        'mobile_device_123',
      );
    });

    it('should validate persistence mode values', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      const response = await request(app.getHttpServer())
        .put('/auth/settings/persistence')
        .set('Authorization', 'Bearer valid-jwt-token')
        .send({ persistenceMode: 'invalid_mode' })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Persistence mode must be local_only or cloud_sync',
          field: 'persistenceMode',
        },
      });
    });
  });

  describe('Performance Requirements - TDD GREEN', () => {
    it('should meet authentication speed requirements', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      const startTime = performance.now();

      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer valid-jwt-token');

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Authentication should be under 100ms (very fast in tests)
      expect(duration).toBeLessThan(100);
    });
  });
});
