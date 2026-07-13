# Expense App API 測試導讀與現有測試目錄

> 本文件以 `apps/api/src/__tests__/`、`apps/api/src/app.controller.spec.ts` 與 `apps/api/test/` 的目前程式碼為準。最後核對日期：2026-07-13。

## 1. 這份文件回答什麼？

這份導讀說明：

- API 現在有哪些測試。
- 每個測試檔負責驗證什麼。
- SQL.js、PostgreSQL、HTTP integration 與 isolated test 的差異。
- 預設 Jest 執行範圍與獨立 e2e 範圍。
- 如何執行單一測試、完整測試與 coverage。
- 現有 coverage 的重點與尚未直接覆蓋的區域。

若要先理解 API 本身，請搭配 `docs/features/api/GUIDE-API_CODE.md` 閱讀。

## 2. 目前測試數量快照

以下數量來自測試原始碼靜態計算，並已在 2026-07-13 以 PostgreSQL 完整執行驗證：

| 執行範圍                     | 測試檔 | 宣告的 `it/test` case | 是否在預設 `pnpm --filter api test` |
| ---------------------------- | -----: | --------------------: | ----------------------------------- |
| `src/__tests__/`             |     42 |                   145 | 是                                  |
| `src/app.controller.spec.ts` |      1 |                     1 | 是                                  |
| `test/app.e2e-spec.ts`       |      1 |                     1 | 否，使用 `test:e2e`                 |
| 全部測試原始碼               |     44 |                   147 | 分成兩個 Jest 設定                  |

預設 Jest 範圍合計為 **43 個檔案、146 個靜態 case**；2026-07-13 的完整執行結果為 **43 suites、146 tests 全部通過**。目前沒有找到 `skip`、`todo`、`xit` 或 `xdescribe`。

計數注意事項：

- 這是 2026-07-13 的 code inventory，不是永久常數。
- Jest 實際報告才是 pass/fail 的依據。
- 若未來加入 `it.each()`，一行宣告可能展開成多個 runtime cases。
- 舊摘要中的 38 files／142 tests 已與目前檔案不同。

### 2.1 預設 suite 的分類

| 類別               | 檔案數 | 靜態 cases | 主要目的                                               |
| ------------------ | -----: | ---------: | ------------------------------------------------------ |
| API integration    |      8 |         59 | 真實 HTTP route、response contract、JWT、mobile 相容性 |
| Isolated auth      |      1 |         13 | Mock AuthService/JwtService，隔離 controller 與 guard  |
| Identity           |      8 |         21 | User、Settings、Device、AuthIdentity entity            |
| Collaboration      |      7 |         16 | Couple、Participant、ExpenseGroup、membership          |
| Ledger             |      8 |         16 | Category、Expense、Split、soft delete、trigger         |
| Migrations         |      1 |          2 | migration 正向與 rollback                              |
| Seeds              |      3 |          5 | 預設資料與 idempotency                                 |
| Performance/schema |      3 |          5 | index、tenant isolation、trigger metadata              |
| Setup              |      2 |          3 | DataSource factory 與 PostgreSQL extensions            |
| Database smoke     |      1 |          5 | connection、migration、seed、transaction、helper       |
| Root controller    |      1 |          1 | `AppController` 單元測試                               |

## 3. 測試層次

```mermaid
flowchart BT
    Entity["SQL.js entity tests\n快速驗證 defaults 與基本 constraint"]
    Pg["PostgreSQL integration tests\n驗證 citext/jsonb/check/index/trigger/migration"]
    Http["Nest App + Supertest\n驗證 route、JWT、service、repository 與 response"]
    Isolated["Mock-based isolated tests\n只驗證 controller / guard contract"]
    E2E["獨立 Nest e2e\n目前只有 GET / smoke test"]

    Entity --> Pg
    Isolated --> Http
    Pg --> Http
    Http --> E2E
```

這些層次不是互相取代：

