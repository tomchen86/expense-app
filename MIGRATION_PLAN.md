# **COMPREHENSIVE MIGRATION PLAN: Legacy → Expo Router**

## **🔍 LEGACY vs CURRENT ANALYSIS**

### **Legacy Architecture (Traditional React Navigation)**

```
mobile/ (legacy)
├── index.js                    # Entry: registerRootComponent(App)
├── App.tsx                     # Manual navigation setup
├── babel.config.js             # Custom Babel with plugins
├── package.json                # main: "index.js"
└── src/screens/               # Manual screen imports
    ├── HomeScreen.tsx
    ├── AddExpenseScreen.tsx
    └── GroupDetailScreen.tsx
```

### **Current Architecture (Expo Router)**

```
my-app/ (current)
├── app/                        # File-based routing (ROOT LEVEL!)
│   ├── index.tsx              # HomeScreen → /
│   ├── add-expense.tsx        # AddExpenseScreen → /add-expense
│   └── group-detail.tsx       # GroupDetailScreen → /group-detail
├── src/                       # Organized source code
└── package.json               # main: "expo-router/entry"
```

## **🚨 BREAKING CHANGES IDENTIFIED**

### **1. Entry Point Revolution**

- **Legacy**: `index.js` → `App.tsx` → `<NavigationContainer>`
- **Current**: `expo-router/entry` → File-based routing
- **Impact**: Complete architectural shift

### **2. Navigation Pattern Change**

- **Legacy**: Programmatic routes with manual type definitions
  ```tsx
  <Stack.Screen name="AddExpense" component={AddExpenseScreen} />
  export type RootStackParamList = { AddExpense: {...} }
  ```
- **Current**: Declarative file-based routes with auto-generated types
  ```
  app/add-expense.tsx → /add-expense (auto-typed)
  ```

### **3. Dependency Management**

- **Legacy**: `@react-navigation/stack` + `@react-navigation/bottom-tabs`
- **Current**: `expo-router` (includes navigation internally)

### **4. Build Configuration**

- **Legacy**: Custom `babel.config.js` with explicit plugins
- **Current**: Built-in Metro bundler transpilation

## **📋 MIGRATION EXECUTION PLAN**

### **Phase 1: Preparation & Backup**

1. **Archive Legacy**: Preserve current legacy/ folder
2. **Dependency Audit**: Compare package.json dependencies
3. **Screen Inventory**: Catalog all screens and their navigation patterns
4. **Type Definition Mapping**: Document current navigation types

### **Phase 2: Core Infrastructure Migration**

1. **Update Entry Point**: Change `main` from `index.js` to `expo-router/entry`
2. **Install Expo Router**: Add `expo-router` plugin to app.json
3. **Remove Legacy Navigation**: Uninstall React Navigation packages
4. **Update TypeScript Config**: Configure path mapping for `@/*` → `./src/*`

### **Phase 3: Screen Migration Strategy**

1. **Create app/ Directory Structure**:

   ```
   app/
   ├── _layout.tsx              # Root layout (from App.tsx logic)
   ├── (tabs)/                  # Tab navigation group
   │   ├── _layout.tsx         # Tab layout
   │   ├── index.tsx           # Home tab
   │   └── history.tsx         # History tab
   ├── add-expense.tsx         # Modal/stack screen
   ├── group-detail.tsx        # Dynamic route
   └── settings.tsx            # Settings screen
   ```

2. **Screen-by-Screen Migration**:
   - Extract screen components from legacy/App.tsx navigation setup
   - Convert to file-based routes in app/ directory
   - Update import paths from relative to src/ structure
   - Remove navigation type dependencies

### **Phase 4: Navigation Logic Transformation**

1. **Replace Navigation Calls**:
   - Legacy: `navigation.navigate('AddExpense', { expense })`
   - Current: `router.push('/add-expense?expense=' + JSON.stringify(expense))`

2. **Route Parameters**:
   - Legacy: `route.params.groupId`
   - Current: `useLocalSearchParams()` or dynamic routes `[id].tsx`

3. **Tab Configuration**:
   - Legacy: Manual `<Tab.Navigator>` setup
   - Current: `(tabs)/_layout.tsx` with Expo Router tabs

### **Phase 5: Testing & Validation**

1. **Functionality Verification**: Test all navigation flows
2. **Performance Comparison**: Measure bundle size and load times
3. **Type Safety Check**: Verify auto-generated route types
4. **Development Experience**: Test hot reload and debugging

### **Phase 6: Cleanup & Optimization**

1. **Remove Legacy Files**: Delete old navigation setup
2. **Update Scripts**: Modify package.json scripts if needed
3. **Documentation Update**: Update README and development guides
4. **Performance Optimization**: Leverage Expo Router features (prefetching, etc.)

## **⚠️ MIGRATION RISKS & CONSIDERATIONS**

### **High Risk Areas**

1. **Deep Link Handling**: URL structure changes may break existing deep links
2. **Navigation State**: State persistence patterns need updating
3. **Custom Navigation**: Any custom navigation logic requires rethinking
4. **Testing**: Navigation testing patterns need complete overhaul

### **Compatibility Concerns**

1. **React Navigation Dependencies**: Some components may still depend on legacy patterns
2. **Third-party Libraries**: Navigation-aware libraries may need updates
3. **Platform Differences**: Web routing behavior differences

