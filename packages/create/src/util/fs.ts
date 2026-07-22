import fs from 'node:fs';

/** Recursively copy a directory tree (Node 20's fs.cpSync). */
export function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function readText(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

export function writeText(p: string, content: string): void {
  fs.writeFileSync(p, content);
}

export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** True when `p` is absent or an empty directory (used to guard scaffolding into a fresh dir). */
export function isEmptyDir(p: string): boolean {
  return !fs.existsSync(p) || fs.readdirSync(p).length === 0;
}

/** Sort an object's keys (stable package.json output). */
export function sortObject<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))) as T;
}
