# Immediate Action Plan

*Updated: August 26, 2025*

## 🚨 CRITICAL: 500-Line Violations (Fix This Week)

### Priority 1: ExpenseInsightsScreen.tsx (563 lines → <300 lines)
**Current Issues:**
- Massive component with embedded chart logic
- Inline styles and calculations mixed with presentation
- Multiple chart types in single component
- No component reusability

**Refactoring Strategy:**
```
ExpenseInsightsScreen.tsx (current: 563 lines)
├── components/insights/
│   ├── InsightsHeader.tsx (~50 lines)
│   ├── CategoryChart.tsx (~80 lines)
│   ├── SpendingTrendChart.tsx (~75 lines)
│   ├── MonthlyBreakdown.tsx (~60 lines)
│   └── InsightsSummary.tsx (~40 lines)
├── hooks/
│   ├── useInsightsData.ts (~90 lines)
│   └── useChartFilters.ts (~45 lines)
└── utils/
    └── insightCalculations.ts (~120 lines)

Result: ExpenseInsightsScreen.tsx = ~160 lines
```

**Detailed Breakdown Tasks:**
1. **Extract Chart Components** (Day 1-2)
   - Create `components/insights/CategoryChart.tsx` with reusable pie chart
   - Move trend analysis to `SpendingTrendChart.tsx` 
   - Extract monthly breakdown table to `MonthlyBreakdown.tsx`
   - Each component should be <100 lines, pure presentation

2. **Business Logic Extraction** (Day 2-3)
   - Move all calculations to `utils/insightCalculations.ts`
   - Functions: `calculateCategoryTotals`, `generateTrendData`, `computeMonthlyBreakdown`
   - Create proper TypeScript interfaces for chart data
   - Add unit tests for all calculation functions

3. **Custom Hooks** (Day 3-4)
   - `useInsightsData(dateRange, filters)` - handles data fetching and processing
   - `useChartFilters()` - manages filter state (date range, categories, groups)
   - Implement proper loading and error states
   - Add caching for expensive calculations

### Priority 2: ManageCategoriesScreen.tsx (402 lines → <300 lines)
**Current Issues:**
- Category CRUD operations mixed with UI
- Color picker logic embedded
- Modal management scattered throughout

**Refactoring Strategy:**
```
ManageCategoriesScreen.tsx (current: 402 lines)
├── components/categories/
│   ├── CategoryList.tsx (~70 lines)
│   ├── CategoryForm.tsx (~80 lines)
│   ├── ColorPicker.tsx (~60 lines)
│   └── CategoryDeleteModal.tsx (~40 lines)
├── hooks/
│   ├── useCategoryManager.ts (~100 lines)
│   └── useColorSelection.ts (~30 lines)
└── utils/
    └── categoryValidation.ts (~40 lines)

Result: ManageCategoriesScreen.tsx = ~120 lines
```

**Detailed Tasks:**
1. **Extract Form Components** (Day 5)
   - Create reusable `CategoryForm.tsx` with validation
   - Build `ColorPicker.tsx` as standalone component
   - Add proper form state management

2. **Modal Management** (Day 6)
   - Create `CategoryDeleteModal.tsx` with confirmation UI
   - Implement consistent modal patterns across app
   - Add proper accessibility attributes

### Priority 3: AddExpenseScreen.tsx (313 lines → <200 lines)
**Refactoring Strategy:**
```
AddExpenseScreen.tsx (current: 313 lines)
├── components/forms/
│   ├── ExpenseBasicInfo.tsx (~60 lines)
│   ├── ParticipantSelector.tsx (~70 lines)
│   ├── SplitManager.tsx (~80 lines)
│   └── ExpenseFormButtons.tsx (~30 lines)
├── hooks/
│   └── useExpenseFormEnhanced.ts (~150 lines - enhance existing)
└── utils/
    └── splitCalculations.ts (~50 lines)

Result: AddExpenseScreen.tsx = ~140 lines
```

