// Performance testing utilities for API response times
// Ensures API meets <500ms target for simple operations, <2s for complex queries

export interface PerformanceMetrics {
  startTime: number;
  endTime: number;
  duration: number;
  operation: string;
}

export class PerformanceAssertions {
  /**
   * Measures execution time of an async operation
   */
  static async measureAsync<T>(
    operation: string,
    asyncFn: () => Promise<T>,
  ): Promise<{ result: T; metrics: PerformanceMetrics }> {
    const startTime = performance.now();

    try {
      const result = await asyncFn();
      const endTime = performance.now();

      const metrics: PerformanceMetrics = {
        startTime,
        endTime,
        duration: endTime - startTime,
        operation,
      };

      return { result, metrics };
    } catch (error) {
      const endTime = performance.now();
      const metrics: PerformanceMetrics = {
        startTime,
        endTime,
        duration: endTime - startTime,
        operation,
      };

      console.error(
        `Performance test failed for ${operation} after ${metrics.duration}ms:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Asserts that operation completes within target time
   */
  static assertResponseTime(metrics: PerformanceMetrics, maxMs: number): void {
    expect(metrics.duration).toBeLessThan(maxMs);
  }

  /**
   * Asserts simple CRUD operations are under 500ms
   */
  static assertSimpleOperation(metrics: PerformanceMetrics): void {
    expect(metrics.duration).toBeLessThan(500);
  }

  /**
   * Asserts complex queries are under 2 seconds
   */
  static assertComplexQuery(metrics: PerformanceMetrics): void {
    expect(metrics.duration).toBeLessThan(2000);
  }

  /**
   * Asserts authentication is under 100ms
   */
  static assertAuthenticationSpeed(metrics: PerformanceMetrics): void {
    expect(metrics.duration).toBeLessThan(100);
  }

  /**
   * Helper for testing API endpoint performance
   */
  static async testEndpointPerformance<T>(
    endpoint: string,
    apiCall: () => Promise<T>,
    maxResponseTime: number = 500,
  ): Promise<{ response: T; metrics: PerformanceMetrics }> {
    const { result: response, metrics } = await this.measureAsync(
      `API ${endpoint}`,
      apiCall,
    );

    this.assertResponseTime(metrics, maxResponseTime);

    return { response, metrics };
  }

  /**
   * Batch performance testing for multiple operations
   */
  static async batchPerformanceTest(
    operations: Array<{
      name: string;
      fn: () => Promise<unknown>;
      maxMs: number;
    }>,
  ): Promise<PerformanceMetrics[]> {
    const results: PerformanceMetrics[] = [];

    for (const operation of operations) {
      const { metrics } = await this.measureAsync(operation.name, operation.fn);
      this.assertResponseTime(metrics, operation.maxMs);
      results.push(metrics);
    }

    return results;
  }

  /**
   * Log performance metrics for debugging
   */
  static logMetrics(metrics: PerformanceMetrics): void {
    console.log(`📊 ${metrics.operation}: ${metrics.duration.toFixed(2)}ms`);
  }

  /**
   * Log batch metrics summary
   */
  static logBatchSummary(metricsArray: PerformanceMetrics[]): void {
    const total = metricsArray.reduce((sum, m) => sum + m.duration, 0);
    const average = total / metricsArray.length;
    const slowest = Math.max(...metricsArray.map((m) => m.duration));
    const fastest = Math.min(...metricsArray.map((m) => m.duration));

    console.log('\n📊 Performance Test Summary:');
    console.log(`   Total operations: ${metricsArray.length}`);
    console.log(`   Total time: ${total.toFixed(2)}ms`);
    console.log(`   Average: ${average.toFixed(2)}ms`);
    console.log(`   Fastest: ${fastest.toFixed(2)}ms`);
    console.log(`   Slowest: ${slowest.toFixed(2)}ms`);

    metricsArray.forEach((m) => {
      console.log(`   - ${m.operation}: ${m.duration.toFixed(2)}ms`);
    });
  }
}

/**
 * Jest custom matcher for performance assertions
 */
/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeUnderMs(maxMs: number): R;
      toBeFastOperation(): R;
      toBeSlowOperation(): R;
      toBeFastAuth(): R;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

// Custom Jest matchers
expect.extend({
  toBeUnderMs(received: PerformanceMetrics, maxMs: number) {
    const pass = received.duration < maxMs;
    return {
      message: () =>
        pass
          ? `Expected ${received.operation} (${received.duration.toFixed(2)}ms) not to be under ${maxMs}ms`
          : `Expected ${received.operation} (${received.duration.toFixed(2)}ms) to be under ${maxMs}ms`,
      pass,
    };
  },

  toBeFastOperation(received: PerformanceMetrics) {
    const pass = received.duration < 500;
    return {
      message: () =>
        pass
          ? `Expected ${received.operation} (${received.duration.toFixed(2)}ms) not to be a fast operation (<500ms)`
          : `Expected ${received.operation} (${received.duration.toFixed(2)}ms) to be a fast operation (<500ms)`,
      pass,
    };
  },

  toBeSlowOperation(received: PerformanceMetrics) {
    const pass = received.duration < 2000;
    return {
      message: () =>
        pass
          ? `Expected ${received.operation} (${received.duration.toFixed(2)}ms) not to be acceptable for slow operations (<2s)`
          : `Expected ${received.operation} (${received.duration.toFixed(2)}ms) to be acceptable for slow operations (<2s)`,
      pass,
    };
  },

  toBeFastAuth(received: PerformanceMetrics) {
    const pass = received.duration < 100;
    return {
      message: () =>
        pass
          ? `Expected ${received.operation} (${received.duration.toFixed(2)}ms) not to be fast auth (<100ms)`
          : `Expected ${received.operation} (${received.duration.toFixed(2)}ms) to be fast auth (<100ms)`,
      pass,
    };
  },
});
