# Spending Insights Specification

## Purpose

Define personal and shared-space insights from canonical payment and share
allocations. Insights SHALL use the same projection rules as the expense feed
and balances.

## Requirements

### Requirement: Insights Context

The insights screen SHALL accept either a `personal` context for the current
user or a `shared` context with an explicit shared-space identifier. Personal
insights SHALL be derived from the user's share allocations, not from expenses
the user happened to pay. Shared insights SHALL be derived from expenses in
the authorized shared space.

#### Scenario: Personal insights are requested

- GIVEN the current user has personal and shared-space allocations
- WHEN personal insights are derived
- THEN each expense contributes the current user's canonical share
- AND expenses paid by the user for other people do not inflate personal
  spending
- AND expenses paid by other people still contribute the user's share

#### Scenario: Shared insights are requested

- GIVEN the user is authorized for a shared space
- WHEN shared insights are derived
- THEN only expenses belonging to that exact space are included

### Requirement: Paid, Spent, and Balance Totals

Insights SHALL distinguish `paid`, `spent`, and `balance`. `paid` SHALL sum the
user's payments, `spent` SHALL sum the user's shares, and `balance` SHALL equal
`paid - spent`.

#### Scenario: User fronts an expense

- GIVEN the user pays `10000` minor units and consumes `2000`
- WHEN personal insights are calculated
- THEN paid is `10000`
- AND spent is `2000`
- AND balance is `8000`

### Requirement: Monthly and Yearly Aggregation

Insights SHALL support month and year aggregation using each expense's calendar
date. Month aggregation SHALL include only the selected calendar month and
year; year aggregation SHALL include the selected calendar year.

#### Scenario: User views a monthly period

- GIVEN month aggregation is selected
- WHEN chart data is derived for a selected month and year
- THEN only canonical dates in that month and year contribute

### Requirement: Category Breakdown

Personal category breakdowns SHALL sum the current user's share for each
expense. Shared-space category breakdowns SHALL sum full expense amounts.
Category identity SHALL use stable category identifiers. Percentages SHALL be
derived from the same amounts shown in the chart.

#### Scenario: Shared expense has a partial user share

- GIVEN a shared expense is `10000` minor units and the user's share is `2000`
- WHEN personal category data is generated
- THEN that expense contributes `2000`
- WHEN shared-space category data is generated
- THEN it contributes `10000`

### Requirement: Currency-Safe Aggregation

Insights SHALL NOT add unlike currencies into one unlabeled total. A space MAY
enforce one currency, or insights SHALL group totals by currency. Currency
conversion SHALL require an explicit base currency, rate, rate date, and
decimal-safe calculation.

#### Scenario: Period contains AUD and JPY

- GIVEN no explicit conversion contract applies
- WHEN insights are calculated
- THEN AUD and JPY totals are returned separately
- AND they are not reported as one summed minor-unit value

### Requirement: Insights Visualization

The client SHALL format each amount with its currency and locale. It SHALL
render category data for non-empty periods and a no-data state for periods
without non-zero canonical shares or expenses.

#### Scenario: Selected period has no data

- GIVEN the selected projection contains no non-zero values
- WHEN insights render
- THEN the screen displays `No expense data for the selected period.`

### Requirement: Period Navigation

The client SHALL provide previous and next period controls and an explicit
period picker. Forward navigation SHALL not advance beyond the current month
or year for the selected aggregation.

#### Scenario: User moves back from January

- GIVEN January is shown in month aggregation
- WHEN the user selects the previous period
- THEN December of the preceding year is selected