## 📋 Component Library Standardization

### Create Atomic Design System
**Components to Extract (Week 2):**

#### Atoms (Basic Building Blocks)
```
src/components/ui/
├── Button.tsx (variants: primary, secondary, danger)
├── Input.tsx (text, number, email variants)
├── Select.tsx (dropdown with search)
├── DatePicker.tsx (enhance existing)
├── ColorDot.tsx (for category colors)
├── Avatar.tsx (user/participant avatars)
├── Badge.tsx (expense status, amounts)
└── LoadingSpinner.tsx
```

#### Molecules (Component Combinations)
```
src/components/forms/
├── FormField.tsx (label + input + error)
├── CurrencyInput.tsx (amount with currency selector)
├── ParticipantChip.tsx (participant with remove option)
└── CategorySelector.tsx (category dropdown with colors)

src/components/lists/
├── ExpenseItem.tsx (enhanced from existing)
├── ParticipantItem.tsx (for group management)
├── CategoryItem.tsx (for category lists)
└── GroupItem.tsx (for group lists)
```

#### Organisms (Complex Components)
```
src/components/modals/
├── ConfirmationModal.tsx (reusable confirm/cancel)
├── SelectionModal.tsx (enhance existing)
├── FormModal.tsx (modal wrapper for forms)
└── FilterModal.tsx (for expense filtering)

src/components/overlays/
├── LoadingOverlay.tsx
├── ErrorBoundary.tsx
└── OfflineIndicator.tsx
```

## 🔧 Utility Functions & Hooks Organization

### New Utility Structure
```
src/utils/
├── calculations/
│   ├── expenseCalculations.ts (enhance existing)
│   ├── groupCalculations.ts (enhance existing)  
│   ├── splitCalculations.ts (new)
│   └── insightCalculations.ts (new)
├── formatters/
│   ├── currencyFormatter.ts
│   ├── dateFormatter.ts
│   └── numberFormatter.ts
├── validation/
│   ├── expenseValidation.ts
│   ├── categoryValidation.ts
│   └── participantValidation.ts
└── storage/
    ├── asyncStorageHelpers.ts
    └── dataExport.ts
```

### Custom Hooks Expansion
```
src/hooks/
├── forms/
│   ├── useExpenseForm.ts (enhance existing)
│   ├── useCategoryForm.ts
│   └── useParticipantForm.ts
├── data/
│   ├── useExpenseData.ts
│   ├── useInsightsData.ts
│   └── useSyncStatus.ts
├── ui/
│   ├── useModal.ts
│   ├── useToast.ts
│   └── useConfirmation.ts
└── navigation/
    ├── useBackHandler.ts
    └── useDeepLinking.ts
```

## 📊 Store Architecture Improvements

### Break Down expenseStore.ts (361 lines → Multiple Stores)
```
src/store/
├── expenseStore.ts (~150 lines - core expense operations)
├── groupStore.ts (~100 lines - group management)
├── participantStore.ts (~80 lines - participant operations)
├── categoryStore.ts (~60 lines - category management)
├── userStore.ts (~50 lines - user settings)
└── uiStore.ts (~40 lines - UI state, modals, loading)
```

**Migration Strategy:**
1. **Keep Single Store Interface** - don't break existing imports
2. **Use Store Composition** - combine smaller stores into main interface
3. **Gradual Migration** - migrate one feature at a time
4. **Maintain Backwards Compatibility** - existing screens work during refactor

## 🧪 Testing Strategy Implementation

### Test Coverage Goals
- **Unit Tests**: All utils/ functions (target: 100%)
- **Component Tests**: All new components (target: 80%)
- **Integration Tests**: Store operations (target: 90%)
- **E2E Tests**: Critical user paths (target: 5 scenarios)

