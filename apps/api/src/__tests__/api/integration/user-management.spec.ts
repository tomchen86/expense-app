// User Management API - Mobile Compatibility Tests (TDD RED Phase)
// These tests define the expected behaviour of the user/profile endpoints

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqljs';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SuperTest, Test as SuperTestRequest } from 'supertest';
const supertest = require('supertest');
import { AppModule } from '../../../app.module';
import { PerformanceAssertions } from '../../helpers/performance-assertions';

const PASSWORD = 'TestPassword123!';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('User Management API - Mobile Compatibility', () => {
  let app: INestApplication;
  let httpServer: any;
  let api: SuperTest<SuperTestRequest>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    httpServer = app.getHttpAdapter().getInstance();
    api = supertest(httpServer);
  });

  afterAll(async () => {
    await app.close();
  });

  const registerMobileUser = async (
    overrides: { email?: string; displayName?: string } = {},
  ) => {
    const email = overrides.email ?? uniqueEmail('user');
    const displayName = overrides.displayName ?? 'Mobile Test User';

    const response = await api
      .post('/auth/register')
      .send({
        email,
        password: PASSWORD,
        displayName,
      })
      .expect(201);

    return {
      email,
      displayName,
      userId: response.body.data.user.id,
      accessToken: response.body.data.accessToken,
      refreshToken: response.body.data.refreshToken,
    };
  };

  describe('GET /api/users/profile', () => {
    it('should return the authenticated user profile with settings', async () => {
      const { accessToken, email, displayName } = await registerMobileUser({
        displayName: 'Profile User',
      });

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'GET /api/users/profile',
          () =>
            api
              .get('/api/users/profile')
              .set('Authorization', `Bearer ${accessToken}`)
              .expect(200),
          100,
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          user: expect.objectContaining({
            id: expect.any(String),
            email,
            displayName,
            avatarUrl: null,
            defaultCurrency: 'USD',
            timezone: 'UTC',
          }),
          settings: expect.objectContaining({
            language: 'en-US',
            pushEnabled: true,
            persistenceMode: 'local_only',
            notifications: expect.objectContaining({
              expenses: true,
              invites: true,
              reminders: true,
            }),
          }),
        },
      });

      expect(metrics).toBeFastOperation();
    });

    it('should reject unauthenticated profile requests', async () => {
      const response = await api.get('/api/users/profile').expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        },
      });
    });
  });

  describe('PUT /api/users/profile', () => {
    it('should update profile fields allowed by mobile app', async () => {
      const { accessToken, email, userId } = await registerMobileUser({
        displayName: 'Original Name',
      });

      const updatePayload = {
        displayName: 'Updated Mobile Name',
        timezone: 'America/New_York',
        defaultCurrency: 'EUR',
      };

      const updateResponse = await api
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(updatePayload)
        .expect(200);

      expect(updateResponse.body).toEqual({
        success: true,
        data: {
          user: {
            id: userId,
            email,
            displayName: 'Updated Mobile Name',
            avatarUrl: null,
            defaultCurrency: 'EUR',
            timezone: 'America/New_York',
          },
        },
      });

      // Verify persistence via follow-up profile fetch
      const profileResponse = await api
        .get('/api/users/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(profileResponse.body.data.user).toEqual({
        id: userId,
        email,
        displayName: 'Updated Mobile Name',
        avatarUrl: null,
        defaultCurrency: 'EUR',
        timezone: 'America/New_York',
      });
    });

    it('should validate currency format and reject invalid updates', async () => {
      const { accessToken } = await registerMobileUser();

      const response = await api
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          defaultCurrency: 'usd',
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid profile update payload',
          field: 'defaultCurrency',
        },
      });
    });
  });

  describe('GET /api/users/settings', () => {
    it('should return settings synchronized with persistence mode', async () => {
      const { accessToken } = await registerMobileUser();

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'GET /api/users/settings',
          () =>
            api
              .get('/api/users/settings')
              .set('Authorization', `Bearer ${accessToken}`)
              .expect(200),
          100,
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          settings: {
            language: 'en-US',
            persistenceMode: 'local_only',
            pushEnabled: true,
            notifications: expect.objectContaining({
              expenses: true,
              invites: true,
              reminders: true,
            }),
            lastPersistenceChange: expect.any(String),
          },
        },
      });

      expect(metrics).toBeFastOperation();
    });
  });

  describe('PUT /api/users/settings/persistence', () => {
    it('should toggle persistence mode and record change timestamp', async () => {
      const { accessToken } = await registerMobileUser();

      const toggleResponse = await api
        .put('/api/users/settings/persistence')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          persistenceMode: 'cloud_sync',
          deviceId: 'ios-device-123',
        })
        .expect(200);

      expect(toggleResponse.body).toEqual({
        success: true,
        data: {
          settings: expect.objectContaining({
            persistenceMode: 'cloud_sync',
          }),
          persistenceChangeTimestamp: expect.any(String),
        },
      });

      // Fetch settings to ensure persistence
      const settingsResponse = await api
        .get('/api/users/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(settingsResponse.body.data.settings.persistenceMode).toBe(
        'cloud_sync',
      );
    });

    it('should validate persistence mode values', async () => {
      const { accessToken } = await registerMobileUser();

      const response = await api
        .put('/api/users/settings/persistence')
        .set('Authorization', `Bearer ${accessToken}`)
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

  describe('GET /api/users/search', () => {
    it('should return matching users excluding the requester', async () => {
      const requester = await registerMobileUser({
        displayName: 'Primary User',
      });
      await registerMobileUser({
        email: uniqueEmail('partner'),
        displayName: 'Partner Alpha',
      });
      await registerMobileUser({
        email: uniqueEmail('partner'),
        displayName: 'Partner Beta',
      });

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'GET /api/users/search',
          () =>
            api
              .get('/api/users/search')
              .set('Authorization', `Bearer ${requester.accessToken}`)
              .query({ q: 'Partner' })
              .expect(200),
          200,
        );

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data.users)).toBe(true);
      expect(response.body.data.users.length).toBeGreaterThanOrEqual(2);
      response.body.data.users.forEach((user: any) => {
        expect(user.id).not.toBe(requester.userId);
        expect(user.email).toMatch(/partner/);
        expect(user).toEqual(
          expect.objectContaining({
            displayName: expect.stringMatching(/^Partner/),
            avatarUrl: null,
          }),
        );
      });

      expect(metrics).toBeFastOperation();
    });

    it('should require a non-empty query string', async () => {
      const requester = await registerMobileUser();

      const response = await api
        .get('/api/users/search')
        .set('Authorization', `Bearer ${requester.accessToken}`)
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Search query is required',
          field: 'q',
        },
      });
    });

    it('should reject search requests without authentication', async () => {
      const response = await api
        .get('/api/users/search')
        .query({ q: 'Partner' })
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        },
      });
    });
  });
});
