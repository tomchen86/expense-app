// Integration tests for Authentication API - Mobile Compatible
// RED Phase: These tests will fail initially and drive implementation

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import * as http from 'http';
import { AppModule } from '../../../app.module';
import { dbHelper } from '../../setup';
import { PerformanceAssertions } from '../../helpers/performance-assertions';
import {
  UserFactory,
  UserSettingsFactory,
} from '../../helpers/test-data-factories';
import { User } from '../../../entities';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JWT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
    details?: string[];
  };
}

describe('Authentication API - Mobile Compatibility', () => {
  let app: INestApplication;
  let httpServer: http.Server;
  let api: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer();
    api = supertest(httpServer);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/register - User Registration', () => {
    it('should register user with mobile-compatible response format', async () => {
      const registrationData = {
        email: 'mobile@test.com',
        password: 'testPassword123',
        displayName: 'Mobile User',
      };

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'POST /auth/register',
          () => api.post('/auth/register').send(registrationData).expect(201),
          500, // Must be under 500ms
        );

      const body = response.body as ApiResponse<{
        user: any;
        accessToken: string;
        refreshToken: string;
      }>;
      // Validate mobile-compatible response format
      expect(body).toEqual({
        success: true,
        data: {
          user: {
            id: expect.any(String),
            displayName: 'Mobile User',
            email: 'mobile@test.com',
          },
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
        },
      });

      // Ensure tokens are JWT format
      expect(body.data.accessToken).toMatch(
        /^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]*$/,
      );
      expect(body.data.refreshToken).toMatch(
        /^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]*$/,
      );

      // Performance assertion
      expect(metrics).toBeFastOperation();
    });

    it('should reject duplicate email registration', async () => {
      // Create user first
      const user = UserFactory.createMobileCompatible();
      await dbHelper.getRepository('User').save(user);

      const duplicateData = {
        email: user.email,
        password: 'testPassword123',
        displayName: 'Duplicate User',
      };

      const response = await api
        .post('/auth/register')
        .send(duplicateData)
        .expect(409); // Conflict

      // Mobile-compatible error format
      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An account with this email already exists',
          field: 'email',
        },
      });
    });

    it('should validate required fields', async () => {
      const response = await api
        .post('/auth/register')
        .send({}) // Empty payload
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Required fields are missing',
          details: expect.arrayContaining(['email', 'password', 'displayName']),
        },
      });
    });
  });

  describe('POST /auth/login - User Authentication', () => {
    it('should authenticate with mobile-compatible response format (login-or-create)', async () => {
      // Create test user
      const user = UserFactory.createMobileCompatible();
      await dbHelper.getRepository('User').save(user);

      const loginData = {
        email: 'mobile@test.com',
        password: 'testPassword123',
      };

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'POST /auth/login',
          () => api.post('/auth/login').send(loginData).expect(200),
          400, // Authentication should be under 400ms (integration test)
        );

      const body = response.body as ApiResponse<{
        user: any;
        settings: any;
        accessToken: string;
        refreshToken: string;
      }>;
      // Contract: success + stable fields from loginData
      expect(body).toMatchObject({
        success: true,
        data: {
          user: {
            email: loginData.email,
            displayName: 'Mobile User', // API applies this default
          },
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'local_only', // Critical for mobile app
          },
        },
      });

      // Dynamic fields by format
      expect(body.data.user.id).toEqual(expect.stringMatching(UUID_V4));
      expect(body.data.accessToken).toMatch(JWT_REGEX);
      expect(body.data.refreshToken).toMatch(JWT_REGEX);

      // Integration test performance requirement (relaxed from unit test <100ms)
      expect(metrics.duration).toBeLessThan(300);
    });

    it('should reject invalid credentials', async () => {
      const loginData = {
        email: 'nonexistent@test.com',
        password: 'wrongPassword',
      };

      const response = await api
        .post('/auth/login')
        .send(loginData)
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

  describe('POST /auth/refresh - Token Refresh', () => {
    it('should refresh tokens with valid refresh token', async () => {
      // First, login to get tokens
      const user = UserFactory.createMobileCompatible();
      await dbHelper.getRepository<User>('User').save(user);

      const loginResponse = await api.post('/auth/login').send({
        email: user.email,
        password: 'testPassword123',
      });

      const loginBody = loginResponse.body as ApiResponse<{
        refreshToken: string;
      }>;
      const refreshToken = loginBody.data.refreshToken;

      // Test refresh
      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'POST /auth/refresh',
          () => api.post('/auth/refresh').send({ refreshToken }).expect(200),
          100, // Fast refresh
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
        },
      });

      expect(metrics.duration).toBeLessThan(300);
    });

    it('should reject invalid refresh token', async () => {
      const response = await api
        .post('/auth/refresh')
        .send({ refreshToken: 'invalid.token.here' })
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

  describe('GET /auth/me - Get Current User', () => {
    it('should return current user with valid JWT', async () => {
      // Setup: login to get authenticated token
      const loginData = {
        email: 'mobile@test.com',
        password: 'testPassword123',
      };

      const loginResponse = await api.post('/auth/login').send(loginData);
      const loginBody = loginResponse.body as ApiResponse<{
        accessToken: string;
      }>;
      const accessToken = loginBody.data.accessToken;

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'GET /auth/me',
          () =>
            api
              .get('/auth/me')
              .set('Authorization', `Bearer ${accessToken}`)
              .expect(200),
          300, // Fast user profile lookup (integration test)
        );

      const body = response.body as ApiResponse<{ user: any; settings: any }>;
      // Contract: success + stable fields
      expect(body).toMatchObject({
        success: true,
        data: {
          user: {
            email: loginData.email,
            displayName: 'Mobile User', // API applies this default
          },
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'local_only',
          },
        },
      });

      // Dynamic fields by format
      expect(body.data.user.id).toEqual(expect.stringMatching(UUID_V4));

      expect(metrics.duration).toBeLessThan(300);
    });

    it('should reject request without authorization header', async () => {
      const response = await api.get('/auth/me').expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        },
      });
    });

    it('should reject request with invalid JWT', async () => {
      const response = await api
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid.jwt.token')
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

  describe('PUT /auth/settings/persistence - Persistence Mode Toggle', () => {
    it('should update persistence mode from local_only to cloud_sync', async () => {
      // Setup authenticated user
      const user = UserFactory.createMobileCompatible();
      await dbHelper.getRepository<User>('User').save(user);

      const settings = UserSettingsFactory.createMobileDefaults(savedUser);
      await dbHelper.getRepository('UserSettings').save(settings);

      const loginResponse = await api.post('/auth/login').send({
        email: user.email,
        password: 'testPassword123',
      });

      const loginBody = loginResponse.body as ApiResponse<{
        accessToken: string;
      }>;
      const accessToken = loginBody.data.accessToken;

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'PUT /auth/settings/persistence',
          () =>
            api
              .put('/auth/settings/persistence')
              .set('Authorization', `Bearer ${accessToken}`)
              .send({
                persistenceMode: 'cloud_sync',
                deviceId: 'mobile_device_123',
              })
              .expect(200),
          500, // Settings update
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'cloud_sync',
          },
          persistenceChangeTimestamp: expect.any(String),
        },
      });

      expect(metrics).toBeFastOperation();
    });

    it('should validate persistence mode values', async () => {
      const user = UserFactory.createMobileCompatible();
      await dbHelper.getRepository<User>('User').save(user);

      const loginResponse = await api.post('/auth/login').send({
        email: user.email,
        password: 'testPassword123',
      });

      const loginBody = loginResponse.body as ApiResponse<{
        accessToken: string;
      }>;
      const accessToken = loginBody.data.accessToken;

      const response = await api
        .put('/auth/settings/persistence')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          persistenceMode: 'invalid_mode',
        })
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
});
