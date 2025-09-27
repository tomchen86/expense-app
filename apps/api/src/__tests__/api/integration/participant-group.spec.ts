// Integration tests for Participant Group API
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
  ExpenseGroupFactory,
  ParticipantFactory,
} from '../../helpers/test-data-factories';
import { User } from '../../../entities/user.entity';
import { ExpenseGroup } from '../../../entities/expense-group.entity';
import { Participant } from '../../../entities/participant.entity';
import { Repository, ObjectLiteral } from 'typeorm';

interface PerformanceMetrics {
  duration: number;
}

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

interface ParticipantData {
  id: string;
  userId: string;
  groupId: string;
  displayName: string;
  email: string;
}

interface ExpenseGroupData {
  id: string;
  name: string;
  participants: ParticipantData[];
}

const repo = <T extends ObjectLiteral>(name: string) =>
  dbHelper.getRepository<T>(name) as unknown as Repository<T>;

describe('Expense Group API', () => {
  let app: INestApplication;
  let httpServer: http.Server;
  let api: supertest.SuperTest<supertest.Test>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer();
    api = supertest(httpServer) as any;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /expense-groups', () => {
    it('should create a new expense group', async () => {
      const userUnknown: unknown = UserFactory.create();
      const user = userUnknown as User;
      const userRepo = repo<User>('User');
      await userRepo.save(user);

      const groupData = {
        name: 'Test Group',
        participants: [{ userId: user.id, displayName: user.displayName }],
      };

      const perfPost = (await PerformanceAssertions.testEndpointPerformance(
        'POST /expense-groups',
        () =>
          api
            .post('/expense-groups')
            .set('Authorization', `Bearer valid-jwt-token`)
            .send(groupData)
            .expect(201),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { response, metrics } = perfPost;

      const bodyUnknown: unknown = response.body;
      const body = bodyUnknown as ApiResponse<ExpenseGroupData>;
      expect(body).toMatchObject({
        success: true,
        data: {
          id: expect.any(String),
          name: 'Test Group',
          participants: expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(String),
              userId: user.id,
              groupId: expect.any(String),
              displayName: user.displayName,
              email: user.email,
            }),
          ]),
        },
      });

      expect(metrics).toBeFastOperation();
    });

    it('should return 401 if no token is provided', async () => {
      const groupData = {
        name: 'Test Group',
        participants: [],
      };

      const response = await api
        .post('/expense-groups')
        .send(groupData)
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

  describe('GET /expense-groups/:id', () => {
    it('should return a expense group by ID', async () => {
      const userUnknown: unknown = UserFactory.create();
      const user = userUnknown as User;
      const userRepo = repo<User>('User');
      await userRepo.save(user);

      const groupUnknown: unknown = ExpenseGroupFactory.create(user);
      const group = groupUnknown as ExpenseGroup;
      const groupRepo = repo<ExpenseGroup>('ExpenseGroup');
      await groupRepo.save(group);

      const participantUnknown: unknown = ParticipantFactory.create(
        user,
        group.coupleId,
      );
      const participant = participantUnknown as Participant;
      const participantRepo = repo<Participant>('Participant');
      await participantRepo.save(participant);

      const perfGet = (await PerformanceAssertions.testEndpointPerformance(
        'GET /expense-groups/:id',
        () =>
          api
            .get(`/expense-groups/${group.id}`)
            .set('Authorization', `Bearer valid-jwt-token`)
            .expect(200),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { response, metrics } = perfGet;

      const bodyUnknown: unknown = response.body;
      const body = bodyUnknown as ApiResponse<ExpenseGroupData>;
      expect(body).toMatchObject({
        success: true,
        data: {
          id: group.id,
          name: group.name,
          participants: expect.arrayContaining([
            expect.objectContaining({
              id: participant.id,
              userId: user.id,
              groupId: group.id,
              displayName: user.displayName,
              email: user.email,
            }),
          ]),
        },
      });

      expect(metrics).toBeFastOperation();
    });

    it('should return 404 if group not found', async () => {
      const userUnknown: unknown = UserFactory.create();
      const user = userUnknown as User;
      const userRepo = repo<User>('User');
      await userRepo.save(user);

      const response = await api
        .get(`/expense-groups/${'non-existent-id'}`)
        .set('Authorization', `Bearer valid-jwt-token`)
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Participant group not found',
        },
      });
    });
  });

  describe('PUT /expense-groups/:id', () => {
    it('should update a expense group', async () => {
      const user1Unknown: unknown = UserFactory.create();
      const user1 = user1Unknown as User;
      const user2Unknown: unknown = UserFactory.create();
      const user2 = user2Unknown as User;
      const userRepo = repo<User>('User');
      await userRepo.save([user1, user2]);

      const groupUnknown: unknown = ExpenseGroupFactory.create(user1);
      const group = groupUnknown as ExpenseGroup;
      const groupRepo = repo<ExpenseGroup>('ExpenseGroup');
      await groupRepo.save(group);

      const participant1Unknown: unknown = ParticipantFactory.create(
        user1,
        group.coupleId,
      );
      const participant1 = participant1Unknown as Participant;
      const participantRepo = repo<Participant>('Participant');
      await participantRepo.save(participant1);

      const perfPut = (await PerformanceAssertions.testEndpointPerformance(
        'PUT /expense-groups/:id',
        () =>
          api
            .put(`/expense-groups/${group.id}`)
            .set('Authorization', `Bearer valid-jwt-token`)
            .send({
              name: 'Updated Group Name',
              participants: [
                { userId: user1.id, displayName: user1.displayName },
                { userId: user2.id, displayName: user2.displayName },
              ],
            })
            .expect(200),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { response, metrics } = perfPut;

      const bodyUnknown: unknown = response.body;
      const body = bodyUnknown as ApiResponse<ExpenseGroupData>;
      expect(body).toMatchObject({
        success: true,
        data: {
          id: group.id,
          name: 'Updated Group Name',
          participants: expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(String),
              userId: user1.id,
              groupId: group.id,
              displayName: user1.displayName,
              email: user1.email,
            }),
            expect.objectContaining({
              id: expect.any(String),
              userId: user2.id,
              groupId: group.id,
              displayName: user2.displayName,
              email: user2.email,
            }),
          ]),
        },
      });

      expect(metrics).toBeFastOperation();
    });

    it('should return 404 if group not found', async () => {
      const userUnknown: unknown = UserFactory.create();
      const user = userUnknown as User;
      const userRepo = repo<User>('User');
      await userRepo.save(user);

      const response = await api
        .put(`/expense-groups/${'non-existent-id'}`)
        .set('Authorization', `Bearer valid-jwt-token`)
        .send({ name: 'Non Existent' })
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Participant group not found',
        },
      });
    });
  });

  describe('DELETE /expense-groups/:id', () => {
    it('should delete a expense group', async () => {
      const userUnknown: unknown = UserFactory.create();
      const user = userUnknown as User;
      const userRepo = repo<User>('User');
      await userRepo.save(user);

      const groupUnknown: unknown = ExpenseGroupFactory.create(user);
      const group = groupUnknown as ExpenseGroup;
      const groupRepo = repo<ExpenseGroup>('ExpenseGroup');
      await groupRepo.save(group);

      const perfDelete = (await PerformanceAssertions.testEndpointPerformance(
        'DELETE /expense-groups/:id',
        () =>
          api
            .delete(`/expense-groups/${group.id}`)
            .set('Authorization', `Bearer valid-jwt-token`)
            .expect(200),
        500,
      )) as { response: supertest.Response; metrics: PerformanceMetrics };
      const { response, metrics } = perfDelete;

      const bodyUnknown: unknown = response.body;
      const body = bodyUnknown as ApiResponse<ExpenseGroupData>;
      expect(body).toMatchObject({
        success: true,
        data: {
          id: group.id,
          name: group.name,
          participants: [],
        },
      });

      expect(metrics).toBeFastOperation();

      const deletedGroupRepo = repo<ExpenseGroup>('ExpenseGroup');
      const deletedGroup = await deletedGroupRepo.findOne({
        where: { id: group.id },
      });
      expect(deletedGroup).toBeNull();
    });

    it('should return 404 if group not found', async () => {
      const userUnknown: unknown = UserFactory.create();
      const user = userUnknown as User;
      const userRepo = repo<User>('User');
      await userRepo.save(user);

      const response = await api
        .delete(`/expense-groups/${'non-existent-id'}`)
        .set('Authorization', `Bearer valid-jwt-token`)
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Participant group not found',
        },
      });
    });
  });
});
