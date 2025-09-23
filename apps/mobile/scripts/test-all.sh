#!/bin/bash

# Mobile App - Comprehensive Test Runner
# This script runs all test suites for the mobile application

set -e  # Exit on any error

echo "🧪 Starting comprehensive test suite for Mobile App..."
echo "=============================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}📋 $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Function to run command with status reporting
run_test() {
    local test_name="$1"
    local command="$2"

    print_status "Running $test_name..."

    if eval "$command"; then
        print_success "$test_name passed"
        return 0
    else
        print_error "$test_name failed"
        return 1
    fi
}

# Ensure we're in the mobile app directory
cd "$(dirname "$0")/.."

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    print_status "Installing dependencies with pnpm..."
    pnpm install --filter mobile --frozen-lockfile
fi

# Initialize test results
FAILED_TESTS=()
TOTAL_TESTS=0
PASSED_TESTS=0

# TypeScript Type Checking
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if run_test "TypeScript Type Checking" "pnpm run typecheck"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    FAILED_TESTS+=("TypeScript Type Checking")
fi

echo ""

# ESLint
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if run_test "ESLint Code Quality" "pnpm run lint"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    FAILED_TESTS+=("ESLint")
fi

echo ""

# Unit Tests
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if run_test "Unit Tests" "pnpm run test -- --watchAll=false --coverage"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    FAILED_TESTS+=("Unit Tests")
fi

echo ""

# Coverage Threshold Check
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if run_test "Coverage Threshold Check" "pnpm run test:coverage-check"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    FAILED_TESTS+=("Coverage Threshold")
fi

echo ""

# E2E Tests (only if specifically requested or in CI)
if [[ "$1" == "--e2e" ]] || [[ "$CI" == "true" ]]; then
    print_status "E2E tests requested - this will take several minutes..."

    # Check if iOS simulator is available
    if command -v xcrun >/dev/null 2>&1 && xcrun simctl list | grep -q "iPhone"; then
        TOTAL_TESTS=$((TOTAL_TESTS + 1))
        if run_test "E2E Tests (iOS)" "pnpm run test:e2e:build && pnpm run test:e2e"; then
            PASSED_TESTS=$((PASSED_TESTS + 1))
        else
            FAILED_TESTS+=("E2E Tests (iOS)")
        fi
    else
        print_warning "iOS Simulator not available, skipping iOS E2E tests"
    fi
else
    print_status "Skipping E2E tests (use --e2e flag to include them)"
fi

echo ""
echo "=============================================="
echo "🏁 Test Summary"
echo "=============================================="

# Print results
if [ ${#FAILED_TESTS[@]} -eq 0 ]; then
    print_success "All tests passed! ($PASSED_TESTS/$TOTAL_TESTS)"
    echo ""
    echo "🎉 Your code is ready for commit!"
    exit 0
else
    print_error "Some tests failed ($PASSED_TESTS/$TOTAL_TESTS passed)"
    echo ""
    echo "Failed tests:"
    for test in "${FAILED_TESTS[@]}"; do
        echo "  - $test"
    done
    echo ""
    echo "💡 Please fix the failing tests before committing."
    exit 1
fi
