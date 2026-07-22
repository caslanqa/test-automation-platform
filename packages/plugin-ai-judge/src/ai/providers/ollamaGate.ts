import fs from 'fs';
import path from 'path';

// Cross-process gate so parallel Playwright workers don't make one Ollama server load several large
// models at once (which thrashes memory → hangs and degraded vision results). The lock is held for
// the whole judge call, so other workers WAIT; before running, any resident model other than the
// requested one is unloaded, and an already-resident model is reused with no reload.

const GATE_DIR = path.join(process.cwd(), '.judge');
const LOCK_DIR = path.join(GATE_DIR, 'ollama-model.lock');
const LOCK_POLL_MS = 200;
const LOCK_MAX_WAIT_MS = 10 * 60 * 1000; // serialized judge calls can queue for a while
const LOCK_STALE_MS = 5 * 60 * 1000; // steal a lock left behind by a crashed worker

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Names of the models Ollama currently has resident (via /api/ps). */
async function loadedModels(apiBase: string): Promise<string[]> {
  try {
    const res = await fetch(`${apiBase}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (data.models ?? []).map(m => m.name ?? m.model ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

/** Ask Ollama to unload a resident model (keep_alive: 0), freeing memory before loading another. */
async function unloadModel(apiBase: string, model: string): Promise<void> {
  try {
    await fetch(`${apiBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    // Best-effort — if it fails, loading the next model will still evict under memory pressure.
  }
}

/** Acquire the cross-process lock (atomic mkdir), stealing a stale one left by a dead worker. */
async function acquireLock(): Promise<void> {
  fs.mkdirSync(GATE_DIR, { recursive: true });
  let waited = 0;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch {
      try {
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(LOCK_DIR);
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      if (waited >= LOCK_MAX_WAIT_MS) {
        throw new Error('[ai-judge] timed out waiting for the Ollama model gate');
      }
      await sleep(LOCK_POLL_MS);
      waited += LOCK_POLL_MS;
    }
  }
}

function releaseLock(): void {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    // already released
  }
}

/**
 * Run an Ollama judge call under the single-model gate: serialize across workers, unload any other
 * resident model first, and reuse the requested model if it is already loaded.
 */
export async function withModelGate<T>(
  model: string,
  apiBase: string,
  run: () => Promise<T>,
): Promise<T> {
  await acquireLock();
  try {
    for (const loaded of await loadedModels(apiBase)) {
      if (loaded !== model) {
        await unloadModel(apiBase, loaded);
      }
    }
    return await run();
  } finally {
    releaseLock();
  }
}
