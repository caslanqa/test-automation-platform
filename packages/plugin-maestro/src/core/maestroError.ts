/**
 * Build an Error whose Playwright report shows JUST the message — no code frame pointing at our
 * internal `throw`. Playwright renders an error's `stack` as a code snippet; by overwriting it with
 * the message alone, a failed Maestro step shows only the step name + the real reason, which is the
 * meaningful signal for a mobile test author (our fixture's throw site is noise). Shared by the batch
 * (`maestro.run(flow)`) and imperative (`maestro.tapOn(...)`) paths so failures read the same way.
 */
export function maestroError(message: string): Error {
  const error = new Error(message);
  error.stack = message;
  return error;
}
