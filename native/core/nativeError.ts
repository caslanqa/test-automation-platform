/**
 * Build an Error whose Playwright report shows JUST the message — no code frame pointing at our
 * internal `throw`. Playwright renders an error's `stack` as a code snippet; overwriting it with the
 * message alone keeps a failed native assertion showing only the real reason (our fixture's throw site
 * is noise), matching how the mobile engine surfaces failures (see mobile/core/maestroError.ts).
 */
export function nativeError(message: string): Error {
  const error = new Error(message);
  error.stack = message;
  return error;
}