## **🎯 SUCCESS CRITERIA**

- [ ] All screens accessible via file-based routing
- [ ] Tab navigation working with (tabs) group
- [ ] Dynamic routes functional for GroupDetail
- [ ] Type safety maintained with auto-generated types
- [ ] Deep linking preserved with new URL structure
- [ ] Performance improved or maintained
- [ ] Development experience enhanced

## **📝 ROLLBACK STRATEGY**

1. **Legacy Preservation**: Keep legacy/ folder intact during migration
2. **Incremental Migration**: Migrate screen-by-screen with fallbacks
3. **Feature Flags**: Use conditional rendering during transition
4. **Quick Rollback**: Maintain ability to switch back to legacy/App.tsx

## **🔄 DETAILED MIGRATION MAPPING**

### **Screen Mapping: Legacy → Current**

| Legacy Screen            | Legacy Route             | Current File                | Current Route        |
| ------------------------ | ------------------------ | --------------------------- | -------------------- |
| `HomeScreen`             | `Main.Home`              | `app/(tabs)/index.tsx`      | `/`                  |
| `HistoryScreen`          | `Main.History`           | `app/(tabs)/history.tsx`    | `/history`           |
| `SettingsScreen`         | `Main.Settings`          | `app/(tabs)/settings.tsx`   | `/settings`          |
| `AddExpenseScreen`       | `AddExpense`             | `app/add-expense.tsx`       | `/add-expense`       |
| `GroupDetailScreen`      | `GroupDetail`            | `app/group-detail.tsx`      | `/group-detail`      |
| `ExpenseInsightsScreen`  | `ExpenseInsights`        | `app/insights.tsx`          | `/insights`          |
| `ManageCategoriesScreen` | `ManageCategoriesScreen` | `app/manage-categories.tsx` | `/manage-categories` |

### **Navigation Code Transformation Examples**

#### **Legacy Navigation**

```tsx
// Legacy App.tsx
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

const Stack = createStackNavigator<RootStackParamList>();

function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name='Main' component={MainTabs} />
        <Stack.Screen name='AddExpense' component={AddExpenseScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// Navigation usage
navigation.navigate('AddExpense', { expense: someExpense });
```

#### **Current Navigation**

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name='(tabs)' options={{ headerShown: false }} />
      <Stack.Screen name='add-expense' options={{ title: 'Add Expense' }} />
    </Stack>
  );
}

// Navigation usage
import { router } from 'expo-router';
router.push('/add-expense');
```

### **Type System Changes**

#### **Legacy Types**

```tsx
export type RootStackParamList = {
  Main: undefined;
  AddExpense: { expense?: Expense } | undefined;
  GroupDetail: { groupId: string };
};

type AddExpenseScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'AddExpense'
>;
```

#### **Current Types**

```tsx
// Auto-generated by Expo Router
// No manual type definitions needed!
// Types are inferred from file structure and search params
```

## **🛠️ TECHNICAL IMPLEMENTATION NOTES**

### **Expo Router Configuration**

The current app.json already includes the necessary Expo Router configuration:

```json
{
  "expo": {
    "plugins": ["expo-router"],
    "experiments": {
      "typedRoutes": true
    }
  }
}
```

### **Package.json Entry Point**

Current configuration uses Expo Router entry:

```json
{
  "main": "expo-router/entry"
}
```

### **TypeScript Path Mapping**

Current tsconfig.json is configured for src/ structure:

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

## **📊 DEPENDENCY COMPARISON**

### **Legacy Dependencies (Removed)**

```json
{
  "@react-navigation/bottom-tabs": "^7.4.7",
  "@react-navigation/native": "^7.1.17",
  "@react-navigation/stack": "^7.4.8",
  "react-native-gesture-handler": "~2.28.0",
  "react-native-screens": "~4.16.0",
  "react-native-safe-area-context": "5.6.1"
}
```

### **Current Dependencies (Added)**

```json
{
  "expo-router": "~6.0.8",
  "@expo/vector-icons": "^15.0.2"
}
```

## **🎉 MIGRATION BENEFITS ACHIEVED**

1. **Simplified Development**: No manual route configuration
2. **Better Type Safety**: Auto-generated typed routes
3. **Improved Performance**: Built-in code splitting and lazy loading
4. **Enhanced DX**: Hot reload improvements, better error messages
5. **Web Support**: Automatic web routing with same codebase
6. **Reduced Bundle Size**: Eliminated React Navigation dependencies
7. **Future-Proof**: Aligned with Expo's recommended architecture

## **📦 PACKAGE MANAGER OPTIMIZATION CONSIDERATION**

### **pnpm Migration Opportunity**

As part of this modernization effort, consider migrating from npm to pnpm for:

- **50-60% storage reduction** (386MB → ~180MB node_modules)
- **66% faster installs** (~45s → ~15s)
- **Better dependency management** and full Expo compatibility

**Migration steps:**

```bash
rm -rf node_modules package-lock.json
npm install -g pnpm
pnpm install
```

**Note:** This is optional and can be done independently of the Expo Router migration.

---

This migration represents a **fundamental architectural shift** from imperative to declarative navigation, offering improved developer experience, better performance, and enhanced type safety. The addition of pnpm provides significant performance and storage benefits while maintaining full compatibility with the Expo ecosystem.