- SQL.js 快，但無法證明 PostgreSQL-only 行為。
- PostgreSQL entity tests 能驗證 schema，卻不保證 HTTP response 正確。
- Isolated tests 很容易定位 controller 問題，但 mock 可能與真實 service 漂移。
- Supertest integration tests 最接近 mobile client 實際使用的 API contract。

## 4. Jest 與資料庫如何啟動

### 4.1 預設 `jest.config.js`

預設設定包含：

- `ts-jest` + Node test environment。
- root 限制在 `apps/api/src`。
- 尋找 `__tests__/**/*.spec.ts` 與其他 `*.spec.ts`。
- 每個 test file 載入 `src/__tests__/setup.ts`。
- timeout 30 秒。
- `maxWorkers: 1`，避免共享資料庫並行互相干擾。
- coverage 排除 migration 與 `main.ts`。

設定檔一開始會預設：

```typescript
process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqljs';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
```

因此使用 `AppModule` 的 API integration tests 預設跑在 SQL.js 上。

### 4.2 全域 `setup.ts`

每個預設 test file 都會：

1. 用 `DatabaseTestHelper` 建立 test DataSource。
2. 執行 migrations（SQL.js 模式沒有 migration files，因此主要由 synchronize 建 schema）。
3. seed mobile 預設分類。
4. 每個 case 後清理測試資料。
5. 最後關閉 DataSource。
6. 將 `log`、`debug`、`info` 替換成 Jest mock，減少測試輸出。

部分 spec 會另外建立自己的 DataSource；因此全域 helper 與測試自己的 connection 可能同時存在。

Performance custom matchers 不是由全域 setup 載入，而是在 spec import `PerformanceAssertions` 時註冊。

### 4.3 PostgreSQL test harness

目前有 19 個 spec 直接 import `createPostgresDataSource()`。Factory 依序嘗試：

1. `TEST_DATABASE_URL`。
2. `COMPOSE_TEST_DATABASE_URL`。
3. 本機 `expense_tracker_dev` URL。
4. 都無法使用時，以 `initdb` 和 `pg_ctl` 啟動暫存 PostgreSQL cluster。

PostgreSQL tests 會執行 migration、`TRUNCATE ... CASCADE`，而 migration 與部分 seed tests 還會呼叫 `dropDatabase()`。

> [!CAUTION]
> `TEST_DATABASE_URL`／`COMPOSE_TEST_DATABASE_URL` 必須指向可完全丟棄的獨立測試資料庫。多個 suite 會 `TRUNCATE` tables，migration 與 seed tests 還可能呼叫 `dropDatabase()`。不要指向 production、共享資料庫或含有重要資料的 development database。

> [!WARNING]
> 若沒有設定上述變數，test harness 目前會嘗試連接本機 `expense_tracker_dev`。因此不要在有本機 PostgreSQL server 時直接執行完整 suite；請先明確設定 disposable `TEST_DATABASE_URL`。若沒有可丟棄的 database，應只執行 isolated 或已確認不使用 PostgreSQL 的測試。

若使用自動暫存 cluster，系統需要可執行 `initdb` 與 `pg_ctl`。

### 4.4 Isolated 設定

`jest.isolated.config.js`：

- 只搜尋 `src/__tests__/isolated`。
- 不載入全域 database setup。
- timeout 10 秒。
- 適合快速驗證 AuthController/JwtAuthGuard contract。

注意 `auth.isolated.spec.ts` 同時符合預設 Jest 的搜尋範圍，所以跑完整 suite 時仍會執行。

### 4.5 E2E 設定

`test/jest-e2e.json` 只搜尋 `*.e2e-spec.ts`。目前只有 `test/app.e2e-spec.ts`，驗證 `GET /` 回傳 `Hello World!`。它不包含在預設 `test` script 中。

## 5. API integration tests

目錄：`apps/api/src/__tests__/api/integration/`

