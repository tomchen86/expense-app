import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { getDatabaseConfig } from './config/database.config';
import { getAppConfig } from './config/app.config';
import { AuthModule } from './modules/auth.module';
import { UserModule } from './modules/user.module';
import { CategoryModule } from './modules/category.module';
import { ParticipantModule } from './modules/participant.module';
import { GroupModule } from './modules/group.module';
import { ExpenseModule } from './modules/expense.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [getAppConfig],
    }),
    TypeOrmModule.forRoot(getDatabaseConfig()),
    AuthModule,
    UserModule,
    CategoryModule,
    ParticipantModule,
    GroupModule,
    ExpenseModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
