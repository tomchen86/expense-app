# JavaScript／TypeScript Web 開發入門指南

_最後核對日期：2026-07-13_

這份指南用一個簡化的「支出管理系統」貫穿以下技術：

- Node.js
- npm、npx、pnpm
- Express.js、NestJS
- RESTful API
- React、Next.js

目標不是背名詞，而是理解每個工具位於哪一層、解決什麼問題，以及它們如何組成一個完整的 Web 應用程式。

> 本文範例偏重觀念，使用現代 JavaScript 與 TypeScript 寫法。不同套件版本產生的預設檔案可能略有差異。

## 1. 先看全貌：這些技術之間有什麼關係？

```text
使用者的瀏覽器
    │
    ▼
React 元件 ── Next.js 網頁應用程式
    │              │
    └──── HTTP ────┘
           │
           ▼
      RESTful API
           │
     Express.js 或 NestJS
           │
           ▼
        Node.js
           │
           ▼
          資料庫

npm / pnpm：安裝與管理以上專案需要的套件
npx：直接執行套件提供的命令列工具
```

簡單來說：

| 技術        | 一句話說明                             | 常見用途                 |
| ----------- | -------------------------------------- | ------------------------ |
| Node.js     | 在瀏覽器以外執行 JavaScript 的執行環境 | 後端、工具、建置程式     |
| npm         | Node.js 生態系常見的套件管理器         | 安裝套件、執行 scripts   |
| npx         | 執行 npm 套件提供的命令                | 建立專案、執行一次性工具 |
| pnpm        | 重視速度與磁碟效率的套件管理器         | monorepo、安裝相依套件   |
| Express.js  | 輕量、自由度高的 Node.js Web 框架      | HTTP Server、REST API    |
| NestJS      | 結構化、以 TypeScript 為核心的後端框架 | 大中型 API、企業應用     |
| RESTful API | 設計 HTTP API 的一組原則               | 前後端交換資料           |
| React       | 用元件建立使用者介面的函式庫           | 互動式網頁 UI            |
| Next.js     | 建立在 React 上的全端 Web 框架         | 網站、SSR、路由、API     |

## 2. Node.js：讓 JavaScript 離開瀏覽器

### 2.1 Node.js 是什麼？

JavaScript 最早主要在瀏覽器執行，例如處理按鈕點擊或修改網頁內容。Node.js 提供另一個執行環境，讓 JavaScript 可以在電腦或伺服器上：

- 讀寫檔案
- 連接資料庫
- 建立 HTTP Server
- 執行自動化腳本
- 開發命令列工具

Node.js 不是程式語言，也不是框架；程式語言仍然是 JavaScript，Node.js 是執行它的環境。

### 2.2 第一個 Node.js 程式

建立 `hello.js`：

```js
const userName = 'Tom';
console.log(`Hello, ${userName}!`);
```

執行：

```bash
node hello.js
```

輸出：

```text
Hello, Tom!
```

這裡的 `node` 是可執行程式，`hello.js` 是交給它執行的檔案。

### 2.3 Node.js 與瀏覽器的差別

兩者都能執行 JavaScript，但提供的 API 不同：

| 功能             | 瀏覽器     | Node.js            |
| ---------------- | ---------- | ------------------ |
| `document`、DOM  | 有         | 預設沒有           |
| `window`         | 有         | 預設沒有           |
| 讀取本機檔案     | 受嚴格限制 | 可使用 `node:fs`   |
| 建立 HTTP Server | 不行       | 可使用 `node:http` |
| `console.log`    | 有         | 有                 |

例如讀取檔案：

```js
import { readFile } from 'node:fs/promises';

const content = await readFile('expenses.json', 'utf8');
console.log(content);
```

### 2.4 非同步與 Event Loop

後端常需要等待檔案、資料庫或網路回應。Node.js 不會在等待期間停止處理所有其他工作，而是透過事件迴圈協調非同步操作。

```js
console.log('1. 開始');

setTimeout(() => {
  console.log('3. 計時器完成');
}, 0);

console.log('2. 繼續執行');
```

輸出順序是 `1 → 2 → 3`。`setTimeout` 的 callback 會等目前同步程式碼完成後才執行，即使等待時間設為 0。