| 檔案                             | Cases | 實際覆蓋                                                                                                                                 |
| -------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-flow.spec.ts`              |    12 | 真實 AppModule 下的 register、duplicate email、required fields、login、invalid credentials、refresh、`/me`、JWT error、persistence mode  |
| `auth-endpoints.spec.ts`         |    10 | Mock AuthService/JwtService 的 HTTP contract、驗證、guard 與 auth performance；雖在 integration 目錄，實際較接近 isolated component test |
| `auth-simple.spec.ts`            |     4 | Auth route smoke 與 100ms response 量測；註解仍保留早期 RED phase 用語，但 endpoint 已存在                                               |
| `user-management.spec.ts`        |    10 | Profile get/update、未登入、currency validation、settings、persistence timestamp、user search 與 auth                                    |
| `user-settings.spec.ts`          |     7 | 語言／通知／push 設定、partial merge、device register/update/delete/list 與 payload validation                                           |
| `category-mobile-compat.spec.ts` |     7 | 新帳本預設分類、create、duplicate、hex color、update、soft delete、default bootstrap endpoint                                            |
| `participant-group.spec.ts`      |     7 | 透過 Participant endpoint 建測試成員，再驗證 Group create/list/update/delete、401、404 與 performance                                    |
| `expense-mobile-compat.spec.ts`  |     2 | 一個大型 lifecycle case 覆蓋 create/get/update/list/statistics/delete；另一個驗證 split total 錯誤                                       |

### 5.1 為什麼 Expense 只有 2 cases 卻覆蓋很多行為？

`expense-mobile-compat.spec.ts` 的第一個 case 是完整情境測試：

```mermaid
flowchart LR
    Register --> SelfParticipant
    SelfParticipant --> Partner
    Partner --> Category
    Category --> CreateExpense
    CreateExpense --> GetExpense
    GetExpense --> ListExpenses
    ListExpenses --> Statistics
    Statistics --> UpdateExpense
    UpdateExpense --> DeleteExpense
```

這種測試能確認多個步驟整合成功，但失敗時定位範圍較大。計算 test coverage 不能只看 case 數量，也要看一個 case 驗證多少 contract。

### 5.2 一般 integration test 結構

```typescript
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
  api = supertest(app.getHttpServer());
});

