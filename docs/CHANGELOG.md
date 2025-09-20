# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added - September 21, 2025
- **PHASE 2.3 COMPLETED**: Component Test Expansion - Added 83 new component logic tests
- Created comprehensive test suite for ExpenseListItem component (18 tests)
- Created comprehensive test suite for GroupListItem component (15 tests)
- Created comprehensive test suite for FormInput component (18 tests)
- Created comprehensive test suite for FloatingActionButton component (15 tests)
- Created comprehensive test suite for SelectInput component (17 tests)
- **TESTING MILESTONE**: Achieved 235 total tests with 98% pass rate (230 passing)
- Established dependency injection patterns for reliable component testing
- Added comprehensive edge case handling for unicode, special characters, and null values
- Implemented accessibility validation patterns across all component tests
- Added performance testing patterns for debouncing and rapid interaction handling

### Added - September 19, 2025
- Created comprehensive documentation restructure with `/docs` folder
- Added `CLAUDE.md` with development guidelines and 500-line file limit
- Created `/docs/archive/` folder for legacy documentation
- Established new `ROADMAP.md` with 12-18 month strategic development plan
- Created detailed `PLANNING.md` with immediate action items and weekly execution plan
- Added comprehensive `ARCHITECTURE.md` documenting system architecture and technical patterns
- Created `SESSION_SUMMARY.md` documenting development session and key decisions
- Added documentation standards and change management processes
- **MAJOR REFACTORING**: Successfully broke down ExpenseInsightsScreen.tsx from 563→83 lines
- **MAJOR REFACTORING**: Successfully broke down ManageCategoriesScreen.tsx from 402→102 lines
- Created reusable insights components: CategoryChart, InsightsHeader, DatePickerModal
- Created reusable category components: CategoryForm, ColorPicker, CategoryListItem
- Added insightCalculations utility with comprehensive business logic functions
- Created useInsightsData custom hook for state management and data processing
- Created useCategoryManager custom hook for category CRUD operations
- **MAJOR REFACTORING**: Successfully refactored expenseStore.ts from 361→2 lines with feature store composition
- Created modular store architecture with 5 feature stores (category, user, participant, expense, group)
- Implemented store composition pattern maintaining 100% backward compatibility
- Achieved total store architecture reduction: 361 lines → 171 (composed) + 399 (features) = 570 lines (organized)
- **MAJOR REFACTORING**: Successfully refactored AddExpenseScreen.tsx from 313→126 lines (60% reduction)
- Created ExpenseForm component architecture: BasicInfoSection, GroupSection, ExpenseModals
- Added useExpenseModals hook for modal state management and form logic separation
- Achieved complete 500-line violation resolution across entire mobile codebase
- **NEW**: Created comprehensive `FUNCTION_LOG.md` tracking implementation status of 94+ mobile features
- **NEW**: Implemented three-layer planning structure: ROADMAP → PHASE → TASK with completion logs
- **NEW**: Created industrial practice documentation suite (ADRs, Tool Integration, Performance Metrics, Risk Assessment)
- **NEW**: Established `DOCUMENT_STRUCTURE_GUIDE.md` with conditional update optimization for AI-human cooperation
- **NEW**: Added `TESTING_STRATEGY.md` with comprehensive monorepo testing approach
- **NEW**: Created `UPDATE_CHECKLIST.md` with smart conditional update logic

### Fixed - September 19, 2025
- **CRITICAL**: Fixed username bug in composedExpenseStore.ts where Settings page updates weren't reflected in Group creation validation
  - Root cause: Zustand getters didn't trigger component re-renders
  - Solution: Implemented subscription-based state synchronization for userSettings and internalUserId
  - Impact: Group creation now properly recognizes username set in Settings page

### Changed - September 19, 2025
- Moved `CLAUDE.md` from root to `/docs/CLAUDE.md`
- Archived legacy `couples_expense_architecture_roadmap.md` to `/docs/archive/`
- Archived legacy `REFACTORING_PLAN.md` to `/docs/archive/`
- Restructured documentation for better organization and maintenance
- **PLANNING OPTIMIZATION**: Extended Phase 2 timeline from 3-4 weeks to 6-8 weeks for realistic solo development
- **API DESIGN**: Simplified MVP approach using JSON field for expense splits instead of separate table
- **DOCUMENTATION**: Optimized update frequencies - always/conditional/never categories for efficient AI collaboration

### Architecture Documentation Added
- **System Overview**: Current local-only vs. future multi-user architecture diagrams
- **Domain Models**: Complete specifications for Expense, Group, Participant, Category entities
- **App-Specific Patterns**: Mobile (Zustand + React Navigation), API (NestJS), Web (Next.js) architectures
- **Migration Path**: Local-to-server transition strategy with data export/sync patterns
- **Performance & Security**: Scalability considerations and security requirements

### Development Guidelines Established
- **Documentation Standards**: All docs in `/docs` folder with archive system
- **Code Quality**: 500-line file limit with refactoring guidelines  
- **Planning System**: Roadmap for long-term, PLANNING.md for immediate actions
- **Change Tracking**: All significant changes recorded in this changelog

---

## Template for Future Entries

```
## [Version] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Security improvements
```