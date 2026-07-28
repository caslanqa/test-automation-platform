/**
 * `@pwtap/mobile-inspector` — the recording application: the local service, the browser UI, the code
 * generator and the `mobile-inspect` CLI.
 *
 * This is a **development tool**. It is installed as a devDependency by the mobile plugins' manifests and
 * never appears in the runtime path of a test — which is the whole point of the split: the driver-neutral
 * contracts and the `mobileApp` fixture moved to `@pwtap/mobile-core`, so a project that never opens the
 * inspector no longer pays for Electron or a second copy of Prettier (ADR-008).
 *
 * The service and CLI are reached through the `mobile-inspect` binary rather than this entry point; the
 * programmatic host surface lands here when Phase 1's loopback service replaces the Electron shell.
 */

/**
 * @deprecated Import these from `@pwtap/mobile-core` instead. Re-exported here for one minor so existing
 * imports keep type-checking with a deprecation rather than failing outright; the runtime values (the
 * `test`/`expect` fixture, the locator helpers) are intentionally NOT re-exported, because a test that
 * loads them from the inspector is loading a dev tool at runtime.
 */
export type * from '@pwtap/mobile-core';