it('returns a mobile-compatible response', async () => {
  const response = await api
    .get('/api/example')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);

  expect(response.body).toMatchObject({
    success: true,
    data: expect.any(Object),
  });
});
```

這類測試會穿過 route、guard、controller、service、repository 和 test database。

## 6. Isolated authentication tests

| 檔案                             | Cases | 覆蓋                                                                                                                                  |
| -------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------- |
| `isolated/auth.isolated.spec.ts` |    13 | AuthController 的 register/login/refresh/me/persistence mode、mobile error envelope、JwtAuthGuard 無 header／invalid token 與速度要求 |

它建立一個只含 `AuthController`、mock `AuthService`、mock `JwtService` 和真實 `JwtAuthGuard` 的 Nest application，不需要資料庫。

適合回答：

- Controller 有沒有用正確參數呼叫 service？
- Service 丟出的 Api exception 是否被映射成正確 HTTP status/body？
- Guard 是否把 JWT payload 放入 request？

它不能回答：

- bcrypt 與真實 user repository 是否正確。
- migration/schema 是否可用。
- mock response 是否仍與真實 AuthService 一致。

## 7. Identity entity tests

目錄：`apps/api/src/__tests__/identity/`

| 檔案                                  | DB         | Cases | 覆蓋                                                                |
| ------------------------------------- | ---------- | ----: | ------------------------------------------------------------------- |
| `user.entity.spec.ts`                 | SQL.js     |     4 | 建立 User、email unique、defaults、optional fields                  |
| `user.postgres.spec.ts`               | PostgreSQL |     1 | `citext` email 保留大小寫且 case-insensitive unique                 |
| `user-settings.entity.spec.ts`        | SQL.js     |     2 | notification/persistence defaults、每位 User 一筆 settings          |
| `user-settings.postgres.spec.ts`      | PostgreSQL |     3 | JSON defaults、persistence check constraint、primary key uniqueness |
| `user-device.entity.spec.ts`          | SQL.js     |     2 | sync defaults、每位 User/device UUID unique                         |
| `user-device.postgres.spec.ts`        | PostgreSQL |     3 | metadata defaults、sync status check、device unique                 |
| `user-auth-identity.entity.spec.ts`   | SQL.js     |     3 | provider credential、optional token、兩種 unique constraint         |
| `user-auth-identity.postgres.spec.ts` | PostgreSQL |     3 | provider uniqueness、global account identity、JSONB metadata        |

這組測試同時保護 simple entities 和 PostgreSQL entities，避免兩套 schema 在演進時失去一致性。

## 8. Collaboration entity tests

目錄：`apps/api/src/__tests__/collaboration/`

| 檔案                             | DB         | Cases | 覆蓋                                                            |
| -------------------------------- | ---------- | ----: | --------------------------------------------------------------- |
| `couple.entity.spec.ts`          | SQL.js     |     2 | Couple defaults、creator relation、invite code unique           |
| `couple-member.entity.spec.ts`   | SQL.js     |     2 | member/active defaults、composite uniqueness                    |
| `participant.entity.spec.ts`     | SQL.js     |     2 | external participant defaults、couple/user unique               |
| `participant.postgres.spec.ts`   | PostgreSQL |     3 | registered participant 必須連 User、currency regex、soft delete |
| `expense-group.entity.spec.ts`   | SQL.js     |     2 | group defaults／optional fields、color constraint               |
| `expense-group.postgres.spec.ts` | PostgreSQL |     3 | color、currency constraint、archive + soft delete               |
| `group-member.entity.spec.ts`    | SQL.js     |     2 | role/status defaults、group/participant composite primary key   |

## 9. Ledger tests

目錄：`apps/api/src/__tests__/ledger/`

| 檔案                                     | DB         | Cases | 覆蓋                                                                 |
| ---------------------------------------- | ---------- | ----: | -------------------------------------------------------------------- |
| `category.entity.spec.ts`                | SQL.js     |     2 | required/default fields、ledger 內名稱 unique                        |
| `category.postgres.spec.ts`              | PostgreSQL |     3 | `citext` case-insensitive unique、hex constraint、soft delete        |
| `expense.entity.spec.ts`                 | SQL.js     |     2 | defaults/relations、negative amount constraint                       |
| `expense.postgres.spec.ts`               | PostgreSQL |     2 | currency regex、split type check constraint                          |
| `expense-split.entity.spec.ts`           | SQL.js     |     2 | participant/expense unique、share percent 上限                       |
| `soft-delete.spec.ts`                    | PostgreSQL |     2 | Expense soft delete query 行為、Attachment soft delete 不影響 parent |
| `triggers/split-balance.trigger.spec.ts` | PostgreSQL |     2 | split 合計正確可 commit；不等於 Expense amount 時拒絕                |
| `triggers/updated-at.trigger.spec.ts`    | PostgreSQL |     1 | 更新 Expense 後 DB 自動修改 `updated_at`                             |

Trigger tests 必須使用 PostgreSQL，因為 SQL.js 不會重現 PostgreSQL function、deferred constraint trigger 或 timestamp trigger 行為。

## 10. Migration、seed、setup 與 database tests

| 類別／檔案                                 | Cases | 覆蓋                                                                            |
| ------------------------------------------ | ----: | ------------------------------------------------------------------------------- |
| `migrations/identity.migrations.spec.ts`   |     2 | clean DB 順序套用所有 migration；反向逐一 rollback                              |
| `seeds/default-categories.seed.spec.ts`    |     2 | 預設分類寫入、idempotency、自訂分類集合                                         |
| `seeds/default-user-settings.seed.spec.ts` |     2 | 為缺設定的 User 補資料、重複執行不重複建立                                      |
| `seeds/sample-data.seed.spec.ts`           |     1 | deterministic demo dataset 與 idempotency                                       |
| `setup/datasource.factory.spec.ts`         |     2 | SQL.js factory、PostgreSQL factory 與 extensions                                |
| `setup/extensions.spec.ts`                 |     1 | `uuid-ossp`、`citext` extension 查詢                                            |
| `database/connection.spec.ts`              |     5 | test connection、migration 狀態、default categories、transaction、mobile helper |

Migration test 的 rollback case 很重要：它不只證明 `up()` 能建立 schema，也證明 `down()` 能按反向順序清除。

## 11. Performance 與資料隔離測試

| 檔案                                   | Cases | 實際驗證                                                                                   |
| -------------------------------------- | ----: | ------------------------------------------------------------------------------------------ |
| `performance/expense-indexes.spec.ts`  |     3 | 三種 active-row partial index 存在；Expense case 另以 `EXPLAIN` 驗證 query plan 使用 index |
| `performance/tenant-isolation.spec.ts` |     1 | Expense query 以 `couple_id` 限制，不洩漏另一 ledger 資料                                  |
| `performance/trigger-cost.spec.ts`     |     1 | split balance trigger 是 deferrable 且 initially deferred                                  |

另外，多個 API integration tests 使用 `PerformanceAssertions`：

- 一般 endpoint 預設小於 500ms。
- complex query helper 預算 2 秒。
- auth speed helper 目標 100ms。

這些是 test environment 的 regression budget，不等同 production 壓力測試。它們沒有模擬高併發、網路延遲、超大資料量或長時間 soak test。

## 12. Root unit test 與獨立 e2e

| 檔案                         | 執行方式   | Cases | 覆蓋                                       |
| ---------------------------- | ---------- | ----: | ------------------------------------------ |
| `src/app.controller.spec.ts` | 預設 Jest  |     1 | 直接呼叫 `AppController.getHello()`        |
| `test/app.e2e-spec.ts`       | `test:e2e` |     1 | 啟動 AppModule 後以 Supertest 呼叫 `GET /` |

目前獨立 e2e suite 只是 framework smoke test；主要 API 使用情境其實放在 `src/__tests__/api/integration/`。

## 13. Test helpers

| Helper                                  | 用途                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `helpers/database-test-helper.ts`       | 建 DataSource、repositories、fixture data、cleanup、基本 mobile helper                      |
| `helpers/test-data-factories.ts`        | User、Settings、Expense、Group、Participant 等測試物件 factory                              |
| `helpers/mobile-response-validators.ts` | 驗證／轉換 mobile-facing data shape                                                         |
| `helpers/performance-assertions.ts`     | 計時、效能預算與 Jest custom matchers                                                       |
| `setup/datasource.factory.ts`           | SQL.js 與 PostgreSQL DataSource factory                                                     |
| `setup/postgres-test-container.ts`      | 尋找現有 PostgreSQL 或啟動暫存 cluster                                                      |
| `api/setup/test.database.ts`            | API 測試用 datasource 與 cleanup utilities；目前主要 integration specs 多直接載入 AppModule |

新增 fixture 前，先檢查現有 factory 是否已能表達需要的資料，避免每個 spec 自己複製一套不一致的預設值。

## 14. 如何執行

```bash
# 完整 API suite：src 下 43 個檔案；URL 必須是可完全丟棄的獨立測試資料庫
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/expense_tracker_test \
  pnpm --filter api test

