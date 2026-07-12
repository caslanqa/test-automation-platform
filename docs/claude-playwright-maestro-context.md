# Claude Context Prompt --- Playwright + Maestro Unified QA Execution

You are joining an ongoing technical architecture discussion. Continue
from the context below rather than restarting the ideation from scratch.

## User Context

I am a Senior QA Automation Engineer and I am building tooling around
Playwright, AI-assisted QA, local LLMs, and test orchestration.

I maintain/published the npm package:

`@caslanqa/playwright-ai-distro`

My broader direction is to evolve Playwright-based tooling beyond a
conventional browser automation framework into a unified QA
execution/orchestration layer.

I prefer practical, production-grade architecture discussions. Challenge
weak ideas and explicitly call out technical limitations, hidden
complexity, and maintainability risks. Do not merely agree with me.

## Core Idea We Discussed

Maestro is a CLI-first, declarative YAML-based UI automation framework
primarily used for mobile automation.

Example Maestro flow:

``` yaml
appId: com.example.app
---
- launchApp
- tapOn: "Login"
- inputText: "cihan@example.com"
- tapOn: "Continue"
- assertVisible: "Welcome"
```

Execution:

``` bash
maestro test flow.yaml
```

The idea is NOT to make Playwright directly automate native mobile UI.

The architectural idea is:

> Use Playwright Test as the unified test runner and orchestration
> layer, while Maestro remains the mobile execution engine.

Conceptually:

``` text
                 PLAYWRIGHT TEST
             Unified Test Orchestrator
                        |
          +-------------+-------------+
          |             |             |
       Web Engine    API Engine    Mobile Engine
          |             |             |
      Playwright     PW Request     Maestro CLI
          |                           |
   Chromium/WebKit              iOS / Android
```

Playwright would provide:

-   test runner
-   fixtures
-   worker management
-   retries
-   tags/filtering
-   projects/configuration
-   reporting
-   CI entry point
-   potentially unified execution graph

Maestro would provide:

-   native mobile UI execution
-   Android device/emulator interaction
-   iOS simulator interaction
-   YAML flow execution

## Initial Adapter Concept

A simple Playwright fixture could wrap Maestro CLI:

``` ts
import { test as base } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const test = base.extend<{
  maestro: {
    run: (flow: string) => Promise<void>;
  };
}>({
  maestro: async ({}, use) => {
    await use({
      run: async (flow) => {
        await execFileAsync('maestro', ['test', flow]);
      }
    });
  }
});
```

Usage:

``` ts
test('mobile login', async ({ maestro }) => {
  await maestro.run('tests/mobile/flows/login.yaml');
});
```

This also creates the possibility of cross-channel journeys:

``` ts
test('complete checkout journey', async ({
  page,
  maestro,
  api
}) => {
  await api.createUser();

  await page.goto('/admin');
  await approveUser(page);

  await maestro.run('mobile/checkout.yaml');

  const order = await api.getOrder();

  expect(order.status).toBe('COMPLETED');
});
```

The important goal is:

> API -\> Web -\> Mobile -\> API validation inside one orchestration
> model and one reporting/CI surface.

## Device Management Discussion

Device connection should NOT be handled by Playwright itself.

Maestro remains responsible for actual device communication/execution.

The proposed architecture is:

``` text
Playwright Worker
       |
       v
Maestro Adapter
       |
       v
Device Manager
       |
       +-- discover devices
       +-- reserve device
       +-- boot simulator/emulator if necessary
       +-- wait until ready
       +-- install application
       +-- return device identifier
       |
       v
Maestro CLI
       |
       +-- Android / ADB
       +-- iOS Simulator
```

Possible device discovery mechanisms:

Android:

``` bash
adb devices
```

iOS:

``` bash
xcrun simctl list devices booted
```

Maestro can execute against a selected device conceptually like:

``` bash
maestro --device <device-id> test flow.yaml
```

The test author ideally should NOT manually manage raw device IDs.

Desired API direction:

``` ts
test.use({
  mobile: {
    platform: 'android',
    device: 'Pixel 8',
    osVersion: '34'
  }
});
```

Internally:

