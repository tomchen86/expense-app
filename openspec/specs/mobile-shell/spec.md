# Mobile Shell Specification

## Purpose

Define the current Expo Router navigation shell and the routes that connect the
implemented mobile capabilities.

## Requirements

### Requirement: Primary Tab Navigation

The mobile application SHALL expose exactly three primary tab destinations, in
this order: `Group`, `Expense`, and `Settings`. Each primary destination SHALL
render with its tab header visible.

#### Scenario: User moves between primary capabilities

- GIVEN the mobile application is open on a primary tab
- WHEN the user selects another primary tab
- THEN the application displays the corresponding Group, Expense, or Settings
  screen
- AND the selected screen retains its visible header

### Requirement: Stack Destinations

The mobile application SHALL register add/edit expense, group detail, expense
insights, and category management as stack destinations outside the primary
tab navigator. Their default titles SHALL be `Add/Edit Expense`,
`Group Details`, `Expense Insights`, and `Manage Categories`, respectively,
while a destination MAY replace its title with available context such as a
group name.

#### Scenario: User opens a secondary workflow

- GIVEN the user is on a primary screen
- WHEN an implemented capability navigates to a secondary workflow
- THEN the destination is pushed on the root stack
- AND returning from that destination restores the prior navigation context

### Requirement: Expense Capture Entry Points

The Group tab, Expense tab, and group-detail screen SHALL expose a floating add
expense control. Activating the control SHALL push the add/edit expense stack
destination; when activated from a group-detail screen, the navigation request
SHALL also carry that group's identifier.

#### Scenario: User starts expense capture from a primary tab

- GIVEN the user is viewing the Group or Expense tab
- WHEN the user activates the floating add expense control
- THEN the application pushes `/add-expense`

#### Scenario: User starts expense capture from group detail

- GIVEN the user is viewing a group-detail screen for a known group
- WHEN the user activates the floating add expense control
- THEN the application pushes `/add-expense`
- AND the route parameters include the current group identifier

### Requirement: Insights Navigation Context

The Expense screen SHALL open personal insights from the current user's total
share only when an internal user identifier is available. A group-detail screen
SHALL open group insights from its group total. Each navigation request SHALL
identify whether the insights context is `personal` or `group` and SHALL carry
the corresponding identifier.

#### Scenario: User opens personal insights

- GIVEN an internal user identifier is available
- WHEN the user activates `Your Total Share`
- THEN the application pushes `/insights`
- AND the route identifies a personal context with the internal user identifier

#### Scenario: Personal insights are unavailable without identity

- GIVEN no internal user identifier is available
- WHEN the Expense screen renders the total-share control
- THEN the control is disabled
- AND no insights navigation is initiated from that control

#### Scenario: User opens group insights

- GIVEN the user is viewing details for a known group
- WHEN the user activates `Group Total`
- THEN the application pushes `/insights`
- AND the route identifies a group context with that group identifier

### Requirement: Capability Navigation Links

The Group screen SHALL open the selected group's detail destination, and the
Settings screen SHALL expose a control that opens category management.

#### Scenario: User opens group details

- GIVEN a group is listed on the Group screen
- WHEN the user activates that group card
- THEN the application pushes `/group-detail`
- AND the route parameters include the selected group identifier

#### Scenario: User opens category management

- GIVEN the user is viewing Settings
- WHEN the user activates `Manage Categories`
- THEN the application pushes `/manage-categories`
