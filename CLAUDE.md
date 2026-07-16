# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

This is a monorepo managed by pnpm with three main applications:

- **apps/mobile/** - React Native Expo app for expense tracking
- **apps/api/** - NestJS backend API
- **apps/web/** - Next.js web application

The mobile app is the primary focus and most developed application, implementing a complete expense tracking system with group management.

## Development Commands

### Root Level (pnpm workspace)
```bash
pnpm install          # Install all dependencies across workspace
```

### Mobile App (apps/mobile/)
```bash
pnpm start           # Start Expo development server
pnpm android         # Run on Android
pnpm ios             # Run on iOS
pnpm web             # Run in web browser
```

### API (apps/api/)
```bash
pnpm build           # Build the NestJS application
pnpm start:dev       # Start in development mode with watch
pnpm start:prod      # Start in production mode
pnpm lint            # Run ESLint with auto-fix
pnpm format          # Format code with Prettier
pnpm test            # Run unit tests
pnpm test:e2e        # Run end-to-end tests
pnpm test:cov        # Run tests with coverage
```

### Web App (apps/web/)
```bash
pnpm dev             # Start Next.js development server
pnpm build           # Build for production
pnpm start           # Start production server
pnpm lint            # Run Next.js linter
```

## Mobile App Architecture

### State Management
- **Zustand** for centralized state management in `src/store/expenseStore.ts`
- Store manages expenses, groups, participants, categories, and user settings
- Uses a unique `internalUserId` system for user identification

### Navigation
- **Expo Router** with file-based routing system
- Tab navigation: `app/(tabs)/` with index, history, settings
- Stack screens: `app/add-expense.tsx`, `app/group-detail.tsx`, `app/insights.tsx`, `app/manage-categories.tsx`

### Core Data Models
Key types defined in `src/types/index.ts`:
- `Expense` - individual expense entries with amount, category, date, group assignment
- `ExpenseGroup` - groups for organizing shared expenses with participants
- `Participant` - users who can be part of groups and pay/split expenses
- `Category` - expense categories with names and colors

## Development Guidelines

Always follow TDD and Don't edit test case withou user's permission.

### Code Standards
- Keep TypeScript modules focused and extract components, utilities, or concerns
  when that improves cohesion, testability, or maintainability.
- Do not change, split, or refactor source solely because it exceeds 500 lines.

### Change Management
- Follow the managed lifecycle in `/docs/WORKFLOW.md` for planning, checks,
  completion, and commits.
- Do not create session logs or manual commit logs; Git and workflow reports are
  the execution record.
- Record delivered user-visible outcomes in `/docs/CHANGELOG.md` when relevant.

### Documentation
- **Start here**: `/docs/README.md` — project overview and canonical links
- **Current progress**: `/docs/CURRENT_AND_NEXT_STEPS.md`
- **Workflow & quality gates**: `/docs/WORKFLOW.md`
- **Structure & naming rules**: `/docs/DOCUMENT_STRUCTURE_GUIDE.md`
- **Delivered outcomes**: `/docs/CHANGELOG.md`

## Current Project Status

- **Mobile**: Feature-complete — Expo Router, local-only expense tracking with Zustand
- **Database**: Complete — PostgreSQL schema, TypeORM entities, migrations, seeds
- **API**: In progress — NestJS, mobile-first TDD (Auth → Settings → Categories → Expenses → Migration)
- **Web**: Deferred until API completion

### Key Architecture Notes
- Mobile uses dollars (25.50), database uses cents (2550) — API handles conversion transparently
- API must replicate mobile app's local functionality server-side, not add new features
- Dual persistence: local-only ↔ cloud-sync (see `/docs/architecture/STORAGE_STRATEGY.md`)
