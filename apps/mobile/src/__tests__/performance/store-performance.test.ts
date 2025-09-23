import { useExpenseStore as useExpenseFeatureStore } from '../../store/features/expenseStore';

// Use high-resolution timing when available, otherwise fall back to Date.now
const now = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { performance } = require('perf_hooks');
    return performance.now();
  } catch (error) {
    return Date.now();
  }
};

const createExpense = (index: number) => ({
  title: `Performance Test Expense ${index}`,
  amount: (index % 50) + 1,
  date: new Date(2025, index % 12, (index % 28) + 1).toISOString(),
  category: `category-${index % 6}`,
  caption: index % 10 === 0 ? 'Recurring expense' : undefined,
  groupId: index % 5 === 0 ? `group-${index % 3}` : undefined,
  paidBy: index % 3 === 0 ? `participant-${index % 4}` : undefined,
  splitBetween: index % 2 === 0 ? [`participant-${index % 4}`] : undefined,
});

const isCoverageRun = Boolean(
  (globalThis as { __coverage__?: unknown }).__coverage__ ||
    process.env.NODE_V8_COVERAGE,
);

const INSERT_THRESHOLD_MS = isCoverageRun ? 1500 : 800;
const AGGREGATE_THRESHOLD_MS = isCoverageRun ? 700 : 300;

const resetStore = () => {
  const store = useExpenseFeatureStore.getState();
  if (store.expenses.length) {
    useExpenseFeatureStore.setState({ expenses: [] });
  }
};

describe('Store Performance Benchmarks', () => {
  beforeEach(() => {
    resetStore();
  });

  it('should handle 1000 expense inserts within expected bounds', () => {
    const addExpense = useExpenseFeatureStore.getState().addExpense;

    const start = now();
    for (let index = 0; index < 1000; index += 1) {
      addExpense(createExpense(index));
    }
    const duration = now() - start;

    expect(useExpenseFeatureStore.getState().expenses).toHaveLength(1000);
    expect(duration).toBeLessThan(INSERT_THRESHOLD_MS);
  });

  it('should complete aggregate calculations within expected bounds', () => {
    const store = useExpenseFeatureStore.getState();
    const addExpense = store.addExpense;

    for (let index = 0; index < 750; index += 1) {
      addExpense(createExpense(index));
    }

    const aggregateTotals = () => {
      const { expenses } = useExpenseFeatureStore.getState();
      const totals = expenses.reduce(
        (accumulated, expense) => {
          const key = expense.category;
          // eslint-disable-next-line no-param-reassign
          accumulated[key] = (accumulated[key] ?? 0) + expense.amount;
          return accumulated;
        },
        {} as Record<string, number>,
      );

      return Object.values(totals).reduce((sum, amount) => sum + amount, 0);
    };

    const start = now();
    for (let iteration = 0; iteration < 25; iteration += 1) {
      aggregateTotals();
    }
    const duration = now() - start;

    expect(duration).toBeLessThan(AGGREGATE_THRESHOLD_MS);
  });

  it('should maintain heap growth below 12MB when processing 1500 expenses', () => {
    const addExpense = useExpenseFeatureStore.getState().addExpense;

    const baselineMemory = process.memoryUsage().heapUsed;

    for (let index = 0; index < 1500; index += 1) {
      addExpense(createExpense(index));
    }

    const peakMemory = process.memoryUsage().heapUsed;
    const heapDeltaInMb = (peakMemory - baselineMemory) / (1024 * 1024);

    expect(useExpenseFeatureStore.getState().expenses).toHaveLength(1500);
    expect(heapDeltaInMb).toBeLessThan(12);
  });
});
