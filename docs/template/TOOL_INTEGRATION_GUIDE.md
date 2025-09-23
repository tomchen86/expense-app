# Tool Integration Guide

*Last Updated: September 19, 2025*

## Overview
Integration between documentation system and development tools to reduce manual overhead while maintaining visibility.

## GitHub Integration

### Issues as Task Tracking
Replace manual `TASK_X.X_COMPLETION_LOG.md` with GitHub Issues:

```markdown
# GitHub Issue Template: Task Implementation
**Task**: 2.1 Database Design
**Parent Phase**: Phase 2 - API Development
**Estimated Duration**: 2-3 days
**Dependencies**: None

## Acceptance Criteria
- [ ] PostgreSQL schema created for users, couples, expenses
- [ ] TypeORM entities implemented with proper relationships
- [ ] Database migrations working
- [ ] Seed data scripts functional
- [ ] Unit tests for entity relationships

## Subtasks
- [ ] Design user authentication schema
- [ ] Design expense tracking schema
- [ ] Implement foreign key constraints
- [ ] Create performance indexes
- [ ] Add data validation constraints

## Files to Create
- `apps/api/src/entities/User.entity.ts`
- `apps/api/src/entities/Couple.entity.ts`
- `apps/api/src/entities/Expense.entity.ts`
- `apps/api/src/database/migrations/001_initial_schema.sql`
```

### Project Board Setup
```yaml
# .github/project-automation.yml
name: Project Board Automation

on:
  issues:
    types: [opened, closed, assigned]
  pull_request:
    types: [opened, closed, merged]

jobs:
  update_project:
    runs-on: ubuntu-latest
    steps:
      - name: Move to In Progress
        if: github.event.action == 'assigned'
        uses: alex-page/github-project-automation-plus@v0.8.1
        with:
          project: Expense Tracker Development
          column: In Progress
          repo-token: ${{ secrets.GITHUB_TOKEN }}
```

### Automated Documentation Updates
```yaml
# .github/workflows/update-function-log.yml
name: Update Function Log

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  update_function_log:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Update Function Log Status
        run: |
          # Extract completed features from PR labels
          PR_LABELS="${{ github.event.pull_request.labels.*.name }}"

          # Update FUNCTION_LOG.md based on completed features
          if [[ "$PR_LABELS" == *"feature:expenses"* ]]; then
            sed -i 's/| Add expense with title, amount, category | 🚧 | Unit, Integration |/| Add expense with title, amount, category | ✅ | Unit, Integration |/' docs/FUNCTION_LOG.md
          fi

      - name: Commit changes
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"
          git add docs/FUNCTION_LOG.md
          git commit -m "Auto-update function log from PR #${{ github.event.pull_request.number }}" || exit 0
          git push
```

## Linear Integration (Alternative)

### Linear API Automation
```javascript
// scripts/sync-linear-tasks.js
const { LinearClient } = require('@linear/sdk');

const client = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY
});

async function syncTasksToDocumentation() {
  const issues = await client.issues({
    filter: { project: { name: { eq: "Expense Tracker" } } }
  });

  // Update FUNCTION_LOG.md based on Linear issue status
  const completedFeatures = issues.nodes
    .filter(issue => issue.state.name === 'Done')
    .map(issue => ({
      title: issue.title,
      labels: issue.labels.nodes.map(l => l.name)
    }));

  // Auto-update documentation files
  updateFunctionLog(completedFeatures);
}

function updateFunctionLog(completedFeatures) {
  // Read FUNCTION_LOG.md
  // Update status based on completed Linear issues
  // Write back to file
}
```

### Linear Webhook Integration
```javascript
// api/webhooks/linear.js
export default function handler(req, res) {
  const { action, data } = req.body;

  if (action === 'update' && data.state?.name === 'Done') {
    // Issue completed in Linear
    // Trigger documentation update
    updateDocumentationStatus(data.title, 'completed');
  }

  res.status(200).json({ received: true });
}
```

## Slack Integration

### Development Notifications
```yaml
# .github/workflows/slack-notifications.yml
name: Development Notifications

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, merged]

jobs:
  notify_slack:
    runs-on: ubuntu-latest
    steps:
      - name: Notify Phase Completion
        if: contains(github.event.head_commit.message, 'Complete Phase')
        uses: 8398a7/action-slack@v3
        with:
          status: success
          text: |
            🎉 Phase Completed!

            **Commit**: ${{ github.event.head_commit.message }}
            **Author**: ${{ github.event.head_commit.author.name }}

            Please update:
            - [ ] FUNCTION_LOG.md status
            - [ ] Session summary
            - [ ] Next phase planning
          webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

## Documentation Automation

### Auto-Generate API Documentation
```yaml
# .github/workflows/api-docs.yml
name: Generate API Documentation

on:
  push:
    paths:
      - 'apps/api/src/**/*.ts'
    branches: [main]

jobs:
  generate_docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Generate OpenAPI docs
        run: |
          pnpm install --filter api --frozen-lockfile
          pnpm --filter api run build
          pnpm --filter api run docs:generate

      - name: Update API section in FUNCTION_LOG.md
        run: |
          # Extract endpoint count from generated docs
          ENDPOINT_COUNT=$(grep -c "paths:" docs/api-spec.json)

          # Update FUNCTION_LOG.md with current API implementation status
          sed -i "s/📋 Planned API Features/✅ $ENDPOINT_COUNT API Endpoints Implemented/" docs/FUNCTION_LOG.md

      - name: Commit updated docs
        run: |
          git add docs/
          git commit -m "Auto-update API documentation" || exit 0
          git push
```

### Test Coverage Integration
```yaml
# .github/workflows/coverage-update.yml
name: Update Test Coverage

on:
  push:
    branches: [main]

