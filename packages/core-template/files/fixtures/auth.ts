import fs from 'fs';
import path from 'path';

import type { Browser, Page } from '@playwright/test';

import { LoginPage } from '@pages/LoginPage';

/** Directory where per-session storage-state files are cached. */
export const AUTH_DIR = '.auth';

/** A single login session's credentials, as declared in testData/users.json. */
export interface UserCredentials {
  username: string;
  password: string;
}

/** Resolve a session key (e.g. `'admin'`) to its storage-state file path (`.auth/admin.json`). */
export function authState(key: string): string {
  return path.join(AUTH_DIR, `${key}.json`);
}

/**
 * Read the named login sessions from testData/users.json (gitignored). Returns `{}` when the file
 * is absent, so a fresh scaffold with no users configured simply has no sessions.
 */
export function readUsers(): Record<string, UserCredentials> {
  const file = path.join(process.cwd(), 'testData', 'users.json');
  if (!fs.existsSync(file)) {
    return {};
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    users?: Record<string, UserCredentials>;
  };

  return parsed.users ?? {};
}

/** A storage-state file counts as valid once it actually carries cookies or localStorage. */
function isValidState(file: string): boolean {
  if (!fs.existsSync(file)) {
    return false;
  }
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      cookies?: unknown[];
      origins?: Array<{ localStorage?: unknown[] }>;
    };
    return (state.cookies?.length ?? 0) > 0 || (state.origins?.[0]?.localStorage?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `fn` under a cross-process lock keyed by `file` (atomic mkdir). Only one worker performs the
 * login; the others wait for the resulting file to appear and reuse it — so a session is created
 * exactly once even under parallel workers.
 */
async function withLock(file: string, fn: () => Promise<void>): Promise<void> {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  const lockDir = `${file}.lock`;

  let acquired = false;
  try {
    fs.mkdirSync(lockDir);
    acquired = true;
  } catch {
    acquired = false;
  }

  if (acquired) {
    try {
      await fn();
    } finally {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // already removed
      }
    }
    return;
  }

  // Another worker holds the lock — wait for it to produce the file.
  const maxWaitMs = 60_000;
  const intervalMs = 300;
  for (let waited = 0; waited < maxWaitMs; waited += intervalMs) {
    if (!fs.existsSync(lockDir) && isValidState(file)) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`[auth] timed out waiting for another worker to create session file: ${file}`);
}

/** The minimal contract the auth flow needs from a login page object. */
export interface SessionLogin {
  /** Navigate to the login page, authenticate, and wait until signed in. */
  signIn(username: string, password: string): Promise<void>;
}

/** Maps a session key to the login page object that authenticates it. */
export type CreateLoginPage = (page: Page, key: string) => SessionLogin;

/**
 * Default factory: every session logs in through the one LoginPage. Override the `createLoginPage`
 * fixture only if different sessions need different login page objects.
 */
export const defaultCreateLoginPage: CreateLoginPage = page => new LoginPage(page);

/**
 * Ensure `.auth/<key>.json` exists: reuse it if already cached, otherwise log in once (worker-safe)
 * and save it. Credentials come from testData/users.json; the login page object is built by
 * `createLoginPage` (the fixture-provided factory). Called lazily by the `session` fixture, and
 * directly for multi-role tests that open their own contexts.
 */
export async function ensureSession(
  browser: Browser,
  key: string,
  createLoginPage: CreateLoginPage = defaultCreateLoginPage,
): Promise<void> {
  const file = authState(key);
  if (isValidState(file)) {
    return;
  }

  await withLock(file, async () => {
    if (isValidState(file)) {
      return; // produced by another worker while we waited for the lock
    }
    const creds = readUsers()[key];
    if (creds === undefined) {
      throw new Error(
        `[auth] no credentials for session '${key}' — add it to testData/users.json.`,
      );
    }
    const context = await browser.newContext({ baseURL: process.env.BASE_URL });
    try {
      const page = await context.newPage();
      await createLoginPage(page, key).signIn(creds.username, creds.password);
      await context.storageState({ path: file });
    } finally {
      await context.close();
    }
  });
}