實務上通常使用 Promise 與 `async/await`：

```js
async function loadExpenses() {
  const response = await fetch('http://localhost:3000/expenses');
  const expenses = await response.json();
  return expenses;
}
```

`await` 讓非同步流程容易閱讀，但它只能用在 `async` 函式內，或支援 top-level await 的模組中。

## 3. npm：Node.js 的套件管理器

### 3.1 什麼是套件？

套件是其他開發者發布、可重複使用的程式碼。例如：

- `express`：建立 Web Server
- `react`：建立 UI
- `jest`：執行測試
- `prettier`：統一程式碼格式

npm 同時指：

1. npm Registry：存放公開套件的服務。
2. npm CLI：安裝套件、執行命令的工具。

### 3.2 `package.json` 是專案說明書

在空目錄執行：

```bash
npm init -y
```

會建立基本的 `package.json`。安裝套件並加入 scripts 後，內容可能如下：

```json
{
  "name": "expense-demo",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^5.0.0"
  },
  "devDependencies": {
    "prettier": "^3.0.0"
  }
}
```

重要欄位：

- `scripts`：專案預先定義的命令。
- `dependencies`：程式在正式執行時需要的套件。
- `devDependencies`：開發、測試或建置時才需要的套件。
- `type: "module"`：讓 `.js` 使用 `import`／`export` 的 ES Module 寫法。

### 3.3 常用 npm 命令

```bash
npm install express          # 安裝正式相依套件
npm install -D prettier      # 安裝開發相依套件
npm install                  # 按 package.json 安裝全部套件
npm run start                # 執行 scripts.start
npm test                     # test script 的簡寫
npm uninstall express        # 移除套件
npm outdated                 # 檢查可更新套件
npm ci                       # 依 lockfile 做乾淨且可重現的安裝，常用於 CI
```

安裝後通常會出現：

- `node_modules/`：實際安裝的套件，不應提交 Git。
- `package-lock.json`：記錄精確版本，通常應提交 Git。

版本字串 `^5.0.0` 表示在語意化版本規則下允許相容更新。lockfile 則固定本次解析出的完整相依版本，降低不同電腦安裝出不同結果的機會。

## 4. npx：執行套件提供的命令

npx 通常隨 npm 提供。它的重點不是把套件加入專案，而是執行套件中的 CLI。

例如用 Prettier 檢查檔案：

```bash
npx prettier --check .
```

如果專案已安裝 Prettier，npx 會優先執行本機版本。若未安裝，它可能提示下載後暫時執行。

常見用途：

```bash
npx create-next-app@latest my-web
npx @nestjs/cli@latest new my-api
npx prettier --write src
```

為什麼不全部裝成 global？因為全域版本可能與專案需要的版本不同。使用專案本機版本或明確指定版本，通常更容易重現結果。

### npm 與 npx 的核心差異

```bash
npm install -D prettier      # 把 Prettier 安裝進專案
npx prettier --check .       # 執行 Prettier 的命令
npm run format               # 執行 package.json 中的 format script
```

## 5. pnpm：更節省空間的套件管理器

pnpm 與 npm 處理相同問題：安裝套件、管理版本、執行 scripts。主要差異在安裝策略。

npm 專案通常各自保存大量套件內容；pnpm 會把套件內容集中保存在全域 content-addressable store，再透過連結提供給各專案。因此多個專案使用相同版本時，通常能節省磁碟空間並加快安裝。

### 5.1 常用命令對照

| 目的             | npm                     | pnpm                                      |
| ---------------- | ----------------------- | ----------------------------------------- |
| 安裝全部相依套件 | `npm install`           | `pnpm install`                            |
| 加入正式套件     | `npm install express`   | `pnpm add express`                        |
| 加入開發套件     | `npm install -D jest`   | `pnpm add -D jest`                        |
| 執行 script      | `npm run build`         | `pnpm build`                              |
| 移除套件         | `npm uninstall express` | `pnpm remove express`                     |
| 執行套件 CLI     | `npx prettier`          | `pnpm exec prettier`／`pnpm dlx prettier` |

