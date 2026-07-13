# Expense App API 程式碼導讀與架構教學

> 本文件以 `apps/api/src/` 的目前實作為準。最後核對日期：2026-07-13。

## 1. 這個 API 在做什麼？

這是 Expense App 的 NestJS 後端，負責：

- 註冊、登入、JWT access/refresh token。
- 使用者個人資料、偏好與同步裝置管理。
- 帳本中的參與者、群組與分類管理。
- 費用、分攤、查詢篩選與統計。
- 透過 `couple_id` 隔離不同帳本的資料。

技術核心如下：

| 層面             | 技術                                    | 在專案中的用途                                           |
| ---------------- | --------------------------------------- | -------------------------------------------------------- |
| HTTP framework   | NestJS 11                               | Module、Controller、Service、Guard、依賴注入             |
| ORM              | TypeORM 0.3                             | Entity、Repository、QueryBuilder、Transaction、Migration |
| 正式資料庫       | PostgreSQL                              | UUID、`citext`、`jsonb`、constraint、trigger             |
| 本機／測試資料庫 | SQLite 或 SQL.js                        | 快速啟動與 API integration test                          |
| 身分驗證         | `@nestjs/jwt` + `bcryptjs`              | 驗證密碼、簽發與檢查 JWT                                 |
| 輸入驗證         | `class-validator` + `class-transformer` | DTO 轉換、白名單與格式驗證                               |
| 測試             | Jest + Supertest                        | Entity、migration、service/API integration、效能預算     |

先記住一句話：**Controller 處理 HTTP，Service 執行商業規則，Repository 存取資料，而 `couple_id` 決定資料屬於哪一本帳。**

## 2. 目錄地圖

```text
apps/api/
├── src/
│   ├── main.ts                  # 程式進入點
│   ├── app.module.ts            # 根模組，組合所有功能模組
│   ├── config/                  # App、資料庫與 TypeORM CLI 設定
│   ├── modules/                 # NestJS 功能模組與 DI 邊界
│   ├── controllers/             # HTTP route、驗證、response mapping
│   ├── services/                # 商業邏輯與資料庫操作
│   ├── dto/                     # 請求／回應資料形狀
│   ├── guards/                  # JWT route protection
│   ├── common/                  # 共用 API error envelope
│   ├── entities/                # PostgreSQL 與 simple entity
│   ├── database/
│   │   ├── migrations/          # 正式 schema 版本演進
│   │   └── seeds/               # 預設分類、設定、範例資料
│   └── __tests__/               # API、資料庫與效能測試
└── test/                        # Nest CLI 產生的基礎 e2e test
```

建議閱讀順序：

1. `main.ts` → `app.module.ts`：應用程式怎麼啟動。
2. 任一 `modules/*.module.ts`：一個功能如何接上 DI container。
3. 對應的 controller → DTO → service：一次請求如何流動。
4. service 使用到的 entity：資料如何落到資料庫。
5. 同功能的 integration spec：合約與邊界條件是什麼。

## 3. 全域架構

```mermaid
flowchart LR
    Client["Mobile / Web client"] --> Guard["JwtAuthGuard"]
    Guard --> Controller["NestJS Controller"]
    Controller --> DTO["DTO transform + validateSync"]
    DTO --> Service["Domain Service"]
    Service --> Ledger["LedgerService"]
    Service --> Repo["TypeORM Repository / QueryBuilder"]
    Ledger --> Repo
    Repo --> DB[("PostgreSQL / SQLite / SQL.js")]
    Service --> Controller
    Controller --> Envelope["{ success, data } / { success, error }"]
    Envelope --> Client
```

專案採用「按技術層分目錄、按功能組成 Nest module」的方式。以 Expense 功能為例：

```mermaid
flowchart TD
    AppModule --> ExpenseModule
    ExpenseModule --> ExpenseController
    ExpenseModule --> ExpenseService
    ExpenseModule --> TypeOrmFeature["TypeOrmModule.forFeature"]
    ExpenseModule --> LedgerModule
    ExpenseModule --> ParticipantModule
    TypeOrmFeature --> ExpenseEntity
    TypeOrmFeature --> ExpenseSplitEntity
    TypeOrmFeature --> CategoryEntity
    TypeOrmFeature --> ExpenseGroupEntity
```

