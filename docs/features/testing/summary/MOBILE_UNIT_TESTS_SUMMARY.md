# Mobile Unit Tests Summary

## Overview

The React Native Expo mobile app has **23 unit test files** covering **5 main domains**: Components, Utils, Hooks, Store, and Performance. The unit test suite validates isolated component logic, business calculations, state management operations, and performance characteristics across 268 test cases.

## Test Philosophy

Unit tests focus on:

- **Isolated Logic**: Testing components and functions in isolation with mocked dependencies
- **Business Rules**: Validating calculation accuracy and data transformation logic
- **State Management**: Testing Zustand store operations and state synchronization
- **Edge Cases**: Comprehensive testing of boundary conditions and error scenarios
- **Type Safety**: TypeScript-based tests ensuring type correctness

## Components

### CategoryChart-simple.test.ts

**Test Suite**: `CategoryChart Logic`

#### Test Cases:

1. **`should handle valid chart data`**
   - **Behavior**: Processes chart data points and transforms them for chart rendering
   - **Validates**: Data transformation, percentage formatting, and value mapping

2. **`should handle empty data`**
   - **Behavior**: Gracefully handles empty data arrays
   - **Validates**: Returns empty array for no data input

3. **`should format percentages correctly`**
   - **Behavior**: Formats numerical percentages with proper decimal places
   - **Validates**: Consistent percentage display formatting (e.g., "60.0%", "33.3%")

4. **`should determine legend visibility logic`**
   - **Behavior**: Determines when chart legend should be displayed
   - **Validates**: Legend shows only when data exists and showLegend is true

5. **`should validate hex colors`**
   - **Behavior**: Validates hex color code format
   - **Validates**: Proper 6-character hex color validation

