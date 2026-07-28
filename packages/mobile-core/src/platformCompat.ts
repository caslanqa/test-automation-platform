/**
 * Compatibility bridge for `@pwtap/platform` runtime exports.
 *
 * `mobile-inspector` depends on platform functions that were added after early `@pwtap/platform`
 * releases. Importing those as named ESM exports would hard-crash module loading when an older
 * platform version is installed in a client project (`SyntaxError: ... does not provide an export`).
 *
 * We import the module namespace and validate required function exports explicitly so we can surface
 * a clear upgrade error instead of crashing before app startup.
 */
import * as platform from '@pwtap/platform';

type PlatformModule = typeof import('@pwtap/platform');

function requirePlatformFn<K extends keyof PlatformModule>(
  name: K,
): Exclude<PlatformModule[K], undefined> {
  const fn = platform[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `[mobile-inspector] incompatible @pwtap/platform: missing "${String(name)}". ` +
        'Please upgrade @pwtap/platform to a version that includes mobile-inspector support.',
    );
  }
  return fn as Exclude<PlatformModule[K], undefined>;
}

export const listAvds = requirePlatformFn('listAvds') as PlatformModule['listAvds'];
export const listBootedAndroidDevices = requirePlatformFn(
  'listBootedAndroidDevices',
) as PlatformModule['listBootedAndroidDevices'];
export const listInstalledAndroidApps = requirePlatformFn(
  'listInstalledAndroidApps',
) as PlatformModule['listInstalledAndroidApps'];
export const listInstalledIosApps = requirePlatformFn(
  'listInstalledIosApps',
) as PlatformModule['listInstalledIosApps'];
export const listIosSimulators = requirePlatformFn(
  'listIosSimulators',
) as PlatformModule['listIosSimulators'];
export const resolveSimUdid = requirePlatformFn(
  'resolveSimUdid',
) as PlatformModule['resolveSimUdid'];
