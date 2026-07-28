/**
 * The wire contract, re-exported from its single definition.
 *
 * This file used to be a hand-maintained *copy* of `src/service/protocol.ts`, kept in sync by hand. That
 * drifted exactly as you would expect: when the service stopped putting image bytes inside a `frame` event,
 * the UI kept compiling against its own stale copy and `typecheck:ui` said nothing — the mismatch would only
 * have surfaced as a blank device panel at runtime.
 *
 * Importing the real module is safe in a browser bundle: everything it pulls from `@pwtap/mobile-core` and
 * `@pwtap/platform` is `import type`, which esbuild erases, and the one runtime export
 * (`parseClientMessage`) is dependency-free.
 */
export * from '../../src/service/protocol';

/**
 * The domain types the messages are built from — the action IR, locators, nodes, devices. The old copy
 * declared its own versions of these; they belong to `@pwtap/mobile-core`, and `export type` keeps them
 * type-only so no runtime code (least of all the test fixture) can be pulled into the browser bundle.
 */
export type * from '@pwtap/mobile-core';
