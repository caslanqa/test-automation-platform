# {{PROJECT_NAME}}

A Playwright + TypeScript test-automation project scaffolded with
[`@caslanqa/create-playwright-ai`](https://www.npmjs.com/package/@caslanqa/create-playwright-ai).
It ships with three ready-to-use testing layers and full developer tooling:

- **UI testing** — Page Object Model + lazy, cached session auth.
- **API testing** — a layered client → service → test structure (`ApiClient` → services → specs).
- **AI Judge** — evaluate LLM/chatbot responses against rubrics with local (Ollama) or cloud models.
- **Tooling** — ESLint, Prettier, husky + lint-staged (pre-commit), commitlint (commit-msg), Allure.

## Prerequisites

- Node.js ≥ 18
- Playwright browsers (only for UI tests): `npx playwright install`
- Ollama (only for the AI Judge): https://ollama.com

## Getting started

Dependencies were installed by the scaffolder. Create your machine-local config from the tracked
examples (these real files are gitignored), edit them, then run:

```bash
# 1. Create local config from the examples:
cp env/environments.example.json env/environments.json
cp testData/users.example.json testData/users.json

# 2. Edit them:
#    env/environments.json  → BASE_URL (UI) + API_BASE_URL (API)
#    testData/users.json    → your login sessions (optional)

# 3. Run:
npm test                 # everything
npm run test:api         # API only (no browser needed)
npm run test:ui          # interactive UI mode
```

## Configuration

### Environments — `env/environments.json`

Selected with `TEST_ENV` (defaults to `common.DEFAULT_TEST_ENV`). Every string is flattened to a
`process.env` key by `config/loadEnv.ts`.

```json
{
  "common": { "DEFAULT_TEST_ENV": "dev" },
  "environments": {
    "dev": {
      "BASE_URL": "https://www.saucedemo.com/",
      "API_BASE_URL": "https://petstore3.swagger.io/api/v3"
    }
  }
}
```

- `BASE_URL` — the UI base URL (Playwright `baseURL`).
- `API_BASE_URL` — the API base URL (used by the API client). Kept separate so the two never collide.

Run against another environment: `TEST_ENV=staging npm test`.

### Login sessions — `testData/users.json`

```json
{
  "users": {
    "admin": { "username": "standard_user", "password": "secret_sauce" }
  }
}
```

Sessions log in lazily on first use and cache to `.auth/<key>.json`; select one with
`test.use({ session: 'admin' })`.

## Project structure

```
├── api/                    # API testing — 3 layers
│   ├── core/ApiClient.ts   #   layer 1: typed get/post/put/patch/delete over APIRequestContext
│   ├── services/           #   layer 2: business operations (e.g. PetService)
│   └── models/             #   domain types
├── config/                 # loadEnv + aiJudge.config
├── fixtures/               # test/expect, session auth, expectAi, apiFixtures
├── pages/                  # Page Object Models (BasePage, LoginPage)
├── utils/ai/               # AI Judge engine (routing, providers, judge)
├── tests/
│   ├── example/            # UI + AI Judge examples
│   └── api/                # API examples (*.api.ts)
├── env/environments.json   # per-environment config
├── testData/users.json     # login sessions
├── .husky/                 # git hooks (pre-commit, commit-msg)
├── playwright.config.ts
└── eslint.config.js · .prettierrc · .commitlintrc.json
```

## Writing tests

### UI test (with a session)

```typescript
import { test, expect } from '@fixtures/globalFixtures';

test.use({ session: 'admin' });

test('admin reaches the dashboard', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/dashboard/);
});
```

### API test (service layer)

```typescript
import { test, expect } from '@fixtures/apiFixtures';

test('available items', async ({ petService }) => {
  const items = await petService.findAvailable();
  expect(items.length).toBeGreaterThan(0);
});
```

Add your own resource: create a service under `api/services/` that takes an `ApiClient` and exposes
business methods, then expose it through a fixture in `fixtures/apiFixtures.ts`.

### AI Judge test

```typescript
import { judgeResponse } from '@utils/aiJudge';

test('bot answer meets the rubric', async () => {
  const verdict = await judgeResponse({
    userMessage: 'What time do you open?',
    botResponse: 'We open at 9am every day.',
    rubric: 'Must state the store opens at 9am.',
  });
  expect(verdict.pass, verdict.reasoning).toBeTruthy();
});
```

Or assert directly with `expectAi`:

```typescript
import { expectAi } from '@fixtures/aiExpect';

await expectAi({ userMessage, botResponse, rubric }).toPassRubric({ minScore: 70 });
```

Model choice is automatic (complexity → tier → a model discovered from your installed Ollama models,
with a cloud fallback). See [docs/AI_JUDGE.md](docs/AI_JUDGE.md) and [docs/API_TESTING.md](docs/API_TESTING.md).
{{MOBILE_SECTION}}{{DESKTOP_SECTION}}{{NATIVE_SECTION}}

## Tooling

```bash
npm run lint          # ESLint
npm run format        # Prettier
npm run type-check    # tsc --noEmit
```

Git hooks are active after install: **pre-commit** runs lint-staged (ESLint + Prettier on staged
files), **commit-msg** enforces Conventional Commits via commitlint. Reports: `npm run report:allure`.

## License

MIT