`pnpm exec` 執行已安裝在專案內的工具；`pnpm dlx` 適合下載並執行一次性工具，概念接近 npx。

### 5.2 pnpm workspace

pnpm 很適合 monorepo，也就是在同一個 Git repository 管理多個應用程式或套件。本專案就是例子：

```text
expense-app/
├── apps/api/
├── apps/mobile/
├── apps/web/
├── package.json
└── pnpm-workspace.yaml
```

可針對特定 workspace 執行命令：

```bash
pnpm --filter api start:dev
pnpm --filter api test --config jest.isolated.config.js
pnpm --filter mobile test
```

> 一個專案應選定一種套件管理器並提交對應 lockfile，避免交替使用 npm 與 pnpm 造成 lockfile 不一致。本專案使用 pnpm。

> 完整 API suite 會清空 PostgreSQL tables，部分 tests 還會 drop database。執行前必須明確設定可完全丟棄的 `TEST_DATABASE_URL`；詳見 `docs/features/testing/GUIDE-API_TESTS.md`。

## 6. Express.js：最小化的 Node.js Web 框架

Node.js 內建 `node:http` 可以建立 Server，但路由、middleware、錯誤處理等工作需要自行組織。Express 提供一層簡潔的抽象。

### 6.1 最小 Express Server

```bash
mkdir express-expense-api
cd express-expense-api
npm init -y
npm pkg set type=module
npm install express
```

建立 `server.js`：

```js
import express from 'express';

const app = express();
const port = 3000;

app.use(express.json());

app.get('/', (request, response) => {
  response.json({ message: 'Expense API is running' });
});

app.listen(port, () => {
  console.log(`Server: http://localhost:${port}`);
});
```

執行 `node server.js`，再開啟 `http://localhost:3000`。

### 6.2 Express CRUD 範例

CRUD 代表 Create、Read、Update、Delete：

```js
let expenses = [{ id: 1, title: '午餐', amount: 120 }];

app.get('/expenses', (req, res) => {
  res.json(expenses);
});

app.get('/expenses/:id', (req, res) => {
  const expense = expenses.find((item) => item.id === Number(req.params.id));
  if (!expense) return res.status(404).json({ message: '找不到支出' });
  res.json(expense);
});

app.post('/expenses', (req, res) => {
  const expense = { id: Date.now(), ...req.body };
  expenses.push(expense);
  res.status(201).json(expense);
});

app.delete('/expenses/:id', (req, res) => {
  expenses = expenses.filter((item) => item.id !== Number(req.params.id));
  res.status(204).send();
});
```

`app.use(express.json())` 是 middleware：它在路由處理前解析 JSON request body。Middleware 常用於登入驗證、日誌、CORS 與錯誤處理。

Express 的優點是簡單且自由；缺點是大型專案若沒有團隊規範，目錄、驗證與錯誤處理方式容易不一致。

## 7. RESTful API：設計前後端溝通方式

API 是軟體之間溝通的介面。REST 是常見的 HTTP API 設計風格，核心是把資料視為「資源」，並利用 HTTP 方法表達動作。

### 7.1 資源與 URL

推薦用名詞表示資源：

```text
GET    /expenses       取得支出列表
GET    /expenses/42    取得 ID 42 的支出
POST   /expenses       新增支出
PATCH  /expenses/42    部分更新 ID 42 的支出
DELETE /expenses/42    刪除 ID 42 的支出
```

避免把動作全部寫入 URL，例如 `/getExpenses`、`/deleteExpense`；HTTP method 已經能表達動作。

### 7.2 Request 的組成

```http
POST /expenses HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{
  "title": "晚餐",
  "amount": 250
}
```

- Method：`POST`
- Path：`/expenses`
- Headers：內容格式、登入憑證等附加資訊
- Body：要新增的資料
- Query string：例如 `/expenses?category=food&page=2`
- Path parameter：例如 `/expenses/42` 中的 `42`