6. **`should provide fallback colors`**
   - **Behavior**: Provides default color when invalid color is supplied
   - **Validates**: Fallback to default gray color (#757575) for invalid inputs

### CategoryForm-logic.test.ts

**Test Suite**: `CategoryForm Logic`

#### Test Cases:

1. **`should validate category name`**
   - **Behavior**: Validates category name requirements and constraints
   - **Validates**: Required field, length limits (50 chars), non-empty strings

2. **`should validate color format`**
   - **Behavior**: Validates hex color code format for category colors
   - **Validates**: Required field, valid 6-character hex format

3. **`should validate complete form`**
   - **Behavior**: Validates entire category form before submission
   - **Validates**: All required fields present and valid

4. **`should generate unique category ID`**
   - **Behavior**: Creates unique identifiers for new categories
   - **Validates**: ID generation with timestamp and name-based prefix

5. **`should check for duplicate names`**
   - **Behavior**: Prevents duplicate category names (case-insensitive)
   - **Validates**: Duplicate detection with exclusion for self-editing

6. **`should provide default colors`**
   - **Behavior**: Suggests unused default colors from predefined palette
   - **Validates**: Color availability and fallback to first color when all used

7. **`should handle form state updates`**
   - **Behavior**: Manages form field state changes
   - **Validates**: Immutable state updates for form fields

8. **`should reset form to initial state`**
   - **Behavior**: Resets form to clean initial state
   - **Validates**: All fields return to default values

### ExpenseListItem-logic.test.ts

**Test Suite**: `ExpenseListItem Logic`

#### Test Cases:

1. **`should find payer when participant exists`**
   - **Behavior**: Resolves payer participant from expense data
   - **Validates**: Correct participant lookup by ID

2. **`should return null when paidBy is not set`**
   - **Behavior**: Handles expenses without assigned payer
   - **Validates**: Graceful handling of undefined payer

3. **`should return null when participant not found`**
   - **Behavior**: Handles missing participant references
   - **Validates**: Safe handling of orphaned participant IDs

4. **`should handle null allParticipants gracefully`**
   - **Behavior**: Handles null participant arrays
   - **Validates**: Null-safe participant resolution

5. **`should format display amount correctly`**
   - **Behavior**: Formats monetary amounts for display
   - **Validates**: Proper currency formatting with 2 decimal places

6. **`should determine when to show group tag`**
   - **Behavior**: Shows group indicator when expense belongs to group
   - **Validates**: Group context display logic

7. **`should determine when to show payer information`**
   - **Behavior**: Shows payer info when payer exists
   - **Validates**: Conditional payer display logic

8. **`should determine when to show caption`**
   - **Behavior**: Shows expense caption when non-empty
   - **Validates**: Caption visibility with trimming logic

9. **`should prepare edit action data`**
   - **Behavior**: Prepares data structure for expense editing
   - **Validates**: Action data format for edit operations

10. **`should prepare delete confirmation data`**
    - **Behavior**: Prepares confirmation dialog data for deletion
    - **Validates**: Confirmation dialog content and structure

11. **`should validate callback functions exist`**
    - **Behavior**: Validates required callback functions are provided
    - **Validates**: Function type checking for required callbacks

12. **`should validate required expense properties`**
    - **Behavior**: Validates expense object has all required fields
    - **Validates**: Required field validation and error collection

13. **`should validate display amount consistency`**
    - **Behavior**: Ensures display amount doesn't exceed original amount
    - **Validates**: Amount validation for split expense scenarios

14. **`should validate required props are provided`**
    - **Behavior**: Validates component receives all required props
    - **Validates**: Comprehensive prop validation with error reporting

15. **`should handle missing optional properties gracefully`**
    - **Behavior**: Handles optional expense properties safely
    - **Validates**: Optional field processing and default handling

16. **`should handle empty participants array`**
    - **Behavior**: Handles empty participant collections
    - **Validates**: Safe handling of empty arrays

17. **`should handle very long text content`**
    - **Behavior**: Truncates long text content for display
    - **Validates**: Text truncation with ellipsis for long content

### GroupListItem-logic.test.ts

**Test Suite**: `GroupListItem Logic`

#### Test Cases:

1. **`should format total amount correctly`**
   - **Behavior**: Formats group total amounts for display
   - **Validates**: Currency formatting with proper decimal handling

2. **`should handle edge case amounts`**
   - **Behavior**: Handles extreme numerical values properly
   - **Validates**: Proper rounding and formatting for edge cases

3. **`should count participants correctly`**
   - **Behavior**: Counts group participants including empty groups
   - **Validates**: Participant count calculation and null safety

4. **`should validate participant removal eligibility`**
   - **Behavior**: Determines if participant can be removed from group
   - **Validates**: Removal rules (minimum participants, participant exists)

5. **`should find participant by id`**
   - **Behavior**: Locates specific participant within group
   - **Validates**: Participant lookup and undefined handling

6. **`should validate new participant addition`**
   - **Behavior**: Validates new participant before adding to group
   - **Validates**: Name requirements, length limits, duplicate prevention

7. **`should prepare group navigation data`**
   - **Behavior**: Prepares data for group detail navigation
   - **Validates**: Navigation payload structure

8. **`should prepare delete confirmation data`**
   - **Behavior**: Prepares group deletion confirmation dialog
   - **Validates**: Confirmation message content and context

9. **`should prepare participant removal data`**
   - **Behavior**: Prepares participant removal confirmation
   - **Validates**: Removal confirmation message and validation

10. **`should validate callback functions exist`**
    - **Behavior**: Validates all required callback functions are provided
    - **Validates**: Function type checking for group operations

11. **`should validate group structure`**
    - **Behavior**: Validates group object has required properties
    - **Validates**: Required field validation for group data

12. **`should validate total amount is reasonable`**
    - **Behavior**: Validates group total amounts are valid numbers
    - **Validates**: Number validation, finite check, reasonable ranges

13. **`should validate all required props are provided`**
    - **Behavior**: Validates component receives all required props
    - **Validates**: Comprehensive prop validation for group item

14. **`should handle empty participants array gracefully`**
    - **Behavior**: Handles groups with no participants
    - **Validates**: Empty state handling and messaging

15. **`should handle very long group names`**
    - **Behavior**: Truncates long group names for display
    - **Validates**: Text truncation with ellipsis

16. **`should handle participant names with special characters`**
    - **Behavior**: Processes participant names with special characters
    - **Validates**: Special character handling and name sanitization

### FormInput-logic.test.ts

**Test Suite**: `FormInput Logic` (Basic)

#### Test Cases:

1. **`should validate required props`**
   - **Behavior**: Validates essential props for form input component
   - **Validates**: Label, value, and onChange callback requirements

2. **`should validate optional props have correct types`**
   - **Behavior**: Type-checks optional props for form input
   - **Validates**: Proper types for placeholder, keyboard type, multiline options

3. **`should use default keyboard type when not specified`**
   - **Behavior**: Applies default keyboard type when none provided
   - **Validates**: Default keyboard behavior

4. **`should validate keyboard type options`**
   - **Behavior**: Validates keyboard type against allowed values
   - **Validates**: Keyboard type validation against predefined list

5. **`should suggest appropriate keyboard types for common inputs`**
   - **Behavior**: Suggests optimal keyboard based on label/placeholder
   - **Validates**: Smart keyboard type suggestions (email, phone, numeric)

6. **`should determine when multiline should be enabled`**
   - **Behavior**: Determines multiline mode based on props
   - **Validates**: Multiline logic based on explicit setting or line count

7. **`should calculate appropriate number of lines`**
   - **Behavior**: Calculates optimal line count for multiline inputs
   - **Validates**: Line count calculation with defaults and bounds

8. **`should set appropriate text alignment for multiline`**
   - **Behavior**: Sets text alignment based on multiline mode
   - **Validates**: Top alignment for multiline, center for single line

9. **`should validate text input based on keyboard type`**
   - **Behavior**: Validates input content matches keyboard type expectations
   - **Validates**: Format validation for numeric, email, phone inputs

10. **`should validate input length constraints`**
    - **Behavior**: Validates input length against min/max limits
    - **Validates**: Length validation with error messaging

### FormInput-advanced.test.ts

**Test Suite**: `FormInput Advanced Logic`

#### Test Cases:

11. **`should handle text transformation based on input type`**
    - **Behavior**: Transforms text based on specified transformation type
    - **Validates**: Text transformations (uppercase, lowercase, trim, etc.)

12. **`should handle debounced text changes`**
    - **Behavior**: Implements debounced input handling to reduce calls
    - **Validates**: Debounce timing and callback execution

13. **`should track text change history`**
    - **Behavior**: Maintains history of text changes for undo functionality
    - **Validates**: History management with size limits and undo operations

14. **`should generate appropriate accessibility props`**
    - **Behavior**: Creates accessibility properties for screen readers
    - **Validates**: Accessibility labels, hints, and roles

15. **`should validate accessibility requirements`**
    - **Behavior**: Ensures accessibility standards are met
    - **Validates**: Required accessibility properties and guidelines

16. **`should handle empty and null values gracefully`**
    - **Behavior**: Safely processes null/undefined input values
    - **Validates**: Null safety and type conversion

17. **`should handle special characters and unicode`**
    - **Behavior**: Processes special characters and unicode content
    - **Validates**: Unicode support, emoji detection, byte length calculation

18. **`should handle rapid text changes without performance issues`**
    - **Behavior**: Maintains performance during rapid input changes
    - **Validates**: Performance metrics and change throttling

### FloatingActionButton-logic.test.ts

**Test Suite**: `FloatingActionButton Logic`

#### Test Cases:

1. **`should navigate to AddExpense screen without groupId when no custom onPress`**
   - **Behavior**: Default navigation behavior to add expense screen
   - **Validates**: Navigation call with correct screen name and no params

2. **`should navigate to AddExpense screen with groupId when provided`**
   - **Behavior**: Navigation with group context when groupId available
   - **Validates**: Navigation call with groupId parameter

3. **`should call custom onPress handler when provided instead of navigating`**
   - **Behavior**: Custom action takes precedence over default navigation
   - **Validates**: Custom callback execution, navigation prevention

4. **`should prioritize custom onPress over navigation even with groupId`**
   - **Behavior**: Custom handler overrides even when groupId present
   - **Validates**: Custom action priority over contextual navigation

5. **`should validate optional props have correct types`**
   - **Behavior**: Type validation for optional props
   - **Validates**: Function, string, and object type checking

6. **`should handle undefined and null props gracefully`**
   - **Behavior**: Safe handling of undefined/null prop values
   - **Validates**: Null safety and property existence checks

7. **`should validate groupId format`**
   - **Behavior**: Validates groupId follows expected format rules
   - **Validates**: Format validation, length limits, character restrictions

8. **`should prepare navigation params correctly`**
   - **Behavior**: Formats navigation parameters properly
   - **Validates**: Parameter formatting and trimming

9. **`should merge custom styles with default styles`**
   - **Behavior**: Combines custom styles with component defaults
   - **Validates**: Style merging for object and array styles

10. **`should validate style properties`**
    - **Behavior**: Validates style object properties are valid
    - **Validates**: Style property validation and warning generation

11. **`should generate appropriate accessibility props`**
    - **Behavior**: Creates accessibility properties based on context
    - **Validates**: Context-aware accessibility labels and hints

12. **`should handle rapid taps gracefully`**
    - **Behavior**: Prevents rapid-fire button activation
    - **Validates**: Tap throttling and cooldown periods

13. **`should track button state for visual feedback`**
    - **Behavior**: Manages button state for press feedback
    - **Validates**: Press state management and disabled state handling

14. **`should handle navigation errors gracefully`**
    - **Behavior**: Safe navigation with error handling
    - **Validates**: Error catching and graceful failure handling

15. **`should handle missing screen names`**
    - **Behavior**: Validates screen names against known screens
    - **Validates**: Screen name validation and trimming

### HomeScreen-logic.test.ts

**Test Suite**: `HomeScreen Logic`

#### Test Cases:

1. **`should sort expenses by date (newest first)`**
   - **Behavior**: Sorts expense list with most recent expenses first
   - **Validates**: Date-based sorting algorithm accuracy

2. **`should group expenses by date for display`**
   - **Behavior**: Groups expenses by date for sectioned display
   - **Validates**: Date grouping and section organization

3. **`should calculate daily totals`**
   - **Behavior**: Sums expenses for daily total calculation
   - **Validates**: Accurate sum calculation for grouped expenses

4. **`should format currency display`**
   - **Behavior**: Formats amounts using currency formatting
   - **Validates**: Locale-aware currency formatting with proper symbols

5. **`should determine FAB visibility based on scroll`**
   - **Behavior**: Controls floating action button visibility during scroll
   - **Validates**: Scroll-based visibility logic

6. **`should handle FAB tap action`**
   - **Behavior**: Handles floating action button press
   - **Validates**: Navigation trigger on FAB press

7. **`should position FAB correctly`**
   - **Behavior**: Calculates floating action button position
   - **Validates**: Position calculation with safe area considerations

8. **`should calculate current period total`**
   - **Behavior**: Calculates totals for current time period (day/week/month)
   - **Validates**: Period-based expense filtering and summation

9. **`should format total with proper separators`**
   - **Behavior**: Formats large amounts with thousand separators
   - **Validates**: Number formatting for readability

10. **`should handle zero and negative totals`**
    - **Behavior**: Properly displays zero and negative amounts
    - **Validates**: Special case formatting for edge amounts

11. **`should calculate category breakdown for quick view`**
    - **Behavior**: Creates category summary for overview display
    - **Validates**: Category aggregation and sorting by amount

12. **`should show appropriate empty state message`**
    - **Behavior**: Shows contextual messages when no expenses exist
    - **Validates**: First-time vs returning user messaging

13. **`should show empty state with action button`**
    - **Behavior**: Provides action button in empty state
    - **Validates**: Empty state call-to-action configuration

14. **`should handle loading state`**
    - **Behavior**: Shows appropriate loading messages
    - **Validates**: Loading state messaging based on data presence

15. **`should format expense item for list display`**
    - **Behavior**: Formats expense data for list item display
    - **Validates**: Data transformation for list rendering

16. **`should handle expense item tap action`**
    - **Behavior**: Handles expense item selection/editing
    - **Validates**: Navigation to edit screen with expense ID

17. **`should determine expense item swipe actions`**
    - **Behavior**: Provides contextual swipe actions based on user role
    - **Validates**: Role-based action availability

18. **`should handle pull-to-refresh`**
    - **Behavior**: Manages pull-to-refresh functionality
    - **Validates**: Refresh state management and completion handling

19. **`should determine if sync is needed`**
    - **Behavior**: Determines when data synchronization is required
    - **Validates**: Time-based sync threshold logic

20. **`should handle sync status display`**
    - **Behavior**: Shows appropriate sync status messages
    - **Validates**: Status messaging based on connectivity and sync state

### SelectInput-logic.test.ts

**Test Suite**: `SelectInput Logic`

#### Test Cases:

1. **`should display selected value when available`**
   - **Behavior**: Shows selected value or placeholder text
   - **Validates**: Value display logic with fallback handling

2. **`should handle custom placeholder text`**
   - **Behavior**: Uses custom placeholder when provided
   - **Validates**: Placeholder customization and fallback

3. **`should determine when value is placeholder`**
   - **Behavior**: Identifies when displaying placeholder vs actual value
   - **Validates**: Placeholder state detection logic

4. **`should handle whitespace-only values`**
   - **Behavior**: Treats whitespace-only values as empty
   - **Validates**: Whitespace trimming and empty state handling

5. **`should validate required props`**
   - **Behavior**: Validates essential props for select input component
   - **Validates**: Required prop validation and error reporting

6. **`should validate optional props have correct types`**
   - **Behavior**: Type-checks optional props for select input
   - **Validates**: Optional prop type validation

7. **`should track selection interactions`**
   - **Behavior**: Tracks user interaction with select component
   - **Validates**: Interaction counting and timing

8. **`should handle rapid taps gracefully`**
   - **Behavior**: Prevents rapid-fire selection activation
   - **Validates**: Tap throttling and cooldown management

9. **`should validate onPress callback execution`**
   - **Behavior**: Validates callback function execution safety
   - **Validates**: Function validation and error handling

10. **`should merge styles correctly`**
    - **Behavior**: Combines custom styles with component defaults
    - **Validates**: Style merging for various input formats

11. **`should determine placeholder style application`**
    - **Behavior**: Applies placeholder-specific styling when appropriate
    - **Validates**: Conditional style application

12. **`should validate style objects`**
    - **Behavior**: Validates style object properties
    - **Validates**: Style property validation and warning generation

13. **`should generate appropriate accessibility props`**
    - **Behavior**: Creates accessibility properties for screen readers
    - **Validates**: Accessibility label, hint, and value generation

14. **`should validate accessibility requirements`**
    - **Behavior**: Ensures accessibility standards compliance
    - **Validates**: Accessibility requirement validation

15. **`should handle special characters in values`**
    - **Behavior**: Processes values with special characters and unicode
    - **Validates**: Special character handling and unicode support

16. **`should handle null and undefined selectedValue gracefully`**
    - **Behavior**: Safely processes null/undefined values
    - **Validates**: Null safety and consistent fallback behavior

17. **`should handle very long labels and values`**
    - **Behavior**: Truncates long text content for display
    - **Validates**: Text truncation with ellipsis

### HistoryScreen-logic.test.ts

**Test Suite**: `HistoryScreen Logic`

#### Test Cases:

1. **`should sort groups by most recent activity`**
   - **Behavior**: Sorts group list by last activity date
   - **Validates**: Activity-based sorting algorithm

2. **`should calculate group member count display`**
   - **Behavior**: Formats member count for display with limits
   - **Validates**: Member count formatting with overflow handling

3. **`should format group summary information`**
   - **Behavior**: Creates comprehensive group summary data
   - **Validates**: Summary calculation including totals and activity

4. **`should handle empty groups display`**
   - **Behavior**: Shows appropriate messages for empty group state
   - **Validates**: Empty state messaging based on user setup status

5. **`should calculate individual balances in group`**
   - **Behavior**: Calculates what each member owes or is owed
   - **Validates**: Balance calculation for equal splitting

6. **`should format balance display`**
   - **Behavior**: Formats balance amounts with proper messaging
   - **Validates**: Balance display with owed/owes/settled messaging

7. **`should calculate settlement suggestions`**
   - **Behavior**: Suggests optimal settlements to balance group
   - **Validates**: Settlement algorithm for debt optimization

8. **`should handle group item tap`**
   - **Behavior**: Navigates to group detail screen
   - **Validates**: Navigation with group ID parameter

9. **`should handle add group action`**
   - **Behavior**: Handles new group creation with username validation
   - **Validates**: Username requirement checking and navigation

10. **`should determine group action menu options`**
    - **Behavior**: Provides contextual actions based on user role
    - **Validates**: Owner vs member action availability

11. **`should filter groups by search query`**
    - **Behavior**: Filters group list based on search input
    - **Validates**: Text search across group names and participants

12. **`should sort filtered results by relevance`**
    - **Behavior**: Sorts search results by relevance score
    - **Validates**: Relevance calculation and ranking

13. **`should handle empty search state`**
    - **Behavior**: Shows appropriate messages for empty search results
    - **Validates**: Search empty state messaging

14. **`should calculate group activity summary`**
    - **Behavior**: Creates activity summary with monthly comparisons
    - **Validates**: Activity calculation and trend analysis

15. **`should format activity trends`**
    - **Behavior**: Formats activity trend messages
    - **Validates**: Trend calculation and percentage change formatting

### SettingsScreen-logic.test.ts

**Test Suite**: `SettingsScreen Logic`

#### Test Cases:

1. **`should validate username requirements`**
   - **Behavior**: Validates username format and constraints
   - **Validates**: Length limits, character restrictions, required field

2. **`should check for reserved usernames`**
   - **Behavior**: Prevents use of reserved system usernames
   - **Validates**: Reserved name checking (case-insensitive)

3. **`should handle settings updates`**
   - **Behavior**: Updates user settings with proper state management
   - **Validates**: Immutable state updates for settings

4. **`should validate complete settings`**
   - **Behavior**: Validates entire settings object before saving
   - **Validates**: Comprehensive settings validation

5. **`should determine navigation options`**
   - **Behavior**: Sets navigation options based on unsaved changes
   - **Validates**: Navigation header configuration

6. **`should handle save confirmation`**
   - **Behavior**: Shows save confirmation when navigating with changes
   - **Validates**: Unsaved changes detection and confirmation logic

7. **`should format settings for storage`**
   - **Behavior**: Prepares settings data for persistence
   - **Validates**: Storage format with metadata addition

8. **`should handle settings migration`**
   - **Behavior**: Migrates legacy settings to current format
   - **Validates**: Version-based migration logic

## Utils

### insightCalculations.test.ts

**Test Suite**: `insightCalculations`

#### Test Cases:

1-37. **Category Totals, Chart Data, Date Filtering, Period Navigation**

- Comprehensive testing of expense aggregation by category
- Chart data generation with percentage calculations
- Date filtering by year, month, and custom periods
- Period navigation with future period prevention
- Display text formatting for different time aggregations

### simple.test.ts

**Test Suite**: `Insight Calculations`

#### Test Cases:

1-17. **Basic Calculations and Navigation**

- Total calculation and empty state handling
- Year and month filtering
- Period navigation (previous/next)
- Current period detection and future blocking

### expenseCalculations.test.ts

**Test Suite**: `expenseCalculations`

#### Test Cases:

1. **`sums all expense amounts`**
   - Calculates total of all expense amounts

2. **`returns zero when there are no expenses`**
   - Handles empty expense array

3-8. **Split Expense Calculations**

- Equal split calculation for participants
- Non-participant share calculation
- Personal expense vs split expense handling
- Anonymous user expense calculation

### groupCalculations.test.ts

**Test Suite**: `groupCalculations`

#### Test Cases:

1. **`calculates the total for a specific group`**
   - Sums all expenses for a specific group

2. **`calculates user contribution within a group`**
   - Calculates total amount paid by user in group

3. **`calculates balances for each member`**
   - Calculates what each member paid and owes

4. **`returns empty balances when no members provided`**
   - Handles empty member list gracefully

## Hooks

### useExpenseForm.test.tsx

**Test Suite**: `useExpenseForm`

#### Test Cases:

1. **`creates a personal expense using the internal user identifier`**
   - Creates personal expense with internal user ID

2. **`validates group expenses require payer and participants`**
   - Validates group expense requirements before creation

3. **`updates an existing expense when editing`**
   - Updates existing expense with new data

### useCategoryManager.test.tsx

**Test Suite**: `useCategoryManager`

#### Test Cases:

1. **`opens and closes modals for create vs edit flows`**
   - Manages modal state for category creation and editing

2. **`adds new categories when name unique`**
   - Creates new categories with unique names

3. **`rejects duplicate category names`**
   - Prevents creation of duplicate category names

4. **`updates existing categories and prevents deleting 'Other'`**
   - Updates categories and protects system categories

### useInsightsData.test.tsx

**Test Suite**: `useInsightsData`

#### Test Cases:

1. **`computes chart data for personal context and navigates periods`**
   - Generates chart data for personal expenses and handles period navigation

2. **`filters expenses for group context and respects available participants`**
   - Generates chart data for group expenses with participant filtering

### useExpenseModals.test.tsx

**Test Suite**: `useExpenseModals`

#### Test Cases:

1. **`sets and clears group selections and dependent fields`**
   - Manages group selection and clears dependent form fields

2. **`toggles participants in split selections`**
   - Manages participant selection for expense splitting

3. **`navigates to category management when add-new action selected`**
   - Handles navigation to category management screen

## Store

### composedExpenseStore.test.ts

**Test Suite**: `ComposedExpenseStore`

#### Test Cases:

1-9. **Cross-Store Operations**

- User-participant synchronization
- Group creation with user seeding
- Category management across store layers
- Group and participant removal with cleanup
- Expense CRUD operations
- User settings and creation flows

### categoryStore.test.ts

**Test Suite**: `CategoryStore`

#### Test Cases:

1-5. **Category Management**

- Category creation with uniqueness validation
- Duplicate handling with warnings
- Color updates for existing categories
- Protected category deletion prevention
- Category retrieval and lookup

### participantStore.test.ts

**Test Suite**: `ParticipantStore`

#### Test Cases:

1-6. **Participant Management**

- Participant creation with ID generation
- Participant updates with ID override
- Duplicate name prevention
- User-participant synchronization
- Participant deletion
- Participant retrieval and sync logic

### groupStore.test.ts

**Test Suite**: `GroupStore`

#### Test Cases:

1-6. **Group Management**

- Group creation with participant seeding
- Group property updates
- Group deletion
- Group retrieval
- Participant addition with duplicate prevention
- Participant management utilities

### userStore.test.ts

**Test Suite**: `UserStore`

#### Test Cases:

1-6. **User Management**

- User update with ID preservation
- User creation with ID generation
- Settings merge without dropping defaults
- Legacy settings migration
- ID retrieval preference logic
- Fallback ID generation

### expenseStore.test.ts

**Test Suite**: `ExpenseStore`

#### Test Cases:

1-18. **Expense Management**

- Expense creation with auto-generated IDs
- Date-based sorting (newest first)
- Same-date handling
- Group expense processing
- Expense updates with sort maintenance
- Expense deletion with isolation
- Expense retrieval and lookup
- Orphaned expense migration
- Group removal cleanup
- Participant removal cleanup

## Performance

### store-performance.test.ts

**Test Suite**: `Store Performance Benchmarks`

#### Test Cases:

1. **`should handle 1000 expense inserts within expected bounds`**
   - Tests bulk expense insertion performance
   - **Threshold**: < 800ms (or < 1500ms with coverage)

2. **`should complete aggregate calculations within expected bounds`**
   - Tests aggregate calculation performance on large datasets
   - **Threshold**: 25 aggregations on 750 expenses < 300ms (or < 700ms with coverage)

3. **`should maintain heap growth below 12MB when processing 1500 expenses`**
   - Tests memory usage during large-scale operations
   - **Threshold**: Heap growth < 12MB for 1500 expenses

## Summary Statistics

### Test Coverage by Domain:

- **Components**: 8 test files, 97 test cases
- **Utils**: 4 test files, 47 test cases
- **Hooks**: 4 test files, 10 test cases
- **Store**: 6 test files, 42 test cases
- **Performance**: 1 test file, 3 test cases

**Total Unit Tests**: 23 files, 268 test cases

### Key Characteristics:

- **Isolation**: All tests run with mocked dependencies
- **Fast Execution**: Unit tests complete in < 3 seconds
- **Deterministic**: No external dependencies or network calls
- **Type Safe**: TypeScript ensures type correctness
- **Edge Case Coverage**: Comprehensive boundary condition testing
- **Performance Monitoring**: Dedicated benchmarks for scalability

### Testing Technologies:

- **Jest**: Test framework with mocking capabilities
- **React Native Testing Library**: Component interaction testing
- **Zustand**: State management testing
- **TypeScript**: Type-safe test definitions