`ExpenseModule` 不需要自己 `new ExpenseService()`。NestJS 讀取 `@Module()` metadata，建立物件並注入它需要的 repositories、`LedgerService` 和 `ParticipantService`。

## 4. 啟動流程

### 4.1 `main.ts`

`src/main.ts` 只做兩件事：

```typescript
const app = await NestFactory.create(AppModule);
await app.listen(process.env.PORT ?? 3000);
```

這代表目前實作：

- 預設監聽 port `3000`。
- 沒有呼叫 `setGlobalPrefix()`。
- 沒有安裝全域 `ValidationPipe`。
- 沒有在這裡設定全域 CORS 或全域 exception filter。

因此 route 的 `api` 前綴是直接寫在 controller 的 `@Controller('api/...')`，DTO 驗證也是各 controller 主動呼叫 `plainToInstance()` 與 `validateSync()`。不要誤以為 NestJS 會自動驗證所有 `@Body()`。

### 4.2 `AppModule`

`src/app.module.ts` 組合：

- 全域 `ConfigModule`。
- 一個 TypeORM connection。
- `AuthModule`、`UserModule`、`CategoryModule`、`ParticipantModule`、`GroupModule`、`ExpenseModule`。
- 根路由 `GET /`，目前只回傳 `Hello World!`。

`LedgerModule` 沒有直接列在 `AppModule`，而是由 Category、Participant、Group、Expense 等功能模組匯入。它是跨功能共用的帳本初始化服務。

### 4.3 目前設定上的兩個重點

`getAppConfig()` 雖然載入 `apiPrefix`、`jwtExpiresIn` 等設定，但：

- `main.ts` 目前沒有使用 `apiPrefix`。
- `AuthModule`／`AuthService` 目前直接使用 15 分鐘 access token 和 7 天 refresh token，沒有讀取 `jwtExpiresIn`。

修改設定前要先追蹤「值有被宣告」和「值真的被消費」這兩件不同的事。

## 5. Module 與依賴注入

