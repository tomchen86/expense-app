# Couples Expense App – Architecture & Build Roadmap (May 2025)

This roadmap shows how to start with a **React Native (Expo)** prototype and grow it into a full stack (NestJS API → PostgreSQL/Supabase → OAuth → Next.js web dashboard).

---

## Phase 0 – Scaffold & Source‑Control (½ day)

1. **Create a mono‑repo** (pnpm workspaces or Yarn Berry):

   ```
   apps/
     mobile/   # React Native (Expo)
     web/      # Next.js dashboard
     api/      # NestJS back‑end
   ```

2. **Enable GitHub Actions** with a workflow that runs `pnpm lint && pnpm test`.

---

## Phase 1 – Mobile Click‑Through Prototype (1–2 days)

| Goal            | What to do                                                                                              | Tech snippets                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Basic UX flow   | `npx create-expo-app` → TypeScript template. Build screens **Home → Add Expense → History → Settings**. | • React Navigation (Stack + Bottom Tabs)<br>• Zustand / Redux Toolkit<br>• AsyncStorage for local persistence |
| Rapid iteration | Use **Expo Go** on iOS & Android for hot reload.                                                        | `expo start`                                                                                                  |

_Outcome_: Demo core idea **offline**, collect feedback, add screenshots to CV.

---

## Phase 2 – Back‑End Skeleton (1 day)

1. `nest new api` (TypeScript preset).
2. Add `/health` controller + Jest test (shows TDD).
3. Install **class‑validator / class‑transformer** for DTOs.
4. Local PostgreSQL in Docker:

   ```bash
   docker run -d --name pg -e POSTGRES_PASSWORD=secret -p 5432:5432 postgres:16
   ```

5. First model (`expense.entity.ts`):

   | Column                | Purpose      |
   | --------------------- | ------------ |
   | id                    | PK           |
   | coupleId              | FK           |
   | amount, currency      | Money fields |
   | category, title, date | Metadata     |

---

## Phase 3 – Wire Mobile → API (1 day)

- **Env management** – `.env` + `dotenv`.
- **Networking** – TanStack Query (React Query).
- **Error handling** – Toasts via react‑native‑paper / react‑native‑flash‑message.

---

## Phase 4 – Move Data to the Cloud (Supabase) (½ day)

1. Create free Supabase project; update API `.env.production`.
2. Push schema (Prisma or TypeORM migrations).
3. Configure **Row‑Level Security** so each couple sees only their rows.

---

## Phase 5 – Auth & Couple Context (1 day)

| Choice                           | Why                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| **Supabase Auth (Google/Apple)** | One SDK for mobile & web; free tier.                                                |
| Couple grouping                  | After login, front‑end asks: “Join or create a couple code” → POST `/couples/join`. |

NestJS: use Passport‑Supabase strategy or verify Supabase JWT.

---

## Phase 6 – Dashboard in Next.js (1 day)

1. `npx create-next-app web --ts --tailwind`
2. **App Router (React 18)** with **Server Components**.
3. `@supabase/auth-helpers-nextjs` for SSR session.
4. Charts via TanStack React Charts or Recharts.
5. Deploy preview to **Vercel**; connect to GitHub.

---

## Phase 7 – CI/CD & Infra Polish (1 day)

- GitHub Actions matrix: lint, unit‑tests, build Expo `.apk`, web, Docker API.
- **Terraform or AWS CDK** (optional) for RDS if you outgrow Supabase.
- E2E: Playwright (web), Detox (mobile).

---

## Phase 8 – Résumé Packaging (ongoing)

| Evidence            | Surface it                                                    |
| ------------------- | ------------------------------------------------------------- |
| Production pipeline | GitHub Actions badge, Vercel build logs.                      |
| Clean architecture  | Link to `domain/` and `infra/` folders.                       |
| Testing discipline  | Coverage badge, sample Detox script.                          |
| Polyglot ability    | Branch porting _Add Expense_ screen to Flutter.               |
| Business impact     | Loom video: two phones log expenses → dashboard live‑updates. |

---

### Summary – Why start with React Native?

Phases 1 → 3 let you validate UX rapidly; later phases swap out local storage for network + auth without code throw‑away. Each milestone is résumé‑ready and demonstrates skills Australian employers actively seek.
