// Auth Endpoints Basic Test - GREEN Phase TDD
// Test endpoints exist and respond correctly without database dependency

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SuperTest, Test as SuperTestRequest } from 'supertest';
const supertest = require('supertest');
import { AuthController } from '../../../controllers/auth.controller';
import { AuthService } from '../../../services/auth.service';
import { JwtAuthGuard } from '../../../guards/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';

// Mock AuthService to avoid database dependency
const mockAuthService = {
  register: jest.fn(),
  login: jest.fn(),
  refreshToken: jest.fn(),
  getUserWithSettings: jest.fn(),
  updatePersistenceMode: jest.fn(),
};

// Mock JwtService
const mockJwtService = {
  sign: jest.fn(),
  verify: jest.fn(),
};

describe('Authentication Endpoints - TDD GREEN Phase', () => {
  let app: INestApplication;
  let api: SuperTest<SuperTestRequest>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    api = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('should respond to registration requests', async () => {
      // Mock successful registration
      mockAuthService.register.mockResolvedValue({
        user: {
          id: '123',
          displayName: 'Test User',
          email: 'test@example.com',
        },
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      });

      const response = await api.post('/auth/register').send({
        email: 'test@example.com',
        password: 'password123',
        displayName: 'Test User',
      });

      // Should NOT be 404 - endpoint exists
      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(mockAuthService.register).toHaveBeenCalledWith(
        'test@example.com',
        'password123',
        'Test User',
      );
    });

    it('should validate required fields', async () => {
      const response = await api.post('/auth/register').send({}); // Empty payload

      expect(response.status).toBe(400); // Bad Request for validation failure
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/login', () => {
    it('should respond to login requests', async () => {
      // Mock successful login
      mockAuthService.login.mockResolvedValue({
        user: {
          id: '123',
          displayName: 'Test User',
          email: 'test@example.com',
        },
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        settings: {
          preferredCurrency: 'USD',
          dateFormat: 'MM/DD/YYYY',
          defaultSplitMethod: 'equal',
          persistenceMode: 'local_only',
        },
      });

      const response = await api.post('/auth/login').send({
        email: 'test@example.com',
        password: 'password123',
      });

      // Should NOT be 404 - endpoint exists
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user).toBeDefined();
      expect(response.body.data.settings).toBeDefined();
      expect(mockAuthService.login).toHaveBeenCalledWith(
        'test@example.com',
        'password123',
      );
    });

    it('should validate required fields for login', async () => {
      const response = await api
        .post('/auth/login')
        .send({ email: 'test@example.com' }); // Missing password

      expect(response.status).toBe(400); // Bad Request for validation failure
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/refresh', () => {
    it('should respond to token refresh requests', async () => {
      // Mock successful refresh
      mockAuthService.refreshToken.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      const response = await api
        .post('/auth/refresh')
        .send({ refreshToken: 'valid-refresh-token' });

      // Should NOT be 404 - endpoint exists
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.refreshToken).toBeDefined();
    });
  });

  describe('GET /auth/me', () => {
    it('should respond to user profile requests', async () => {
      // Mock JWT verification
      mockJwtService.verify.mockReturnValue({
        sub: '123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      // Mock user with settings
      mockAuthService.getUserWithSettings.mockResolvedValue({
        user: {
          id: '123',
          displayName: 'Test User',
          email: 'test@example.com',
        },
        settings: {
          preferredCurrency: 'USD',
          dateFormat: 'MM/DD/YYYY',
          defaultSplitMethod: 'equal',
          persistenceMode: 'local_only',
        },
      });

      const response = await api
        .get('/auth/me')
        .set('Authorization', 'Bearer mock-jwt-token');

      // Should NOT be 404 - endpoint exists
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user).toBeDefined();
      expect(response.body.data.settings).toBeDefined();
    });

    it('should reject requests without authorization header', async () => {
      const response = await api.get('/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('PUT /auth/settings/persistence', () => {
    it('should respond to persistence mode update requests', async () => {
      // Mock JWT verification
      mockJwtService.verify.mockReturnValue({
        sub: '123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      // Mock persistence update
      mockAuthService.updatePersistenceMode.mockResolvedValue({
        settings: {
          preferredCurrency: 'USD',
          dateFormat: 'MM/DD/YYYY',
          defaultSplitMethod: 'equal',
          persistenceMode: 'cloud_sync',
        },
        persistenceChangeTimestamp: new Date().toISOString(),
      });

      const response = await api
        .put('/auth/settings/persistence')
        .set('Authorization', 'Bearer mock-jwt-token')
        .send({
          persistenceMode: 'cloud_sync',
          deviceId: 'mobile_device_123',
        });

      // Should NOT be 404 - endpoint exists
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.settings).toBeDefined();
      expect(response.body.data.persistenceChangeTimestamp).toBeDefined();
    });

    it('should validate persistence mode values', async () => {
      // Mock JWT verification
      mockJwtService.verify.mockReturnValue({
        sub: '123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      const response = await api
        .put('/auth/settings/persistence')
        .set('Authorization', 'Bearer mock-jwt-token')
        .send({ persistenceMode: 'invalid_mode' });

      expect(response.status).toBe(400); // Bad Request for validation failure
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.field).toBe('persistenceMode');
    });
  });

  // Performance test
  describe('Performance Requirements', () => {
    it('should meet authentication speed requirements', async () => {
      const startTime = performance.now();

      // Mock fast response
      mockJwtService.verify.mockReturnValue({
        sub: '123',
        email: 'test@example.com',
        displayName: 'Test User',
      });

      await api.get('/auth/me').set('Authorization', 'Bearer mock-jwt-token');

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should be fast (under 100ms for auth)
      expect(duration).toBeLessThan(100);
    });
  });
});
