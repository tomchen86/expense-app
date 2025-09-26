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

The mobile app uses the following key technologies and patterns:

### State Management
- **Zustand** for centralized state management in `src/store/expenseStore.ts`
- Store manages expenses, groups, participants, categories, and user settings
- Uses a unique `internalUserId` system for user identification

### Navigation
- **React Navigation** with stack and bottom tab navigators
- Main screens: Home, History, Settings, AddExpense, ExpenseInsights

### Core Data Models
Key types defined in `src/types/index.ts`:
- `Expense` - individual expense entries with amount, category, date, group assignment
- `ExpenseGroup` - groups for organizing shared expenses with participants
- `Participant` - users who can be part of groups and pay/split expenses
- `Category` - expense categories with names and colors

### Key Features
- Personal and group expense tracking
- Expense splitting between participants
- Category management with custom colors
- Expense insights and analytics
- Participant and group management

## Development Guidelines

Always follow TDD and Don't edit test case withou user's permission.

### Code Standards
- **File Size Limit**: Each code file must not exceed 500 lines
- When a file approaches this limit, refactor by:
  - Extracting components into separate files
  - Moving utility functions to dedicated utility files
  - Breaking down large functions into smaller, focused functions
  - Separating concerns and creating modular architecture

### Change Management
- Record all significant changes in `/docs/CHANGELOG.md`
- Include date, type of change, and brief description
- Track refactoring efforts and architectural improvements
- Write a session summary or task complete log if significant change has been made.

## Current Project State (September 2025)

### Phase 2: API Development Status
- **✅ COMPLETED**: Mobile app - Feature-complete with 294/294 tests passing, all file size violations resolved
- **✅ COMPLETED**: Database schema (Task 2.1) - Complete PostgreSQL schema with 33/33 tests passing
  - 8 migrations implemented (001-008: extensions, identity, collaboration, ledger, indexes, triggers, soft deletes)
  - 14 TypeORM entities with full TDD coverage
  - Comprehensive seeding system for default categories and sample data
- **🚧 IN PROGRESS**: TDD API Implementation (Task 2.2) - Following strict Red-Green-Refactor methodology
  - Mobile app data structures analyzed and documented
  - Strategic TDD implementation plan created with mobile-first design
  - Test infrastructure being established for mobile compatibility

### Development Status by App
- **Mobile**: 100% complete - 294/294 tests, feature-complete expense tracking with local-only storage
- **Database**: 100% complete - Full PostgreSQL schema with TDD coverage and seed data
- **API**: 15% complete - NestJS scaffold with TypeORM config, implementing TDD methodology for mobile compatibility
- **Web**: Basic Next.js setup, deferred until API completion

### Current Focus: Mobile-First API Development
- **Critical Path**: Authentication → User Settings → Category Sync → Expense Sync → Data Migration
- **Methodology**: Strict TDD with mobile app compatibility as primary requirement
- **Goal**: Enable mobile app's transition from local-only to cloud-sync persistence mode

### Key Documentation
- `/docs/TDD_API_IMPLEMENTATION_PLAN.md` - Polished strategic plan for API development
- `/docs/mobile-app-analysis.md` - Complete analysis of mobile app data structures for API compatibility
- `/docs/DATABASE_SCHEMA.md` - Complete database schema documentation
- `/docs/STORAGE_STRATEGY.md` - Dual persistence architecture (local-only ↔ cloud-sync)

## Development Notes

- **Mobile App**: Feature-complete local-only expense tracking with sophisticated Zustand state management
- **Database Layer**: Production-ready PostgreSQL schema with comprehensive migrations and TDD coverage
- **API Strategy**: Mobile-first TDD approach ensuring exact compatibility with existing mobile app interfaces
- **Critical Insight**: API must exactly replicate mobile app's local functionality server-side, not add new features
- **Data Compatibility**: Mobile uses dollars (25.50), database uses cents (2550) - API handles conversion transparently