一個典型 module 有四種資訊：

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([Entities.Expense]), LedgerModule],
  controllers: [ExpenseController],
  providers: [ExpenseService, JwtAuthGuard],
  exports: [ExpenseService],
})
export class ExpenseModule {}
```

- `imports`：本 module 需要別人提供的能力。
- `controllers`：接收 HTTP request 的類別。
- `providers`：由 Nest 建立與注入的 service/guard。
- `exports`：允許其他 module 使用的 provider。

目前依賴關係大致如下：

| Module              | 主要 Entity                                       | 相依 Module                     |
| ------------------- | ------------------------------------------------- | ------------------------------- |
| `AuthModule`        | User、UserSettings                                | JwtModule                       |
| `UserModule`        | User、UserSettings、UserDevice                    | —                               |
| `LedgerModule`      | Couple、CoupleMember、Participant、User、Category | —                               |
| `CategoryModule`    | Category、Expense                                 | LedgerModule                    |
| `ParticipantModule` | Participant、GroupMember                          | LedgerModule                    |
| `GroupModule`       | ExpenseGroup、GroupMember、Participant            | LedgerModule、ParticipantModule |
| `ExpenseModule`     | Expense、ExpenseSplit、Category、ExpenseGroup     | LedgerModule、ParticipantModule |

## 6. Domain model：User、Ledger 與 Participant 不一樣

這是理解此 API 最重要的概念。

- `User`：可登入的真實帳號。
- `Couple`：資料隔離邊界；目前也可理解為一本 ledger。
- `CoupleMember`：哪個 User 可以進入哪個 Couple。
- `Participant`：出現在費用分攤中的人，可以有 User，也可以只是未註冊的名字／email。
- `ExpenseGroup`：帳本內為旅行、家庭等情境建立的分組。
- `GroupMember`：Group 和 Participant 的多對多 join entity。

```mermaid
erDiagram
    USER ||--o{ COUPLE_MEMBER : joins
    COUPLE ||--o{ COUPLE_MEMBER : has
    COUPLE ||--o{ PARTICIPANT : contains
    USER o|--o{ PARTICIPANT : may_back
    COUPLE ||--o{ EXPENSE_GROUP : contains
    EXPENSE_GROUP ||--o{ GROUP_MEMBER : has
    PARTICIPANT ||--o{ GROUP_MEMBER : joins
    COUPLE ||--o{ CATEGORY : owns
    COUPLE ||--o{ EXPENSE : owns
    EXPENSE_GROUP o|--o{ EXPENSE : groups
    CATEGORY o|--o{ EXPENSE : classifies
    PARTICIPANT o|--o{ EXPENSE : pays
    EXPENSE ||--|{ EXPENSE_SPLIT : divides
    PARTICIPANT ||--o{ EXPENSE_SPLIT : owes
```

### 6.1 為什麼同時要 User 和 Participant？

如果兩個人一起吃飯，付款人或分攤人不一定都已註冊 App。`Participant.userId` 可以是 `null`，因此可先建立「Alex」參與分攤，之後再處理帳號連結；API 不必為每位分攤者強迫建立登入帳號。

### 6.2 `LedgerService.ensureLedgerForUser()`

大部分 domain service 一開始都會呼叫：

```typescript
const { coupleId, participantId } = await ledgerService.ensureLedgerForUser(
  userId,
  {
    ensureParticipant: true,
    ensureDefaultCategories: true,
  },
);
```

它會按需求：

1. 找出使用者最早加入且仍 active 的 Couple。
2. 找不到時建立名為 `Personal Ledger` 的 Couple。
3. 建立 owner `CoupleMember`。
4. 確保登入者有一筆對應的 Participant。
5. 若需要，為新帳本建立預設 Categories。

所以某些看似純讀取的 endpoint，例如第一次 `GET /api/categories`，可能會初始化資料。這是目前刻意採用的 lazy initialization 行為。

## 7. 多租戶資料隔離

Guard 只能證明「是誰」，真正避免跨帳本讀寫的是 service query 中的 `coupleId`：

```typescript
const { coupleId } = await this.ledgerService.ensureLedgerForUser(userId);

const expense = await this.expenseRepository.findOne({
  where: { id: expenseId, coupleId },
});
```

只有 `where: { id: expenseId }` 不足夠，因為知道別人的 UUID 不應該代表可以讀取該資料。新增任何帳本內資源時，應遵守：

- 從 JWT 的 `req.user.id` 取得 User，不接受 client 傳入 owner user ID。
- 由 `LedgerService` 解析 `coupleId`。
- 所有讀、改、刪 query 同時限制 resource ID 與 `coupleId`。
- 關聯的 category、group、participant 也要驗證屬於同一個 `coupleId`。

目前 Expense、Group、Participant、Category service 都使用這種模式。

## 8. JWT 認證流程

```mermaid
sequenceDiagram
    participant C as Client
    participant AC as AuthController
    participant AS as AuthService
    participant DB as User Repository
    participant JWT as JwtService

    C->>AC: POST /auth/login
    AC->>AS: login(email, password)
    AS->>DB: findOne(email)
    AS->>AS: bcrypt.compare(password, passwordHash)
    AS->>JWT: sign access token (15m)
    AS->>JWT: sign refresh token (7d)
    AS-->>AC: user + tokens + settings
    AC-->>C: { success: true, data: ... }
```

### 8.1 Access token

`JwtAuthGuard` 讀取 `Authorization` header，移除 `Bearer ` 後呼叫 `JwtService.verify()`。成功後，把 payload 映射到：

```typescript
request.user = {
  id: payload.sub,
  email: payload.email,
  displayName: payload.displayName,
};
```

controller 因而能使用 `req.user.id`。失敗時 guard 直接回傳 mobile-compatible 401 JSON。

### 8.2 Refresh token

Access token 使用 `JWT_SECRET`，refresh token 使用 `JWT_REFRESH_SECRET`。`POST /auth/refresh` 驗證 refresh token、確認 User 仍存在，再簽發一組新的 token。

目前沒有 refresh token persistence、rotation/reuse detection 或 revoke list；登出／憑證撤銷若要做到即時失效，需要再擴充設計。

### 8.3 Passport 的現況

`passport` 相關套件存在於 dependencies，但目前 route protection 不是 Passport strategy，而是自訂 `JwtAuthGuard`。閱讀時應以 guard 實作為準。

## 9. DTO 驗證與 HTTP 邊界

以 `ExpenseController.createExpense()` 為例：

1. `@Body()` 先把內容當作 `unknown`。
2. `plainToInstance(CreateExpenseDto, body)` 建立 DTO instance。
3. `validateSync()` 套用 decorators。
4. `whitelist: true` 只保留 DTO 欄位。
5. `forbidNonWhitelisted: true` 讓多餘欄位直接失敗。
6. 失敗時丟出 `ApiBadRequestException`。
7. 成功才把 DTO 傳給 service。

例如：

```typescript
export class CreateExpenseDto {
  @IsNumber()
  @Min(1)
  amount_cents: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseSplitDto)
  splits: ExpenseSplitDto[];
}
```

Query string 原本都是字串，所以 Expense query 額外開啟 `enableImplicitConversion: true`；例如 `?limit=10` 才會轉成 number。User search 的 `limit` 則由 DTO 上的 `@Type(() => Number)` 轉換。

DTO 只處理輸入形狀與基本格式，service 仍必須處理跨欄位或資料庫相關規則，例如：

- 分攤金額總和等於費用總額。
- payer 必須出現在 splits。
- participant/category/group 必須屬於同一本 ledger。
- category 名稱在同一 ledger 中不可重複。

## 10. 一筆建立費用請求如何流動

這是最適合用來理解整個 API 的完整範例。

```mermaid
sequenceDiagram
    participant C as Client
    participant G as JwtAuthGuard
    participant EC as ExpenseController
    participant ES as ExpenseService
    participant LS as LedgerService
    participant PS as ParticipantService
    participant DB as TypeORM / Database

    C->>G: POST /api/expenses + Bearer token
    G->>G: verify token; attach req.user
    G->>EC: allow request
    EC->>EC: transform and validate CreateExpenseDto
    EC->>ES: createExpenseForUser(userId, dto)
    ES->>LS: ensureLedgerForUser
    LS->>DB: resolve/create ledger and self participant
    ES->>DB: validate category and group ownership
    ES->>PS: validate all split participants
    PS->>DB: query participants by coupleId
    ES->>ES: check total, percentage, payer
    ES->>DB: begin transaction
    ES->>DB: insert expense
    ES->>DB: insert expense_splits
    ES->>DB: commit
    ES-->>EC: ExpenseResponseDto
    EC-->>C: 201 { success: true, data: { expense } }
```

範例 request：

```http
POST /api/expenses
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "description": "Weekend Groceries",
  "amount_cents": 12500,
  "currency": "USD",
  "expense_date": "2026-07-11",
  "category_id": "<category-uuid>",
  "paid_by_participant_id": "<payer-uuid>",
  "split_type": "custom",
  "splits": [
    { "participant_id": "<payer-uuid>", "share_cents": 6250 },
    { "participant_id": "<partner-uuid>", "share_cents": 6250 }
  ]
}
```

### 10.1 為什麼金額叫 `amount_cents`？

API 使用最小貨幣單位的整數，`12500` 代表 125.00。這避免 JavaScript 浮點數直接表示金額時的精度問題。PostgreSQL entity 用 `bigint`，TypeORM 因 JavaScript safe integer 限制將其映射成 string；service 在寫入前 `toString()`，回應前再集中解析成 number。

### 10.2 為什麼要 transaction？

一筆費用和多筆 `expense_splits` 是同一個商業操作。如果費用成功、第二筆 split 寫入失敗，不能留下半套資料。因此 `createExpenseForUser()` 與 `updateExpenseForUser()` 使用 `manager.transaction()`；任何一步丟錯，整組寫入 rollback。

### 10.3 Update 的策略

更新費用時，service 先建立「更新後的完整狀態」，再在 transaction 中：

1. 儲存 Expense。
2. 刪除原本 splits。
3. 寫入新的完整 splits。

這比逐筆 diff 容易維持分攤總額等 invariant，但要注意 update payload 若改金額卻沒提供 splits，既有 splits 仍必須能通過新金額的一致性檢查。

## 11. Entity、Migration 與兩套 Entity collection

### 11.1 PostgreSQL entities

一般 `*.entity.ts` 使用 PostgreSQL 能力，例如：

- UUID column。
- `citext` email/name。
- `jsonb` 通知設定。
- `timestamptz`。
- regex check constraints。
- `DeleteDateColumn` soft delete。

正式環境 `synchronize: false`、`migrationsRun: true`，schema 由 `database/migrations/001...008` 管理。不要只改 Entity 而不考慮 migration。

### 11.2 Simple entities

`*-simple.entity.ts` 是 SQLite／SQL.js 相容版本，避開 PostgreSQL-only column types。`entity-sets.ts` 建立兩個 collection：

- `postgresCollection`：正式 PostgreSQL entities。
- `simpleCollection`：SQLite／SQL.js entities，但以相同 key 暴露。

`runtime-entities.ts` 的 `Entities` Proxy 依 `resolveDriver()` 動態選擇：

```typescript
@InjectRepository(Entities.Expense)
private readonly expenseRepository: Repository<ExpenseEntity>
```

因此 service 不需要為不同 driver 寫兩份邏輯。代價是修改 schema 時，通常要同步檢查 PostgreSQL entity、simple entity、migration 與兩種測試。

### 11.3 Driver 選擇

| 條件                                      | Driver      | Schema 行為                  |
| ----------------------------------------- | ----------- | ---------------------------- |
| `DB_DRIVER=postgres` 或一般非 test 預設   | PostgreSQL  | migrations，禁止 synchronize |
| `DB_DRIVER=sqlite`                        | SQLite file | 非 production 可 synchronize |
| `DB_DRIVER=sqljs` 或 `NODE_ENV=test` 預設 | SQL.js      | in-memory、synchronize       |

## 12. Soft delete 與關聯刪除

Expense、Category、Participant、ExpenseGroup 使用 `deleted_at` soft delete。Service 通常不真的刪 row，而是設定：

```typescript
entity.deletedAt = new Date();
await repository.save(entity);
```

讀取時則加上 `deletedAt IS NULL`，或在 `withDeleted: true` 後自行判斷。

Domain 還有額外處理：

- 刪 Participant：不可刪自己，並把其 GroupMember 狀態改成 `left`。
- 刪 Group：設 `isArchived = true`、soft delete，成員狀態改成 `left`。
- 刪 Category：若仍被未刪除 Expense 使用，回傳 `CATEGORY_IN_USE`。
- 刪 Expense：split rows 保留；因 Expense 只是 soft delete，資料仍可供稽核／恢復策略使用。

這和資料庫 FK 的 `CASCADE`／`SET NULL` 是不同層次：FK 行為只在實際刪除 row 時發生。

## 13. QueryBuilder、分頁與統計

`ExpenseService.buildExpenseQuery()` 集中套用：

- `coupleId` 與未刪除條件。
- category、payer、日期區間、金額區間。
- description case-insensitive search。
- 日期與建立時間倒序。

列表把同一個 base query 加上 `skip/take`，上限為 100；統計則 clone 同一組 filters，再執行：

- 總金額與筆數。
- 依 category group by。
- 依付款 participant group by。

因此列表與統計的篩選語意保持一致。新增 filter 時也應優先放進 `buildExpenseQuery()`，避免兩邊產生不同結果。

## 14. API response 與錯誤格式

成功回應通常是：

```json
{
  "success": true,
  "data": {
    "expense": {}
  }
}
```

錯誤由 `common/api-error.ts` 統一建立：

```json
{
  "success": false,
  "error": {
    "code": "INVALID_SPLIT_TOTAL",
    "message": "Split shares must add up to the total amount",
    "field": "splits"
  }
}
```

常用 exception 類別：

- `ApiBadRequestException` → 400。
- `ApiUnauthorizedException` → 401。
- `ApiNotFoundException` → 404。
- `ApiConflictException` → 409。
- `ApiHttpException` → 自訂 status，例如 avatar upload 的 501。

DELETE 成功通常回傳 204，不帶 response body。

## 15. Endpoint 導覽

除註冊、登入、refresh 與根路由外，以下 API 都需要 Bearer access token。

### Auth（目前沒有 `/api` 前綴）

| Method | Route                        | 用途                             |
| ------ | ---------------------------- | -------------------------------- |
| POST   | `/auth/register`             | 建立 User、UserSettings 與 token |
| POST   | `/auth/login`                | 驗證密碼並回傳 token、設定       |
| POST   | `/auth/refresh`              | 用 refresh token 換新 token pair |
| GET    | `/auth/me`                   | 取得目前登入者與設定             |
| PUT    | `/auth/settings/persistence` | 舊的 persistence 設定入口        |

### Users

| Method       | Route                                     | 用途                     |
| ------------ | ----------------------------------------- | ------------------------ |
| GET / PUT    | `/api/users/profile`                      | 取得／更新 profile       |
| POST         | `/api/users/avatar`                       | 尚未實作，回傳 501       |
| GET / PUT    | `/api/users/settings`                     | 取得／更新語言、通知設定 |
| PUT          | `/api/users/settings/persistence`         | 更新 local/cloud 模式    |
| POST / GET   | `/api/users/settings/devices`             | 登記／列出裝置           |
| PUT / DELETE | `/api/users/settings/devices/:deviceUuid` | 更新／移除裝置           |
| GET          | `/api/users/search?q=...&limit=...`       | 搜尋其他使用者           |

### Ledger resources

| Resource     | Routes                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------- |
| Participants | `GET/POST /api/participants`、`PUT/DELETE /api/participants/:participantId`                         |
| Groups       | `GET/POST /api/groups`、`PUT/DELETE /api/groups/:groupId`                                           |
| Categories   | `GET/POST /api/categories`、`GET /api/categories/default`、`PUT/DELETE /api/categories/:categoryId` |
| Expenses     | `GET/POST /api/expenses`、`GET /api/expenses/statistics`、`GET/PUT/DELETE /api/expenses/:expenseId` |

注意 `/api/categories/default` 也在 controller-level guard 之下，所以仍需要 access token。

## 16. 測試架構

Jest 主設定與使用 `AppModule` 的 integration tests 預設：

- `DB_DRIVER=sqljs`。
- `NODE_ENV=test`。
- serial execution（`maxWorkers: 1`），避免共享資料庫互相干擾。
- 每個測試後清理資料。
- 全域 timeout 30 秒。

完整 suite 另外包含 19 個直接呼叫 `createPostgresDataSource()` 的 specs；它們不會因 `DB_DRIVER=sqljs` 而改用 SQL.js。這些 tests 會清空 tables，部分 migration/seed tests 還會 drop database，因此完整 suite 必須明確指定可完全丟棄的獨立 `TEST_DATABASE_URL`。

測試大致分為：

| 目錄                         | 重點                                           |
| ---------------------------- | ---------------------------------------------- |
| `__tests__/api/integration/` | 以 Supertest 驗證真實 HTTP contract            |
| `__tests__/isolated/`        | mock dependencies 的隔離測試                   |
| `__tests__/identity/`        | User、settings、device、auth identity          |
| `__tests__/collaboration/`   | Couple、Participant、Group                     |
| `__tests__/ledger/`          | Expense、Split、Category、soft delete、trigger |
| `__tests__/migrations/`      | migration 正確性                               |
| `__tests__/performance/`     | index、trigger cost、tenant isolation          |

`PerformanceAssertions.testEndpointPerformance()` 預設要求一般 endpoint 小於 500ms；complex query 預算為 2 秒，auth helper 目標為 100ms。

常用指令：

```bash
pnpm --filter api build
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/expense_tracker_test \
  pnpm --filter api test
pnpm --filter api test expense-mobile-compat.spec.ts
pnpm --filter api test participant-group.spec.ts
```

閱讀 API 行為時，integration spec 往往比過時的設計文件更接近可執行規格。例如完整費用生命週期可從 `expense-mobile-compat.spec.ts` 開始。

## 17. 如何新增一個 API 功能

以新增「結算紀錄」為例，建議依序處理：

1. 定義 request/response DTO 和驗證規則。
2. 確認 domain entity 與關聯。
3. 若 schema 改變，同步建立 PostgreSQL migration 與 simple entity。
4. 在 service 中由 `userId` 解析 `coupleId`，實作 tenant-scoped query。
5. 跨多表寫入時使用 transaction。
6. 用 `Api*Exception` 回傳穩定的 error code。
7. Controller 只做 HTTP mapping、DTO validation、呼叫 service、response envelope。
8. 在 module 的 `forFeature()`、`providers`、`exports/imports` 接好 DI。
9. 先寫 integration test 覆蓋成功、驗證失敗、跨 tenant、not found 與刪除行為。
10. 執行 targeted test、API build，必要時再跑完整 test suite。

一個 service method 至少要自問：

- 這筆資料是否限制在使用者的 `coupleId`？
- client 傳入的相關 UUID 是否也屬於同一本帳？
- 操作一半失敗會不會留下不一致資料？
- soft-deleted row 應視為不存在、恢復，還是衝突？
- API error code 是否穩定到能讓 mobile client 判斷？
- SQL.js 與 PostgreSQL 的行為是否都被測到？

## 18. 目前實作的注意事項

以下不是抽象的最佳實務，而是閱讀目前 code 時要知道的現況：

- Auth routes 是 `/auth/*`，其他主要資源是 `/api/*`，全域 `API_PREFIX` 尚未接上。
- 各 controller 重複一份 `validateDto()` 與 `ApiResponse` interface，尚未集中成 global pipe/interceptor。
- `dto/common.dto.ts` 已有共用 response 類別，但多數 controller 目前沒有使用它。
- AuthController 仍有部分 mobile-compatible inline interfaces；UserController 有較完整的 class-validator DTO。
- Auth login response 中 currency/date/split method 有暫時 hard-coded 值。
- `POST /api/users/avatar` 明確回傳 501，尚無上傳流程。
- User persistence mode 同時存在 Auth 舊入口與 Users 新入口，擴充時要避免行為漂移。
- `JwtAuthGuard` 用 `replace('Bearer ', '')` 解析 header，沒有嚴格檢查 scheme；修改時需補相容性測試。
- 正式環境有開發用 JWT fallback secret；部署時必須提供安全的 `JWT_SECRET` 與 `JWT_REFRESH_SECRET`。
- simple entities 是測試便利層，不能取代 PostgreSQL migration/constraint 測試。

## 19. 快速除錯路線

### 401 Unauthorized

1. 檢查 header 是否為 `Authorization: Bearer <token>`。
2. 確認 access token 不是誤用 refresh token。
3. 確認簽發與驗證使用同一個 `JWT_SECRET`。
4. 看 token 的 `sub` 是否對應現有 User。

### 400 INVALID_PARTICIPANTS / CATEGORY_NOT_FOUND / GROUP_NOT_FOUND

UUID 格式可能正確，但資源不屬於當前 `coupleId`，或已 soft delete。從 `LedgerService` 解析出的 ledger 往下追 query 條件。

### 400 INVALID_SPLIT_TOTAL

檢查所有 `share_cents` 相加是否精確等於 `amount_cents`。percentage 模式還需要每筆 `share_percent`，合計誤差不得超過 0.01。

### SQL.js 通過、PostgreSQL 失敗

優先檢查 PostgreSQL-only type、check constraint、migration、index／trigger，以及 simple entity 是否掩蓋了正式 schema 的限制。

## 20. 延伸閱讀

- API source：`apps/api/src/`
- API 測試導讀：`docs/features/testing/GUIDE-API_TESTS.md`
- 資料庫 schema：`docs/features/database/DATABASE_SCHEMA.md`
- Storage 策略：`docs/architecture/STORAGE_STRATEGY.md`
- API integration tests：`apps/api/src/__tests__/api/integration/`
- Migration tests：`apps/api/src/__tests__/migrations/`
- 既有 API 實作文件：`docs/features/api/API_IMPLEMENTATION_DETAILS.md`（部分內容屬早期設計，請以本教學與現行程式碼為準）