### 7.3 Response 與狀態碼

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "id": 43,
  "title": "晚餐",
  "amount": 250
}
```

常見狀態碼：

| 狀態碼 | 意義                  | 常見情境             |
| ------ | --------------------- | -------------------- |
| 200    | OK                    | 成功取得或更新資料   |
| 201    | Created               | 成功建立資料         |
| 204    | No Content            | 成功刪除且不回傳內容 |
| 400    | Bad Request           | 格式錯誤、驗證失敗   |
| 401    | Unauthorized          | 尚未通過身分驗證     |
| 403    | Forbidden             | 已登入但沒有權限     |
| 404    | Not Found             | 找不到資源           |
| 409    | Conflict              | 資料衝突             |
| 500    | Internal Server Error | Server 未預期錯誤    |

用 curl 測試：

```bash
curl http://localhost:3000/expenses

curl -X POST http://localhost:3000/expenses \
  -H 'Content-Type: application/json' \
  -d '{"title":"咖啡","amount":80}'
```

REST 不等於 JSON，但現代 REST API 很常使用 JSON。良好的 API 還應考慮輸入驗證、認證授權、分頁、一致的錯誤格式與版本管理。

## 8. NestJS：結構化的 Node.js 後端框架

NestJS 是以 TypeScript 為核心的後端框架。它預設可使用 Express 作為底層 HTTP 平台，但加入清楚的架構與功能，例如：

- Module：組織功能
- Controller：接收 HTTP request、回傳 response
- Service／Provider：商業邏輯
- Dependency Injection：自動提供物件相依關係
- Pipe、Guard、Interceptor、Exception Filter：驗證、授權、轉換與錯誤處理

### 8.1 建立 NestJS 專案

```bash
npx @nestjs/cli@latest new expense-api
cd expense-api
npm run start:dev
```

若使用 pnpm，可在建立專案時選 pnpm，之後以 `pnpm start:dev` 啟動。

### 8.2 Controller、Service、Module

`expenses.service.ts`：處理支出的商業邏輯。

```ts
import { Injectable, NotFoundException } from '@nestjs/common';

type Expense = { id: number; title: string; amount: number };

@Injectable()
export class ExpensesService {
  private expenses: Expense[] = [{ id: 1, title: '午餐', amount: 120 }];

  findAll(): Expense[] {
    return this.expenses;
  }

  findOne(id: number): Expense {
    const expense = this.expenses.find((item) => item.id === id);
    if (!expense) throw new NotFoundException('找不到支出');
    return expense;
  }

  create(input: Omit<Expense, 'id'>): Expense {
    const expense = { id: Date.now(), ...input };
    this.expenses.push(expense);
    return expense;
  }
}
```

`expenses.controller.ts`：把 HTTP 路由交給 Service。

```ts
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ExpensesService } from './expenses.service';

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  findAll() {
    return this.expensesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.expensesService.findOne(id);
  }

  @Post()
  create(@Body() body: { title: string; amount: number }) {
    return this.expensesService.create(body);
  }
}
```

`expenses.module.ts`：宣告這個功能包含哪些元件。

```ts
import { Module } from '@nestjs/common';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
```

最後把 `ExpensesModule` 放入根 `AppModule` 的 `imports`。

### 8.3 Dependency Injection 是什麼？

Controller 需要 Service，但沒有自行執行 `new ExpensesService()`：

```ts
constructor(private readonly expensesService: ExpensesService) {}
```

NestJS 的容器會建立並注入 `ExpensesService`。這讓程式較容易替換實作與單元測試，也減少物件之間的緊密耦合。

### 8.4 NestJS 與 Express 怎麼選？

| 比較       | Express                  | NestJS                              |
| ---------- | ------------------------ | ----------------------------------- |
| 定位       | 輕量 Web 框架            | 完整後端應用框架                    |
| 專案結構   | 自己決定                 | 有 Module／Controller／Service 慣例 |
| TypeScript | 支援，但需自行配置       | 一等公民                            |
| 學習門檻   | 較低                     | 較高，需理解裝飾器與 DI             |
| 適合       | 小型服務、原型、高度客製 | 大中型、多人協作、長期維護          |

兩者不是完全對立：NestJS 預設就是建立在 Express adapter 上。學過 Express 後，會更容易理解 NestJS 幫你管理了哪些事情。

## 9. React：用元件建立互動介面

React 是 UI 函式庫。它把畫面拆成可重複使用的 component，並根據 state 重新渲染畫面。

### 9.1 Component、Props、State

```tsx
import { useState } from 'react';

