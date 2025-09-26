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

describe('User Settings API - Mobile Compatibility', () => {
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

  describe('PUT /api/users/settings', () => {
    it('should update language, notifications, and push preferences', async () => {
      const { accessToken } = await registerMobileUser();

      const updatePayload = {
        language: 'fr-FR',
        pushEnabled: false,
        notifications: {
          expenses: false,
          invites: true,
          reminders: false,
        },
      };

      const { response, metrics } =
        await PerformanceAssertions.testEndpointPerformance(
          'PUT /api/users/settings',
          () =>
            api
              .put('/api/users/settings')
              .set('Authorization', `Bearer ${accessToken}`)
              .send(updatePayload)
              .expect(200),
          150,
        );

      expect(response.body).toEqual({
        success: true,
        data: {
          settings: {
            language: 'fr-FR',
            pushEnabled: false,
            persistenceMode: 'local_only',
            notifications: {
              expenses: false,
              invites: true,
              reminders: false,
            },
            lastPersistenceChange: expect.any(String),
          },
        },
      });

      expect(metrics).toBeFastOperation();

      // Verify persistence via follow-up fetch
      const settingsResponse = await api
        .get('/api/users/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(settingsResponse.body.data.settings).toEqual({
        language: 'fr-FR',
        pushEnabled: false,
        persistenceMode: 'local_only',
        notifications: {
          expenses: false,
          invites: true,
          reminders: false,
        },
        lastPersistenceChange: expect.any(String),
      });
    });

    it('should merge partial notification updates while validating payloads', async () => {
      const { accessToken } = await registerMobileUser();

      const initialUpdate = {
        notifications: {
          expenses: false,
        },
      };

      await api
        .put('/api/users/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(initialUpdate)
        .expect(200);

      const response = await api
        .put('/api/users/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          notifications: {
            invites: false,
          },
        })
        .expect(200);

      expect(response.body.data.settings.notifications).toEqual({
        expenses: false,
        invites: false,
        reminders: true,
      });
    });

    it('should reject invalid notification booleans', async () => {
      const { accessToken } = await registerMobileUser();

      const response = await api
        .put('/api/users/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          notifications: {
            expenses: 'nope',
          },
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid settings payload',
          field: 'notifications',
        },
      });
    });
  });

  describe('Device registration and lifecycle', () => {
    it('should register a device and return device metadata', async () => {
      const { accessToken } = await registerMobileUser();

      const registerPayload = {
        deviceUuid: 'ios-simulator-123',
        deviceName: 'iPhone 15 Pro',
        platform: 'ios',
        appVersion: '1.0.0',
      };

      const registerResponse = await api
        .post('/api/users/settings/devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(registerPayload)
        .expect(201);

      expect(registerResponse.body).toEqual({
        success: true,
        data: {
          device: {
            id: expect.any(String),
            deviceUuid: 'ios-simulator-123',
            deviceName: 'iPhone 15 Pro',
            platform: 'ios',
            appVersion: '1.0.0',
            persistenceModeAtSync: 'local_only',
            syncStatus: 'idle',
            lastSyncAt: null,
            lastSnapshotHash: null,
            lastError: null,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        },
      });

      const listResponse = await api
        .get('/api/users/settings/devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(listResponse.body.data.devices).toHaveLength(1);
      expect(listResponse.body.data.devices[0].deviceUuid).toBe(
        'ios-simulator-123',
      );
    });

    it('should update device sync metadata', async () => {
      const { accessToken } = await registerMobileUser();

      await api
        .post('/api/users/settings/devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          deviceUuid: 'android-tablet-999',
          deviceName: 'Pixel Tablet',
          platform: 'android',
          appVersion: '2.3.5',
        })
        .expect(201);

      const updatePayload = {
        syncStatus: 'syncing',
        persistenceModeAtSync: 'cloud_sync',
        lastSyncAt: new Date().toISOString(),
        lastSnapshotHash: 'abc123',
      };

      const updateResponse = await api
        .put('/api/users/settings/devices/android-tablet-999')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(updatePayload)
        .expect(200);

      expect(updateResponse.body).toEqual({
        success: true,
        data: {
          device: expect.objectContaining({
            deviceUuid: 'android-tablet-999',
            syncStatus: 'syncing',
            persistenceModeAtSync: 'cloud_sync',
            lastSnapshotHash: 'abc123',
            lastSyncAt: expect.any(String),
          }),
        },
      });
    });

    it('should remove devices and return empty list afterwards', async () => {
      const { accessToken } = await registerMobileUser();

      await api
        .post('/api/users/settings/devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deviceUuid: 'temp-device-42' })
        .expect(201);

      await api
        .delete('/api/users/settings/devices/temp-device-42')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const listResponse = await api
        .get('/api/users/settings/devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(listResponse.body.data.devices).toHaveLength(0);
    });

    it('should validate device payloads', async () => {
      const { accessToken } = await registerMobileUser();

      const response = await api
        .post('/api/users/settings/devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid device registration payload',
          field: 'deviceUuid',
        },
      });
    });
  });
});
