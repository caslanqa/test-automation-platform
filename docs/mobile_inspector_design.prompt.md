---

# ROLE

You are a **Playwright Core Contributor**, **Staff TypeScript Architect**, **Electron Architect**, **VS Code Extension Architect**, **Mobile Automation Expert**, and **Developer Experience (DX)** specialist.

Think exactly like the engineers who designed:

- Playwright
- Playwright Inspector
- Playwright Codegen
- Playwright Trace Viewer
- Chrome DevTools

Do **NOT** think like an Appium engineer.

Do **NOT** think like a Maestro engineer.

Think like someone extending the Playwright ecosystem itself.

---

# CONTEXT

I am building an open-source Playwright-based automation framework.

The framework already supports:

- Playwright
- Maestro
- Appium
- Android
- iOS
- AI-assisted automation
- TypeScript

The public API intentionally looks identical to Playwright.

Example:

```ts
test('Login', async ({ app }) => {
  await app.tap('Sign In');
  await app.fill('Email', 'demo@test.com');
  await app.fill('Password', '123456');
  await app.tap('Login');
});
```

Users must never see:

- Appium APIs
- Maestro YAML
- Driver-specific commands

Drivers are implementation details.

Everything should generate Playwright-style TypeScript.

---

# NEW PRODUCT VISION

I DO NOT want a standalone Electron application anymore.

Instead, I want to build something equivalent to a **Playwright Extension** that behaves exactly like Playwright Inspector.

Think of it as:

```
Playwright
    │
    ├── Inspector
    ├── Trace Viewer
    ├── Codegen
    └── Mobile Inspector (new)
```

The Mobile Inspector should feel like it was officially developed by the Playwright team.

The user should never feel they are switching to another application.

---

# DESIGN GOALS

The Mobile Inspector must integrate seamlessly into the Playwright ecosystem.

Examples:

```
pwtap codegen
```

or

```
playwright codegen --mobile
```

or

```
playwright inspect --mobile
```

The familiar Playwright Inspector window opens.

Instead of rendering a browser page, it renders a live mobile device.

Everything else should feel familiar.

---

# CORE IDEA

Instead of designing a new application,

design a **Playwright Inspector Extension**.

The extension should plug into:

- Playwright Inspector
- Codegen
- Recorder
- Trace Viewer
- Test Runner
- Reporter
- VS Code extension
- CLI

The experience should be indistinguishable from native Playwright features.

---

# IMPORTANT REQUIREMENTS

The Mobile Inspector should be implemented as a modular Playwright plugin.

It must extend existing Playwright capabilities instead of replacing them.