type ExpenseCardProps = {
  title: string;
  amount: number;
};

function ExpenseCard({ title, amount }: ExpenseCardProps) {
  return (
    <li>
      {title}：${amount}
    </li>
  );
}

export default function ExpenseList() {
  const [expenses, setExpenses] = useState([
    { id: 1, title: '午餐', amount: 120 },
  ]);

  function addCoffee() {
    setExpenses([...expenses, { id: Date.now(), title: '咖啡', amount: 80 }]);
  }

  return (
    <main>
      <h1>支出列表</h1>
      <ul>
        {expenses.map((expense) => (
          <ExpenseCard key={expense.id} {...expense} />
        ))}
      </ul>
      <button onClick={addCoffee}>新增咖啡</button>
    </main>
  );
}
```

- Component：回傳 UI 的函式，例如 `ExpenseCard`。
- Props：父元件傳入的資料，例如 `title`、`amount`。
- State：元件內會改變的資料，例如 `expenses`。
- JSX：在 JavaScript／TypeScript 中描述 UI 的語法。
- `key`：協助 React 辨識列表項目的穩定身分，不應隨意使用陣列索引。

不要直接 `expenses.push(...)` 修改 state；應建立新陣列並呼叫 `setExpenses`，讓 React 知道需要更新畫面。

### 9.2 從 REST API 讀資料

在純 client-side React 中，可用 Effect 載入外部資料：

```tsx
import { useEffect, useState } from 'react';

type Expense = { id: number; title: string; amount: number };

export function ExpenseList() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('http://localhost:3000/expenses')
      .then((response) => {
        if (!response.ok) throw new Error('載入失敗');
        return response.json();
      })
      .then(setExpenses)
      .catch((caughtError) => setError(caughtError.message));
  }, []);

  if (error) return <p role='alert'>{error}</p>;
  return <pre>{JSON.stringify(expenses, null, 2)}</pre>;
}
```

實際產品還需要 loading 狀態、取消過期 request、快取與重試；也可使用專門的資料請求函式庫。

React 本身主要處理 UI，不規定檔案路由、Server Rendering 或後端 API。這些能力可以由 Next.js 等框架提供。

## 10. Next.js：建立在 React 上的全端框架

Next.js 提供建立正式 React 應用常需要的整合能力：

- 以檔案系統定義路由
- Server Components 與 Client Components
- Server-side Rendering、Static Generation
- Route Handlers（HTTP endpoints）
- 圖片、字型、metadata 與建置最佳化

### 10.1 建立專案

```bash
pnpm dlx create-next-app@latest expense-web
cd expense-web
pnpm dev
```

使用 App Router 時，`app/expenses/page.tsx` 對應 `/expenses`。

### 10.2 Server Component 直接取得 API 資料

```tsx
type Expense = { id: number; title: string; amount: number };