### Testing Structure
```
src/
├── __tests__/
│   ├── utils/
│   ├── components/
│   ├── hooks/
│   └── stores/
└── e2e/
    ├── addExpense.test.ts
    ├── groupManagement.test.ts
    └── categoryManagement.test.ts
```

## 📅 Weekly Execution Plan

### Week 1: Critical File Size Fixes
**Monday-Tuesday**: ExpenseInsightsScreen refactoring
- Extract chart components
- Move calculations to utils
- Create custom hooks
- Test component integration

**Wednesday-Thursday**: ManageCategoriesScreen refactoring
- Extract form components
- Create modal components
- Implement validation utils
- Add comprehensive testing

**Friday**: AddExpenseScreen refactoring
- Extract form sections
- Enhance existing hooks
- Add split calculations
- Integration testing

### Week 2: Component Library & Architecture
**Monday-Tuesday**: Create atomic design system
- Build basic UI components
- Establish styling patterns
- Create component documentation
- Set up Storybook (optional)

**Wednesday-Thursday**: Extract molecule components
- Build form components
- Create list item components
- Implement modal system
- Add accessibility features

**Friday**: Store architecture improvements
- Break down expenseStore
- Implement store composition
- Migrate one feature completely
- Performance testing

### Week 3: Testing & Polish
**Monday-Tuesday**: Testing implementation
- Unit tests for utilities
- Component testing setup
- Store testing
- E2E test foundation

**Wednesday-Thursday**: Performance optimization
- Bundle size analysis
- React profiler optimization
- Memory leak detection
- Loading state improvements

**Friday**: Documentation & cleanup
- Update component documentation
- Code review and cleanup
- Performance benchmarking
- Prepare for API integration

## 🔍 Code Quality Checks

### Automated Checks (Add to CI)
```bash
# File size validation
find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | awk '$1 > 500 { print "File " $2 " has " $1 " lines (exceeds 500 limit)" }'

# Component complexity check
npm run lint -- --rule 'complexity: [error, { max: 15 }]'

# Import organization
npm run lint -- --rule 'import/order: error'

# TypeScript strict checks
npx tsc --noEmit --strict
```

### Manual Review Checklist
- [ ] Every file under 500 lines
- [ ] No business logic in screen components
- [ ] All calculations in utils/ with tests
- [ ] Consistent naming conventions
- [ ] Proper TypeScript interfaces
- [ ] Error handling implemented
- [ ] Loading states handled
- [ ] Accessibility attributes added

## 📈 Success Metrics

### Quantitative Goals
- **File Count**: 0 files over 500 lines
- **Test Coverage**: >80% for new components
- **Bundle Size**: <10% increase after refactoring
- **Performance**: <100ms screen transition times
- **Type Safety**: 100% TypeScript coverage, strict mode

### Qualitative Goals
- **Maintainability**: New features take 50% less time to implement
- **Code Readability**: New team member can contribute within 2 days
- **Debugging Speed**: Issues can be located and fixed within 30 minutes
- **Component Reusability**: 70% of new screens use existing components

## 🚫 Potential Blockers & Solutions

### Technical Blockers
1. **Zustand Store Migration Complexity**
   - Solution: Gradual migration with facade pattern
   - Fallback: Keep existing store, extract logic only

2. **Component Extraction Breaking Styling**
   - Solution: Move to styled-components or Tamagui
   - Fallback: Maintain inline styles during transition

3. **Testing Setup Complexity**
   - Solution: Start with utils testing only
   - Fallback: Manual testing with detailed checklists

### Resource Blockers
1. **Time Constraints**
   - Solution: Focus on 500-line violations only
   - Defer: Component library can be built incrementally

2. **Breaking Changes Risk**
   - Solution: Feature flags for new components
   - Rollback: Git branching strategy for safe rollbacks

---

*This plan is designed to be executed incrementally. Each task should take 2-4 hours maximum. If any task exceeds this, break it down further or defer to future iterations.*