Assume Playwright exposes extension points (or propose them if they don't exist).

Design the architecture accordingly.

Avoid creating duplicate infrastructure when existing Playwright components can be reused.

---

# ARCHITECTURE OBJECTIVES

Design a production-grade architecture.

Optimize for:

- extensibility
- performance
- maintainability
- Playwright compatibility
- future upstream contribution

Assume this could eventually become an official Playwright feature.

---

# DESIGN TASKS

Provide a complete architecture document covering the following.

---

## 1. Product Vision

Explain:

- Why integrating with Playwright is superior to building a standalone application.
- How this improves developer experience.
- How it aligns with Playwright philosophy.

---

## 2. Playwright Integration

Explain how Mobile Inspector integrates with:

- Inspector
- Codegen
- Trace Viewer
- Reporter
- CLI
- VS Code Extension
- Test Runner

Show which existing Playwright modules can be reused.

Show which new extension points are required.

---

## 3. User Experience

Describe the complete workflow.

Example:

```
playwright codegen --mobile
```

↓

device discovery

↓

device selection

↓

live screen

↓

element picker

↓

gesture recording

↓

generated TypeScript

↓

save into test

Explain every interaction.

---

## 4. UI Design

Reuse the Playwright Inspector UI philosophy.

Design:

- Toolbar
- Sidebar
- Timeline
- Live Device
- Locator Explorer
- Accessibility Tree
- Generated Code
- Console
- AI Assistant
- Recording Controls
- Test Controls

Provide ASCII mockups.

---

## 5. Recording Engine

Design a recording engine that integrates with Playwright Codegen.

Explain:

- touch capture
- swipe
- pinch
- drag
- keyboard
- waits
- assertions
- scrolling

How recorded actions become:

```ts
await app.tap(...)
```

instead of YAML.

---

## 6. Locator Engine

Design a locator engine inspired by Playwright Locator API.

Explain:

- locator ranking
- confidence scoring
- AI-assisted locator selection
- accessibility priority
- unstable locator detection
- fallback strategies

---

## 7. Code Generator

Design an incremental TypeScript generator.

Should it reuse Playwright Codegen?

Should AST transforms be used?

How should existing test files be updated?

How should imports be managed?

---

## 8. Plugin Architecture

Design a driver plugin system.

Example:

```
Mobile Inspector

↓

Driver API

↓

Maestro Plugin

↓

Appium Plugin

↓

Espresso Plugin

↓

XCUITest Plugin

↓

Future Drivers
```

Each driver should implement the same interface.

---

## 9. Extension API

Design a public API for third-party plugins.

Example:

```ts
registerDriver();

registerLocatorStrategy();

registerGesture();

registerInspectorPanel();

registerAIProvider();
```

Explain lifecycle hooks.

---

## 10. Internal Architecture

Recommend a monorepo.

Example:

```
packages/

mobile-inspector

inspector-ui

codegen

recorder

locator-engine

driver-api

driver-maestro

driver-appium

driver-espresso

driver-xcuitest

shared

cli

vscode-extension

ai

utils
```

Explain every package.

---

## 11. Performance

Explain:

- incremental accessibility updates
- smart XML diffing
- partial screen refresh
- event batching
- caching
- worker threads
- memory optimization

---

## 12. AI Features

Imagine an integrated AI assistant.

Examples:

- locator recommendations
- flaky interaction detection
- assertion generation
- Page Object extraction
- reusable helper generation
- flow simplification
- duplicate interaction detection
- accessibility improvements

Invent additional AI capabilities beyond existing tools.

---

## 13. Future Vision

Imagine Version 2.

Imagine Version 3.

Think beyond:

- Playwright
- Maestro
- Appium

Invent entirely new mobile automation workflows.

---

## 14. Technology Choices

Recommend technologies.

Explain why.

Examples:

- React
- TypeScript
- Electron (only if required)
- Monaco
- Zustand
- xstate
- Worker Threads
- WebSocket
- ADB
- simctl

Prefer reusing Playwright infrastructure wherever possible.

---

## 15. Risks

Identify:

- architectural risks
- platform limitations
- Playwright compatibility concerns
- performance bottlenecks
- cross-platform issues
- plugin versioning
- maintainability risks

---

## 16. MVP Roadmap

Split into:

- Phase 1
- Phase 2
- Phase 3
- Phase 4

Estimate implementation complexity.

Highlight dependencies.

---

## 17. Open Source Strategy

Design the project for long-term community adoption.

Explain:

- plugin versioning
- extension API stability
- contribution guidelines
- compatibility with future Playwright releases

---

# OUTPUT REQUIREMENTS

Produce a professional software architecture document.

Use:

- architecture diagrams
- sequence diagrams
- flow charts
- ASCII layouts
- component diagrams
- tables

Challenge assumptions.

Whenever possible, reuse existing Playwright internals instead of inventing new infrastructure.

If Playwright lacks an extension point, explicitly propose one.

Design the Mobile Inspector as though it could be submitted as an official Playwright RFC and accepted into the Playwright ecosystem.

**Optimize for the best long-term architecture, extensibility, and developer experience—not for minimum implementation effort.**

---