``` ts
const device = await deviceManager.acquire({
  platform: 'android',
  model: 'Pixel 8',
  osVersion: '34'
});

await maestro.run(flow, {
  device: device.id
});
```

## Device Pool / Playwright Worker Idea

One interesting architectural direction is mapping Playwright workers to
reserved mobile devices.

Example:

``` text
PW Worker 1 ------ Pixel 8 Emulator
PW Worker 2 ------ Pixel 7 Emulator
PW Worker 3 ------ iPhone Simulator
PW Worker 4 ------ Physical Android
```

Then:

``` bash
npx playwright test --workers=4
```

could conceptually result in:

``` text
4 Playwright workers
        |
4 device acquisitions
        |
4 isolated Maestro processes
        |
parallel mobile execution
```

This means we may not need to delegate test scheduling/sharding entirely
to Maestro.

Instead:

> Playwright Worker Scheduler + our Device Pool Manager could own
> orchestration.

However, this needs critical analysis around worker lifecycle, retries,
device state leakage, parallel Maestro processes, simulator capacity,
process isolation, locking, and reporter integration.

## Package/API Direction

A possible package API:

``` ts
import { test } from '@caslanqa/playwright-mobile';

test.use({
  device: {
    platform: 'android',
    model: 'Pixel 8'
  }
});

test('login', async ({ mobile }) => {
  await mobile.run('flows/login.yaml');
});
```

Potential architecture:

``` text
@caslanqa/playwright-ai-distro
             |
             +-- Web Engine
             |      +-- Playwright
             |
             +-- Mobile Engine
             |      +-- Maestro Adapter
             |
             +-- API Engine
             |      +-- Playwright Request
             |
             +-- AI Judgment
             |      +-- Local/OpenAI-compatible LLM Gateway
             |
             +-- Unified Reporting
             |
             +-- Execution Orchestrator
```

## The Next Important Idea

The next topic we wanted to investigate was:

> Can Maestro YAML flow files be discovered and represented as
> Playwright tests without requiring developers to manually create one
> `.spec.ts` wrapper per YAML file?

Desired developer experience:

``` text
tests/
├── web/
│   └── login.spec.ts
├── api/
│   └── users.spec.ts
└── mobile/
    └── flows/
        ├── login.yaml
        ├── checkout.yaml
        └── profile.yaml
```

Then ideally:

``` bash
npx playwright test
```

would discover/execute:

-   Playwright web tests
-   Playwright API tests
-   Maestro mobile YAML flows

and expose them through a coherent reporting surface.

We need to investigate whether this should be implemented through:

-   generated Playwright spec files
-   runtime test registration
-   a custom loader/transformation step
-   a pre-test discovery/compiler phase
-   Playwright project configuration
-   a custom CLI wrapping `playwright test`
-   another architecture entirely

Do NOT assume dynamic Playwright discovery is straightforward. Verify
Playwright Test's actual discovery and runtime registration constraints.

## Your Task

Continue this architecture discussion as a senior test
infrastructure/framework architect.

First, critically evaluate the overall Playwright + Maestro
architecture.

Then focus specifically on the YAML discovery problem.

I want you to propose a production-grade architecture that:

1.  Keeps Maestro as the native mobile execution engine.
2.  Uses Playwright Test where it genuinely adds value.
3.  Avoids fighting Playwright internals unnecessarily.
4.  Supports mobile device acquisition and locking.
5.  Supports parallel workers safely.
6.  Supports retries with deterministic device reset semantics.
7.  Bridges Maestro artifacts/results into Playwright reporting as much
    as realistically possible.
8.  Allows YAML-first mobile test authoring.
9.  Minimizes or eliminates manually written `.spec.ts` wrappers.
10. Can later fit into `@caslanqa/playwright-ai-distro`.

Please separate:

-   what is technically clean
-   what is technically possible but hacky
-   what should not be done

Then propose:

-   package/module structure
-   execution lifecycle
-   device manager lifecycle
-   YAML discovery strategy
-   Playwright fixture design
-   reporter/artifact bridge
-   CLI design
-   MVP scope
-   V2 roadmap

Use TypeScript/Node.js examples where useful.

Do not give me a generic Maestro or Playwright tutorial. Treat this as
an architecture/design review for a real open-source QA tooling project.
