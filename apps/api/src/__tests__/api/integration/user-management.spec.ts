// User Management API - Mobile Compatibility Tests (TDD RED Phase)
// These tests define the expected behaviour of the user/profile endpoints

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqljs';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import * as http from 'http';
import { AppModule } from '../../../app.module';
import { PerformanceAssertions } from '../../helpers/performance-assertions';

const PASSWORD = 'TestPassword123!';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    field?: string;
  };
}

describe('User Management API - Mobile Compatibility', () => {
  let app: INestApplication;
  let httpServer: http.Server;
  let api: ReturnType<typeof supertest>;

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

    const body = response.body as ApiResponse<{
      user: { id: string };
      accessToken: string;
      refreshToken: string;
    }>;
    if (!body.success || !body.data) {
      throw new Error('Failed to register user');
    }

    return {
      email,
      displayName,
      userId: body.data.user.id,
      accessToken: body.data.accessToken,
      refreshToken: body.data.refreshToken,
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

      const body = response.body as ApiResponse<{ user: any; settings: any }>;
      expect(body).toEqual({
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

      const updateBody = updateResponse.body as ApiResponse<{ user: any }>;
      expect(updateBody).toEqual({
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

      const profileBody = profileResponse.body as ApiResponse<{ user: any }>;
      if (profileBody.success && profileBody.data) {
        expect(profileBody.data.user).toEqual({
          id: userId,
          email,
          displayName: 'Updated Mobile Name',
          avatarUrl: null,
          defaultCurrency: 'EUR',
          timezone: 'America/New_York',
        });
      }
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

      const settingsBody = settingsResponse.body as ApiResponse<{
        settings: { persistenceMode: string };
      }>;
      if (settingsBody.success && settingsBody.data) {
        expect(settingsBody.data.settings.persistenceMode).toBe('cloud_sync');
      }
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

      const body = response.body as ApiResponse<{ users: any[] }>;
      expect(body.success).toBe(true);
      if (body.success && body.data) {
        expect(Array.isArray(body.data.users)).toBe(true);
        expect(body.data.users.length).toBeGreaterThanOrEqual(2);
        body.data.users.forEach((user: any) => {
          expect(user.id).not.toBe(requester.userId);
          expect(user.email).toMatch(/partner/);
          expect(user).toEqual(
            expect.objectContaining({
              displayName: expect.stringMatching(/^Partner/),
              avatarUrl: null,
            }),
          );
        });
      }

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
