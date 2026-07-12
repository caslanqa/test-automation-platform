# Playwright AI Distro

A production-ready, standalone Playwright test automation framework with built-in **AI Judge** capabilities for LLM-powered response evaluation.

## 🚀 Key Features

- **AI Judge System** - Evaluate chatbot/LLM responses using local or cloud models
- **Dual LLM Routing** - Ollama (local, free) or 9Router gateway (Claude, GPT)
- **Multi-Worker Auth** - File-based mutex for parallel authentication
- **Page Object Model** - Clean, maintainable test structure
- **Environment-Driven** - JSON-based configuration, zero hardcoded values
- **Full CI/CD** - GitHub Actions with Ollama setup

## 📦 Create a new project

Scaffold a ready-to-run project with a single command — exactly like the
official Playwright (`npm init playwright@latest`):

```bash
npm init @caslanqa/playwright-ai@latest my-project
```

Equivalent forms:

```bash
npm  create @caslanqa/playwright-ai@latest my-project
npx  @caslanqa/create-playwright-ai my-project
yarn create @caslanqa/playwright-ai my-project
pnpm create @caslanqa/playwright-ai my-project
```

This copies the template, generates `package.json`, then automatically runs
`npm install` and installs the Playwright browsers. When it finishes:

```bash
cd my-project
npm test
```

Flags: `--no-install` (skip `npm install`), `--no-browsers` (skip browser
download). Omit the project name to scaffold into the current directory.

## 🛠️ Develop this framework (contributors)

```bash
# Clone the repository
git clone https://github.com/caslanqa/playwright-ai-distro.git
cd playwright-ai-distro

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install --with-deps

# Copy example configuration files
cp env/environments.example.json env/environments.json
cp testData/users.example.json testData/users.json
```

## 🔧 Configuration

### Environment Setup

Edit `env/environments.json` to configure your test environments:

```json
{
  "common": {
    "DEFAULT_TEST_ENV": "dev"
  },
  "environments": {
    "dev": {
      "BASE_URL": "http://localhost:3000",
      "myapp": {
        "baseUrl": "http://localhost:3000"
      }
    }
  }
}
```

### User Credentials

Edit `testData/users.json` to declare named login sessions:

```json
{
  "users": {
    "admin": { "username": "admin@example.com", "password": "your_password" },
    "customer": { "username": "customer@example.com", "password": "your_password" }
  }
}
```

Sessions are logged in lazily on first use and cached to `.auth/<key>.json`; select one with
`test.use({ session: 'admin' })`.

## 🧪 Running Tests

```bash
# Run all tests
npx playwright test

# Run specific browser
npx playwright test --project=chromium

# Run with specific environment
TEST_ENV=staging npx playwright test

# Run tests with tag
npx playwright test --grep @smoke

# Run in UI mode (debugging)
npx playwright test --ui

# Generate report
npx playwright show-report
```

## 🤖 AI Judge System

The AI Judge evaluates chatbot/LLM responses against rubrics. See [docs/AI_JUDGE.md](docs/AI_JUDGE.md) for detailed documentation.

### Quick Start

```typescript
import { judgeResponse } from '@utils/aiJudge';

test('chatbot responds correctly', async () => {
  const verdict = await judgeResponse({
    userMessage: 'What time do you open?',
    botResponse: 'We open at 9am every day.',
    rubric: 'Must state the store opens at 9am.',
  });

  expect(verdict.pass, verdict.reasoning).toBeTruthy();
});
```

### Model Selection

Model choice is **automatic** by default. The judge scores each call's complexity into a tier
(`simple` / `medium` / `complex`) and resolves it to a concrete model **discovered at runtime** —
never a hardcoded list:

- **Local first:** the installed Ollama models are ranked by parameter size — smallest for
  `simple`, largest for `complex`, median for `medium`. Nothing to configure; it adapts to
  whatever you have pulled.
- **Cloud fallback:** only when no compatible local model exists (e.g. an image needs a
  vision-capable model and none is installed) does it fall back to a model discovered from the
  9Router gateway (requires `JUDGE_API_KEY`).

Override per call when you need control:

```typescript
await judgeResponse({ ...input, model: 'gh/claude-sonnet-4.6' }); // exact model (pins the judge)
await judgeResponse({ ...input, tier: 'complex' }); // force a tier
await judgeResponse({ ...input, verbose: true }); // attach routing trace to _meta
```

Set `JUDGE_MODEL` in `env/environments.json` to pin one model globally (disables auto-routing).
Tune tiers, thresholds, and cloud preferences in `config/aiJudge.config.ts`.

