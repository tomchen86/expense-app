// Integration tests for Authentication API - Mobile Compatible
// RED Phase: These tests will fail initially and drive implementation

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { testDataSource, dbHelper } from '../../setup';
import { PerformanceAssertions } from '../../helpers/performance-assertions';
import {
  UserFactory,
  UserSettingsFactory,
} from '../../helpers/test-data-factories';

describe('Authentication API - Mobile Compatibility', () => {
  let app: INestApplication;
  let httpServer: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer();
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
          () =>
            request(httpServer)
              .post('/auth/register')
              .send(registrationData)
              .expect(201),
          500, // Must be under 500ms
        );

      // Validate mobile-compatible response format
      expect(response.body).toEqual({
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
      expect(response.body.data.accessToken).toMatch(
        /^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]*$/,
      );
      expect(response.body.data.refreshToken).toMatch(
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
        email: user.email_address,
        password: 'testPassword123',
        displayName: 'Duplicate User',
      };

      const response = await request(httpServer)
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
      const response = await request(httpServer)
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
    it('should authenticate with mobile-compatible response format', async () => {
      // Create test user
      const user = UserFactory.createMobileCompatible();
      const savedUser = await dbHelper.getRepository('User').save(user);

      // Create user settings for persistence mode
      const settings = UserSettingsFactory.createMobileDefaults(savedUser);
      await dbHelper.getRepository('UserSettings').save(settings);

      const loginData = {
        email: user.email_address,
        password: 'testPassword123',
      };

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'POST /auth/login',
          () =>
            request(httpServer).post('/auth/login').send(loginData).expect(200),
          100, // Authentication should be under 100ms
        );

      // Mobile-compatible response
      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: savedUser.id,
            displayName: savedUser.display_name,
            email: savedUser.email_address,
          },
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'local_only', // Critical for mobile app
          },
        },
      });

      // Fast authentication requirement
      expect(metrics).toBeFastAuth();
    });

    it('should reject invalid credentials', async () => {
      const loginData = {
        email: 'nonexistent@test.com',
        password: 'wrongPassword',
      };

      const response = await request(httpServer)
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
      const savedUser = await dbHelper.getRepository('User').save(user);

      const loginResponse = await request(httpServer).post('/auth/login').send({
        email: user.email_address,
        password: 'testPassword123',
      });

      const refreshToken = loginResponse.body.data.refreshToken;

      // Test refresh
      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'POST /auth/refresh',
          () =>
            request(httpServer)
              .post('/auth/refresh')
              .send({ refreshToken })
              .expect(200),
          100, // Fast refresh
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
        },
      });

      expect(metrics).toBeFastAuth();
    });

    it('should reject invalid refresh token', async () => {
      const response = await request(httpServer)
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
      // Setup authenticated user
      const user = UserFactory.createMobileCompatible();
      const savedUser = await dbHelper.getRepository('User').save(user);

      const loginResponse = await request(httpServer).post('/auth/login').send({
        email: user.email_address,
        password: 'testPassword123',
      });

      const accessToken = loginResponse.body.data.accessToken;

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'GET /auth/me',
          () =>
            request(httpServer)
              .get('/auth/me')
              .set('Authorization', `Bearer ${accessToken}`)
              .expect(200),
          100, // Fast user profile lookup
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          user: {
            id: savedUser.id,
            displayName: savedUser.display_name,
            email: savedUser.email_address,
          },
          settings: {
            preferredCurrency: 'USD',
            dateFormat: 'MM/DD/YYYY',
            defaultSplitMethod: 'equal',
            persistenceMode: 'local_only',
          },
        },
      });

      expect(metrics).toBeFastAuth();
    });

    it('should reject request without authorization header', async () => {
      const response = await request(httpServer).get('/auth/me').expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        },
      });
    });

    it('should reject request with invalid JWT', async () => {
      const response = await request(httpServer)
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
      const savedUser = await dbHelper.getRepository('User').save(user);

      const settings = UserSettingsFactory.createMobileDefaults(savedUser);
      await dbHelper.getRepository('UserSettings').save(settings);

      const loginResponse = await request(httpServer).post('/auth/login').send({
        email: user.email_address,
        password: 'testPassword123',
      });

      const accessToken = loginResponse.body.data.accessToken;

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'PUT /auth/settings/persistence',
          () =>
            request(httpServer)
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
      const savedUser = await dbHelper.getRepository('User').save(user);

      const loginResponse = await request(httpServer).post('/auth/login').send({
        email: user.email_address,
        password: 'testPassword123',
      });

      const accessToken = loginResponse.body.data.accessToken;

      const response = await request(httpServer)
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
          message: 'Persistence mode must be either local_only or cloud_sync',
          field: 'persistenceMode',
        },
      });
    });
  });
});