# 單一 integration spec
pnpm --filter api test expense-mobile-compat.spec.ts

# 依名稱篩選 case
pnpm --filter api test auth-flow.spec.ts -t "refresh tokens"

# 只跑 isolated config
pnpm --filter api test --config jest.isolated.config.js

# 獨立 Nest e2e
pnpm --filter api test:e2e

# Coverage
pnpm --filter api test:cov

# Watch mode
pnpm --filter api test:watch
```

執行 PostgreSQL specs 前，必須明確提供 disposable database：

```bash
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/expense_tracker_test \
  pnpm --filter api test -- category.postgres.spec.ts
```

不要把上述 URL 換成 production 或含重要資料的 database。

## 15. 新增測試時放在哪裡？

| 想驗證的內容                                  | 建議位置                            |
| --------------------------------------------- | ----------------------------------- |
| Controller + mock service 的錯誤映射          | `__tests__/isolated/`               |
| 真實 route/JWT/service/repository/response    | `__tests__/api/integration/`        |
| Simple entity defaults 或跨 driver 基本行為   | 對應 domain 的 `*.entity.spec.ts`   |
| PostgreSQL-only type/constraint/index         | 對應 domain 的 `*.postgres.spec.ts` |
| Migration up/down                             | `__tests__/migrations/`             |
| Trigger/function                              | `__tests__/ledger/triggers/`        |
| Seed 與 idempotency                           | `__tests__/seeds/`                  |
| Query plan、tenant isolation、metadata budget | `__tests__/performance/`            |
| 真正獨立的 application e2e                    | `apps/api/test/*.e2e-spec.ts`       |

建議 integration case 至少覆蓋：

1. 正常成功回應。
2. 未登入或無權限。
3. DTO validation failure。
4. 不存在或已 soft delete 的 resource。
5. 跨 `couple_id` 存取。
6. 成功／錯誤 response envelope。
7. 有金額時的 cents、split invariant 與 transaction rollback。

## 16. 目前較明顯的 coverage 空白

依現有測試名稱與內容盤點，以下區域尚未看到專門的 API integration case，或目前只被其他情境間接碰到：

- Participant list/update/delete、不能刪除 self、duplicate email 等完整 lifecycle。
- Expense percentage split、重複 participant、payer 不在 splits、category/group 跨 ledger。
- Expense 各種 query filters、pagination boundary 與 100 筆上限。
- Category 被 Expense 使用時的 `CATEGORY_IN_USE`。
- Group owner 不可移除與跨 ledger participant/group isolation。
- `POST /api/users/avatar` 的 501 contract。
- Device update/delete 的 not-found/idempotent edge cases。
- 多數 API resource 的直接 cross-tenant HTTP tests；目前有 database-level tenant isolation sanity test。
- Refresh token 持久化、舊 token 失效、revoke/reuse detection；目前產品程式本身也尚未實作這些能力。
- 高併發、長時間 load/soak 與大量資料 benchmark。

這不表示相關程式一定有問題，只表示目前測試目錄沒有把這些行為獨立鎖定成清楚的 regression contract。

## 17. 閱讀與維護注意事項

- `auth-simple.spec.ts` 仍有「endpoint 尚不存在」的早期 RED-phase 註解，實際 assertions 已在驗證目前 endpoint status。
- `auth-endpoints.spec.ts` 放在 integration 目錄，但 service/JWT 都是 mock；分類時應看測試邊界，不只看資料夾名稱。
- 一些舊文件寫著 142/142 passing；那是歷史快照，不能代表目前 147 個靜態 case 的執行狀態。
- 一個大型 lifecycle case 可能覆蓋許多 endpoint，因此 test count 不是 coverage quality 的唯一指標。
- SQL.js 通過後，仍要為 `citext`、`jsonb`、regex check、trigger、migration 與 index 補 PostgreSQL 測試。
- 測試中若使用固定 email 或唯一鍵，需在 case 間確實清理，或產生唯一資料。

## 18. 延伸閱讀

- API 程式碼與架構：`docs/features/api/GUIDE-API_CODE.md`
- Jest 主設定：`apps/api/jest.config.js`
- Isolated Jest 設定：`apps/api/jest.isolated.config.js`
- E2E Jest 設定：`apps/api/test/jest-e2e.json`
- API integration specs：`apps/api/src/__tests__/api/integration/`
- PostgreSQL test harness：`apps/api/src/__tests__/setup/postgres-test-container.ts`
- 舊測試摘要：`docs/features/testing/summary/API_TEST_SUMMARY.md`（數量與部分描述屬歷史快照）