## 📁 Project Structure

```
playwright-ai-distro/
├── .auth/                    # Storage state files (gitignored)
├── .github/workflows/        # CI/CD pipelines
├── config/                   # Environment loading
│   ├── loadEnv.ts
│   └── envUtils.ts
├── docs/                     # Documentation
│   └── AI_JUDGE.md
├── env/                      # Environment config
│   └── environments.json
├── fixtures/                 # Playwright fixtures
│   ├── globalFixtures.ts     # test/expect + `session` storageState-key option
│   ├── auth.ts               # lazy session login + caching (authState, ensureSession)
│   └── aiExpect.ts           # expectAi matchers
├── pages/                    # Page Object Models
│   ├── BasePage.ts
│   └── LoginPage.ts
├── scripts/ci/               # CI scripts
│   └── judge-services.sh
├── testData/                 # Named login sessions
│   └── users.json
├── tests/
│   └── example/              # Example tests
├── utils/                    # Utilities
│   ├── aiJudge.ts            # AI Judge core
│   ├── types.ts              # TypeScript types
│   ├── apiUtils.ts
│   ├── dateUtils.ts
│   └── ...
└── playwright.config.ts
```

## 🔐 Authentication

Session-based, opt-in, and **lazy**. Declare named sessions in `testData/users.json`; a test opts in
with `test.use({ session: 'admin' })`. The first test that uses a session logs in once and caches
`.auth/<key>.json`; every later test and run reuses it — no repeated logins, no setup project.
Unauthenticated tests (e.g. public pages) set nothing.

```typescript
// Select a session for a test or a whole describe:
test.use({ session: 'admin' });

test('admin sees the dashboard', async ({ page }) => {
  await page.goto('/dashboard'); // already signed in as admin
});
```

The login flow lives in `fixtures/auth.ts` → `loginSession` (customize it; the generic branch uses
`pages/LoginPage` with credentials from `testData/users.json`). For cross-role tests, open
independent contexts — `ensureSession` performs the lazy login first:

```typescript
import { authState, ensureSession } from '@fixtures/auth';
await ensureSession(browser, 'admin');
const adminCtx = await browser.newContext({ storageState: authState('admin') });
```

## 📊 Reporters

- **HTML Report**: `playwright-report/`
- **Allure Report**: `allure-results/`
- **JSON Results**: `test-results/results.json`

Generate Allure report:

```bash
npx allure generate allure-results -o allure-report --clean
npx allure open allure-report
```

## 🛠️ Development

```bash
# Lint code
npm run lint

# Fix lint issues
npm run lint:fix

# Format code
npm run format

# Type check
npx tsc --noEmit
```

## 📝 Writing Tests

### Basic Test

```typescript
import { test, expect } from '@fixtures/globalFixtures';
import { LoginPage } from '@pages/LoginPage';

test('user can view dashboard', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

### Test with a Different Session

```typescript
test.use({ session: 'admin' });

test('admin can access settings', async ({ page }) => {
  await page.goto('/admin/settings');
  await expect(page).toHaveURL(/settings/);
});
```

### AI Judge Test

```typescript
import { judgeResponse } from '@utils/aiJudge';

test('AI provides helpful response', async ({ page }) => {
  // Interact with chatbot
  await page.fill('[data-testid="chat-input"]', 'How do I reset my password?');
  await page.click('[data-testid="send-button"]');

  // Get bot response
  const response = await page.locator('[data-testid="bot-message"]').last().textContent();

  // Judge the response
  const verdict = await judgeResponse({
    userMessage: 'How do I reset my password?',
    botResponse: response || '',
    rubric: 'Must explain password reset process with clear steps.',
  });

  expect(verdict.pass, verdict.reasoning).toBeTruthy();
  expect(verdict.score).toBeGreaterThan(70);
});
```

## 🌐 CI/CD

GitHub Actions workflow includes:

- Automatic Ollama setup for AI Judge
- Multi-browser testing
- Allure report generation
- Artifact uploads

Trigger manually with custom options:

```yaml
workflow_dispatch:
  inputs:
    environment: dev|staging|production
    judge_model: <optional pin, e.g. local/qwen3.5; empty = auto-routing>
    browser: chromium|firefox|webkit|all
```

## 📚 Documentation

- [AI Judge Guide](docs/AI_JUDGE.md) - Detailed AI Judge documentation
- [Playwright Docs](https://playwright.dev/docs/intro) - Official Playwright docs

## 📄 License

MIT
