# @pwtap/platform

## 0.2.0

### Minor Changes

- c6df135: Add device system log capture and screen recording primitives, shared by mobile plugins: `clearLogcat`/`dumpLogcat` and `startAndroidRecording` (Android), `logCaptureStart`/`dumpSimLog` and `startSimRecording` (iOS simulator), and the `ScreenRecording` type.

## 0.1.1

### Patch Changes

- d508646: Add per-package READMEs (npm landing pages) and rewrite the root README for the monorepo.

## 0.1.0

### Minor Changes

- Initial public release of the Playwright Test Automation Platform.

  - `@pwtap/platform` — macOS-first platform seam (paths, shell, device discovery/boot, device lock) for plugins.
  - `@pwtap/create` — UI + API core scaffolder with opt-in plugins (`npm init @pwtap`); bundles the editable core template.
  - `@pwtap/plugin-ai-judge` — LLM-as-judge matchers (`toPassRubric`/`toScoreAtLeast`/`toMatchImage`) with prefix-routed multi-provider support (Ollama, OpenAI-compatible gateways, native Claude) and a `registerProvider` escape hatch.
