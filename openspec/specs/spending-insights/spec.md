# Spending Insights Specification

## Purpose

Define the current personal and group spending breakdowns presented by the
mobile insights screen.

## Requirements

### Requirement: Insights Context

The insights screen SHALL accept either a `personal` context with a user
identifier or a `group` context with a group identifier. Personal insights
SHALL use expenses whose `paidBy` value equals the internal user identifier.
Group insights SHALL use expenses whose `groupId` equals the requested group
identifier.

#### Scenario: Personal insights are requested

- GIVEN the insights route identifies a personal context
- AND an internal user identifier is available
- WHEN the screen derives relevant expenses
- THEN it includes expenses paid by that internal user
- AND the screen title is `Personal Expense Insights`

#### Scenario: Group insights are requested

- GIVEN the insights route identifies a group context and group identifier
- WHEN the screen derives relevant expenses
- THEN it includes expenses assigned to that exact group identifier
- AND the title uses the known group name followed by `Insights`

#### Scenario: Requested group is unknown

- GIVEN the insights route identifies a group that is not present in the store
- WHEN the screen title is derived
- THEN the title is `Group Insights`

### Requirement: Monthly and Yearly Aggregation

The insights screen SHALL support month and year aggregation. It SHALL default
to month aggregation and the current month unless an initial date is supplied.
Month aggregation SHALL include only expenses in the selected month and year;
year aggregation SHALL include all relevant expenses in the selected year.

#### Scenario: User views a monthly period

- GIVEN month aggregation is selected
- WHEN chart data is derived for a selected month and year
- THEN only relevant expenses in that calendar month and year contribute
- AND the displayed period contains the month name and year

#### Scenario: User views a yearly period

- GIVEN year aggregation is selected
- WHEN chart data is derived for a selected year
- THEN all relevant expenses in that calendar year contribute
- AND the displayed period is that year

### Requirement: Category Breakdown

For the selected context and period, the insights screen SHALL sum full expense
amounts by category and calculate each category's percentage of the period
total. It SHALL use the configured category color when available and gray when
the category is unknown.

#### Scenario: Multiple expenses share a category

- GIVEN multiple relevant period expenses have the same category
- WHEN chart data is generated
- THEN their amounts are summed into one category value
- AND its percentage equals that value divided by the sum of all included
  expense amounts

#### Scenario: Category metadata is unavailable

- GIVEN a relevant expense references a category absent from configured
  categories
- WHEN chart data is generated
- THEN that category remains in the breakdown
- AND its chart color is gray

### Requirement: Insights Visualization

The insights screen SHALL render a donut chart for non-empty category data and
a legend containing each category name, absolute amount prefixed with `$` and
rounded to two decimal places, and percentage rounded to one decimal place. If
the selected period has no non-zero expense data, the screen SHALL display a
no-data message instead of a chart.

#### Scenario: Selected period contains expense data

- GIVEN category breakdown data is non-empty
- WHEN the insights visualization renders
- THEN a donut chart is displayed
- AND the legend reports each category's amount and percentage

#### Scenario: Selected period contains no expense data

- GIVEN category breakdown data is empty
- WHEN the insights visualization renders
- THEN the screen displays `No expense data for the selected period.`

### Requirement: Period Navigation

The insights screen SHALL provide explicit previous-period and next-period
controls. Monthly navigation SHALL cross year boundaries one month at a time,
and yearly navigation SHALL move one year at a time. Forward navigation SHALL
not advance beyond the current month or current year for the selected
aggregation.

#### Scenario: User moves back from January

- GIVEN January of a selected year is shown in month aggregation
- WHEN the user activates the previous-period control
- THEN December of the preceding year is selected

#### Scenario: Current period is shown

- GIVEN the selected period is the current month or current year
- WHEN the period controls render
- THEN the next-period control is disabled

### Requirement: Explicit Period Picker

Activating the displayed period SHALL open a period picker. The picker SHALL
offer years from five years before through five years after the current year,
and SHALL also offer a month when month aggregation is selected. Applying a
picker selection SHALL update the period used for filtering.

#### Scenario: User chooses a monthly period

- GIVEN month aggregation is selected
- WHEN the user opens the period picker and chooses a month and year
- THEN the selected month and year become the active filtering period

#### Scenario: User chooses a yearly period

- GIVEN year aggregation is selected
- WHEN the user opens the period picker and chooses a year
- THEN that year becomes the active filtering period
