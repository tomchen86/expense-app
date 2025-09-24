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

### Current Refactoring
The codebase is undergoing refactoring per `REFACTORING_PLAN.md`:
- Breaking down large screen components into reusable components
- Extracting business logic into custom hooks
- Centralizing utilities and calculations
- Improving separation of concerns

### Key Features
- Personal and group expense tracking
- Expense splitting between participants
- Category management with custom colors
- Expense insights and analytics
- Participant and group management

## Development Guidelines

### Documentation Standards
- Keep all documentation files in the `/docs` folder
- Maintain a changelog in `/docs/CHANGELOG.md` to record all changes over time
- Document architectural decisions and significant changes

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

## Current Project State (August 2025)

### Critical Issues Status Update  
- **✅ COMPLETED**: `ExpenseInsightsScreen.tsx` - Successfully refactored from 563→83 lines
- **✅ COMPLETED**: `ManageCategoriesScreen.tsx` - Successfully refactored from 402→102 lines  
- **✅ COMPLETED**: `expenseStore.ts` - Successfully refactored from 361→2 lines with modular store architecture
- **✅ COMPLETED**: `AddExpenseScreen.tsx` - Successfully refactored from 313→126 lines
- **🎉 ALL 500-LINE VIOLATIONS RESOLVED**: Mobile codebase now fully compliant with file size standards

### Development Status by App
- **Mobile**: Feature-complete expense tracking app with groups, categories, insights
- **API**: Minimal NestJS scaffold, needs Phase 2 development (see ROADMAP.md)
- **Web**: Basic Next.js setup, no custom functionality implemented

### Recent Documentation Updates
- All strategic planning documents created (ROADMAP.md, PLANNING.md, ARCHITECTURE.md)
- Legacy documents archived to `/docs/archive/`
- Session summary available in `SESSION_SUMMARY.md`

## Development Notes

- Mobile app uses TypeScript throughout with sophisticated domain models
- API follows NestJS conventions but needs database integration and endpoints
- All apps use consistent ESLint configurations
- The mobile app is feature-complete but requires refactoring for maintainability
- Current focus: Execute PLANNING.md to fix file size violations before feature development