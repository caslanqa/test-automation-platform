# Playwright AI Distro

A production-ready, standalone Playwright test automation framework with built-in **AI Judge** capabilities for LLM-powered response evaluation.

[![npm version](https://img.shields.io/npm/v/@caslanqa/create-playwright-ai)](https://www.npmjs.com/package/@caslanqa/create-playwright-ai)
[![license](https://img.shields.io/npm/l/@caslanqa/create-playwright-ai)](https://github.com/caslanqa/playwright-ai-distro/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@caslanqa/create-playwright-ai)](https://nodejs.org)

> **This is a scaffolder (`create-*`), not a library.** The `npm i …` box at the top of this npm page
> is auto-generated — **don't use it.** Create a ready-to-run project with `npm init` / `npm create`:

```bash
npm init @caslanqa/playwright-ai@latest my-project
```

## 🚀 Key Features

- **AI Judge System** - Evaluate chatbot/LLM responses using local or cloud models
- **Dual LLM Routing** - Ollama (local, free) or 9Router gateway (Claude, GPT)
- **Layered API Testing** - `ApiClient` → service → test structure (Petstore v3 example)
- **Mobile Testing** - Maestro YAML flows orchestrated by Playwright, opt-in (`--mobile`)
- **Lazy Session Auth** - Cached storageState per session, worker-safe, opt-in
- **Page Object Model** - Clean, maintainable test structure
- **Environment-Driven** - JSON-based configuration, zero hardcoded values
- **Full Tooling** - ESLint, Prettier, husky + lint-staged, commitlint out of the box
- **Full CI/CD** - GitHub Actions with Ollama setup

## 🧰 Requirements

Only **Node.js ≥ 18** is always required. Everything else is per-feature and installed by _you_ (the
scaffolder installs the npm deps + Playwright browsers, but not these system-level tools):

| For             | You need                                                                                                                                                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything      | **Node.js ≥ 18**                                                                                                                                                                                                                                                                                                                        |
| UI tests        | Playwright browsers — `npx playwright install`                                                                                                                                                                                                                                                                                          |
| API tests       | nothing beyond Node (they call an HTTP endpoint)                                                                                                                                                                                                                                                                                        |
| AI Judge        | [Ollama](https://ollama.com) + a pulled model (local), **or** a 9Router gateway + `JUDGE_API_KEY`                                                                                                                                                                                                                                       |
| Mobile (opt-in) | [Maestro](https://maestro.mobile.dev) CLI + **Java 17+**, and a device: Android SDK + emulator, or (macOS) Xcode + iOS simulator. To build an AVD via `mobile:create-device` you also need the Android command-line tools — [setup (macOS/Windows/Linux, GUI or CLI)](docs/MOBILE_TESTING.md#installing-the-android-command-line-tools) |

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

The scaffolder copies the framework, generates `package.json`, runs `npm install`, installs the
Playwright browsers, and initializes git (so husky hooks activate). **After it finishes:**

```bash
cd my-project

# 1. Point the config at your app:
#    env/environments.json  → BASE_URL (UI) + API_BASE_URL (API)
#    testData/users.json    → your login sessions (optional)

# 2. Run the tests:
npm test              # everything
npm run test:api      # API only (no browser needed)
npm run test:ui       # interactive UI mode
```

Flags: `--no-install` (skip `npm install`), `--no-browsers` (skip browser download), `--no-gha` (skip
the GitHub Actions workflow), `--mobile` (include mobile testing / Maestro), `-y/--yes` (accept
defaults). Omit the project name to scaffold into the current directory.

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
  "common": { "DEFAULT_TEST_ENV": "dev" },
  "environments": {
    "dev": {
      "BASE_URL": "http://localhost:3000",
      "API_BASE_URL": "http://localhost:3000/api"
    }
  }
}
```

- `BASE_URL` — the UI base URL (Playwright `baseURL`).
- `API_BASE_URL` — the API base URL (used by the API client, see [API Testing](#-api-testing)). Kept
  separate from `BASE_URL` so UI and API targets never collide.
- Every string scalar is flattened to a `process.env` key by `config/loadEnv.ts`. Select an
  environment with `TEST_ENV` (e.g. `TEST_ENV=staging npm test`).

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

# Run only the API tests (no browser needed)
npx playwright test --project=api

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

## 🔌 API Testing

A layered structure keeps HTTP details in one place and tests readable. See
[docs/API_TESTING.md](docs/API_TESTING.md); the example targets [Petstore v3](https://petstore3.swagger.io).

```text
tests/api/*.api.ts          # layer 3 — tests speak business language via services
api/services/PetService.ts  # layer 2 — business operations (fetch, CRUD, derived queries)
api/core/ApiClient.ts       # layer 1 — typed get/post/put/patch/delete over APIRequestContext
```

Tests run in the browser-free `api` project (`npm run test:api`), with the base URL from
`API_BASE_URL`:

```typescript
import { test, expect } from '@fixtures/apiFixtures';

test('available pets are all "available"', async ({ petService }) => {
  const pets = await petService.findAvailable();
  expect(pets.length).toBeGreaterThan(0);
  expect(pets.every(p => p.status === 'available')).toBeTruthy();
});
```

## 📱 Mobile Testing

Mobile tests are [Maestro](https://maestro.mobile.dev) YAML flows orchestrated by Playwright (Maestro
is the mobile engine, invoked via its CLI — no npm dependency). **Opt-in**: scaffold with `--mobile`.
Tests read like the UI/API tests — see [docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md).

```typescript
import { test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices'; // typed device catalog — mobile/devices.ts

test.describe('Login — Android', () => {
  test.use({ mobile: devices.pixel7 }); // auto-boots the AVD if it isn't running

  test('signs in', async ({ maestro }) => {
    await maestro.run('tests/mobile/flows/android/login.yaml');
  });
});
```

Runs serially in the browser-free `mobile` project: `npm run test:mobile`. A catalogued `device`
auto-boots (Android AVD / iOS simulator); with none available the tests **skip** (don't fail). No
device yet? `npm run mobile:create-device` builds one from your installed SDK/Xcode.

## 📁 Project Structure

```text
playwright-ai-distro/
├── .auth/                    # Storage state files (gitignored)
├── .github/workflows/        # CI/CD pipelines
├── .husky/                   # git hooks (pre-commit → lint-staged, commit-msg → commitlint)
├── api/                      # API testing (3 layers)
│   ├── core/ApiClient.ts     #   layer 1: typed get/post/put/patch/delete → ApiResponse<T>
│   ├── services/             #   layer 2: business operations (PetService)
│   └── models/               #   domain types (Pet, …)
├── config/                   # Environment + judge config
│   ├── loadEnv.ts
│   ├── envUtils.ts
│   └── aiJudge.config.ts     # tiers, thresholds, routing preferences
├── docs/                     # AI_JUDGE.md · API_TESTING.md · MOBILE_TESTING.md
├── env/                      # environments.json (BASE_URL, API_BASE_URL)
├── fixtures/                 # Playwright fixtures
│   ├── globalFixtures.ts     #   test/expect + `session` storageState-key option
│   ├── auth.ts               #   lazy session login + caching (authState, ensureSession)
│   ├── aiExpect.ts           #   expectAi matchers
│   ├── apiFixtures.ts        #   apiClient + service fixtures (browser-free)
│   └── mobileFixtures.ts     #   maestro fixture + `mobile` option (opt-in)
├── mobile/                   # Mobile testing (Maestro) — opt-in
│   └── core/                 #   MaestroRunner + DeviceManager (adb/simctl, auto-boot)
├── pages/                    # Page Object Models (BasePage, LoginPage)
├── testData/                 # users.json (named login sessions)
├── tests/
│   ├── example/              #   UI + AI Judge examples
│   ├── api/                  #   API examples (*.api.ts)
│   └── mobile/               #   Maestro flows + *.mobile.ts (opt-in)
├── utils/
│   ├── ai/                   #   AI Judge engine (router, providers, judge)
│   ├── aiJudge.ts            #   judge entrypoint (re-exports utils/ai)
│   └── *.ts                  #   date/string/wait/validation helpers
├── playwright.config.ts      # chromium + api (+ mobile when scaffolded)
└── eslint.config.js · .prettierrc · .commitlintrc.json
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

Git hooks are wired via husky: **pre-commit** runs lint-staged (ESLint + Prettier on staged files)
and **commit-msg** enforces [Conventional Commits](https://www.conventionalcommits.org) via
commitlint (`.commitlintrc.json`). They activate after `npm install` in a git repo.

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
- [API Testing Guide](docs/API_TESTING.md) - Layered API client/service/test structure
- [Mobile Testing Guide](docs/MOBILE_TESTING.md) - Maestro flows orchestrated by Playwright
- [Playwright Docs](https://playwright.dev/docs/intro) - Official Playwright docs

## 📄 License

MIT