jobs:
  update_coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run tests and collect coverage
        run: |
          pnpm --filter mobile run test -- --coverage --watchAll=false
          pnpm --filter api run test:cov
          pnpm --filter web run test -- --coverage --watchAll=false

      - name: Update FUNCTION_LOG.md with coverage
        run: |
          # Extract coverage percentages
          MOBILE_COV=$(grep -o '[0-9]*\.[0-9]*%' apps/mobile/coverage/lcov-report/index.html | head -1)
          API_COV=$(grep -o '[0-9]*\.[0-9]*%' apps/api/coverage/lcov-report/index.html | head -1)

          # Update test coverage in documentation
          sed -i "s/Test Coverage: TBD/Test Coverage: Mobile $MOBILE_COV, API $API_COV/" docs/FUNCTION_LOG.md
```

## Monitoring Integration

### Production Monitoring Alerts
```javascript
// scripts/production-monitor.js
const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_TOKEN);

async function checkProductionHealth() {
  // Check API health endpoints
  const apiHealth = await fetch('https://api.expensetracker.com/health');

  // Check mobile app crash rates (from app store connect API)
  const crashRate = await getMobileCrashRate();

  // Update performance documentation
  if (crashRate > 0.01) { // 1% crash rate
    await slack.chat.postMessage({
      channel: '#development',
      text: `🚨 Mobile crash rate elevated: ${crashRate * 100}%\n\nAction required:\n- [ ] Review crash logs\n- [ ] Update RISK_ASSESSMENT.md\n- [ ] Plan hotfix if needed`
    });
  }
}
```

## Development Workflow Integration

### Pre-commit Hook Integration
```bash
#!/bin/sh
# .husky/pre-commit

# Run tests
cd apps/mobile && npm test --passWithNoTests
cd ../api && npm test --passWithNoTests
cd ../web && npm test --passWithNoTests

# Update documentation if function signatures changed
if git diff --cached --name-only | grep -E '\.(ts|tsx)$'; then
  echo "Code changes detected, checking documentation updates..."

  # Check if FUNCTION_LOG.md needs updating
  if [ -z "$(git diff --cached docs/FUNCTION_LOG.md)" ]; then
    echo "⚠️  Code changed but FUNCTION_LOG.md not updated"
    echo "Consider updating feature status if implementation changed"
  fi
fi

# Check UPDATE_CHECKLIST.md completion
echo "Remember to complete UPDATE_CHECKLIST.md before pushing!"
```

### IDE Integration (VS Code)
```json
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Update Function Log",
      "type": "shell",
      "command": "code",
      "args": ["docs/FUNCTION_LOG.md"],
      "group": "build",
      "presentation": {
        "reveal": "always",
        "panel": "new"
      }
    },
    {
      "label": "Create Task Completion Log",
      "type": "shell",
      "command": "cp",
      "args": [
        "docs/templates/TASK_COMPLETION_LOG_TEMPLATE.md",
        "docs/TASK_${input:taskNumber}_COMPLETION_LOG.md"
      ],
      "group": "build"
    }
  ],
  "inputs": [
    {
      "id": "taskNumber",
      "description": "Task number (e.g., 2.1)",
      "default": "2.1",
      "type": "promptString"
    }
  ]
}
```

## Metrics Dashboard Integration

### GitHub Actions Dashboard
```yaml
# .github/workflows/metrics-dashboard.yml
name: Update Metrics Dashboard

on:
  schedule:
    - cron: '0 9 * * *' # Daily at 9 AM
  workflow_dispatch:

jobs:
  update_metrics:
    runs-on: ubuntu-latest
    steps:
      - name: Collect Development Metrics
        run: |
          # Collect metrics from various sources
          COMMITS_TODAY=$(git log --since="24 hours ago" --oneline | wc -l)
          OPEN_ISSUES=$(gh issue list --state open --json number | jq length)
          CLOSED_ISSUES_WEEK=$(gh issue list --state closed --search "closed:>=$(date -d '7 days ago' +%Y-%m-%d)" --json number | jq length)

          # Update metrics in documentation
          cat > docs/DEVELOPMENT_METRICS.md << EOF
          # Development Metrics

          **Last Updated**: $(date)

          ## Weekly Progress
          - Commits Today: $COMMITS_TODAY
          - Open Issues: $OPEN_ISSUES
          - Issues Closed This Week: $CLOSED_ISSUES_WEEK

          ## Phase Progress
          - Phase 1: ✅ Complete (100%)
          - Phase 2: 🔄 In Progress (60%)
          - Phase 3: 📋 Planned (0%)
          EOF
```

## Integration Benefits

### Automated Maintenance
- **Reduced Manual Work**: GitHub Issues replace manual task logs
- **Real-time Updates**: Webhooks keep documentation current
- **Coverage Tracking**: Automated test coverage updates

### Improved Visibility
- **Slack Notifications**: Team awareness of progress
- **Dashboard Metrics**: Visual progress tracking
- **Automated Alerts**: Proactive issue identification

### Quality Assurance
- **Pre-commit Checks**: Ensure documentation consistency
- **Automated Testing**: CI/CD integration with quality gates
- **Performance Monitoring**: Production health integration

## Implementation Priority

### Phase 1: Basic Integration
1. GitHub Issues for task tracking
2. Pre-commit hooks for documentation checks
3. Slack notifications for major milestones

### Phase 2: Advanced Automation
1. Auto-update FUNCTION_LOG.md from PR labels
2. Test coverage integration
3. API documentation generation

### Phase 3: Production Integration
1. Monitoring alerts integration
2. Performance metrics dashboard
3. Advanced workflow automation

---

*This integration guide bridges manual documentation with automated tooling to reduce overhead while maintaining project visibility and quality.*