export default async function ExpensesPage() {
  const response = await fetch('http://localhost:3000/expenses', {
    cache: 'no-store',
  });

  if (!response.ok) throw new Error('無法載入支出');
  const expenses: Expense[] = await response.json();

  return (
    <main>
      <h1>支出列表</h1>
      <ul>
        {expenses.map((expense) => (
          <li key={expense.id}>
            {expense.title}：${expense.amount}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

App Router 的 component 預設是 Server Component，可以在伺服器取得資料，不會把這段資料請求邏輯全部送到瀏覽器。

若元件需要 `useState`、`useEffect`、事件處理或瀏覽器 API，通常要在檔案最上方加入：

```tsx
'use client';
```

不要把整個應用都標成 Client Component；只在需要互動的邊界使用即可。

### 10.3 Next.js Route Handler

`app/api/expenses/route.ts`：

```ts
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json([{ id: 1, title: '午餐', amount: 120 }]);
}

export async function POST(request: Request) {
  const body = await request.json();
  return NextResponse.json({ id: Date.now(), ...body }, { status: 201 });
}
```

現在 `/api/expenses` 本身就是 API endpoint。小型專案可只用 Next.js；若後端有複雜商業邏輯、獨立 mobile client、工作佇列或大型團隊，也常把 NestJS API 與 Next.js Web 分開部署。

### 10.4 React 與 Next.js 的差別

React 提供「如何建立 UI」；Next.js 提供「如何把 React 應用組成完整產品」。使用 Next.js 仍然是在寫 React component，而不是取代 React。

## 11. 一個 request 的完整旅程

假設使用者在 Next.js 頁面新增一筆咖啡支出：

1. React Client Component 收集表單內容。
2. 瀏覽器送出 `POST /expenses`，body 是 JSON。
3. NestJS Controller 接收 request。
4. Validation Pipe 驗證 `title` 與 `amount`。
5. ExpensesService 執行商業邏輯並寫入資料庫。
6. API 回傳 `201 Created` 與新支出。
7. React 更新 state 或重新取得資料。
8. 使用者看到新的支出項目。

這些工具的責任分工是：

```text
React       → 畫面與互動
Next.js     → React 應用的路由、渲染與全端能力
REST/HTTP   → 前後端溝通契約
NestJS      → 後端架構與商業邏輯
Express     → HTTP 處理層（或獨立的輕量 API）
Node.js     → 執行後端 JavaScript
pnpm/npm    → 安裝相依套件、執行專案 scripts
npx/dlx     → 執行建立專案等 CLI 工具
```

## 12. 建議的初學順序

1. JavaScript 基礎：變數、函式、陣列、物件、module、Promise、`async/await`。
2. Node.js：執行檔案、環境變數、檔案系統、HTTP 基礎。
3. npm 或 pnpm：`package.json`、dependencies、scripts、lockfile。
4. HTTP 與 REST：method、status code、headers、JSON、curl。
5. Express：親手建立小型 CRUD API，理解 route 與 middleware。
6. TypeScript：型別、interface、class、generic、decorator 基本觀念。
7. NestJS：Module、Controller、Service、DI、DTO 與驗證。
8. React：component、props、state、事件、表單與資料請求。
9. Next.js：App Router、Server／Client Component、資料取得與部署。

不要同時追求熟練全部框架。先完成一條最小的垂直功能：建立支出 → API 儲存 → 頁面顯示，再逐步加入資料庫、驗證、登入與測試。

## 13. 常見混淆與答案

### Node.js 和 Express/NestJS 是同一類工具嗎？

不是。Node.js 是執行環境；Express 與 NestJS 是在 Node.js 上運作的後端框架。

### npm、npx、pnpm 可以同時使用嗎？

npm 與 pnpm 是替代關係，專案通常選一個。npx 的角色是執行 CLI；pnpm 世界中相近命令是 `pnpm exec` 和 `pnpm dlx`。

### React 是前端框架嗎？

React 官方定位是 UI library。日常對話常被廣義稱為前端框架，但它本身不包辦路由、資料取得與完整應用架構。

### Next.js 可以寫後端，為什麼還要 NestJS？

Next.js Route Handler 足以處理許多全端需求。NestJS 則在複雜領域模型、獨立 API、多種 client、清楚分層與大型團隊協作上更有優勢。選擇取決於系統複雜度，不是越多框架越好。

### 學 NestJS 前一定要學 Express 嗎？

不是硬性要求，但先用 Express 做一個小 API，能幫助你理解 route、middleware、request、response，之後比較不會只是在背 NestJS 裝飾器。

## 14. 在本專案中對照實際結構

本 repository 使用 pnpm workspace：

- `apps/api/`：NestJS 後端 API。
- `apps/mobile/`：React Native 行動端；React 的 component、props、state 等核心觀念同樣適用。
- `apps/web/`：預留的 Web 位置；目前 checkout 沒有可用的 Next.js app 原始碼，開發仍屬 deferred。

常用命令：

```bash
pnpm install
pnpm --filter api start:dev
pnpm --filter api build
pnpm --filter api test --config jest.isolated.config.js
```

完整 API suite 的 PostgreSQL 安全要求與指令請參考 `docs/features/testing/GUIDE-API_TESTS.md`。

閱讀程式時，可以從 NestJS 的 `main.ts` 與根 Module 開始，再依序追蹤某個功能的 Module → Controller → Service。這正好對應本文介紹的後端責任分層。
