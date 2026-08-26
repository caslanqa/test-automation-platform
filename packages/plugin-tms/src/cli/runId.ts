/**
 * The run id, written once and read by everything downstream.
 *
 * `tms run create` writes `QASE_TESTOPS_RUN_ID=<id>` to a dotenv-shaped file — `qase.env` by default,
 * the same name and key `qasectl` uses, so an existing CI snippet keeps working. Every shard then
 * exports that variable and the vendor reporter picks it up without any further wiring.
 *
 * The file is appended to rather than replaced: a job may accumulate more than one key there, and
 * clobbering somebody else's line to save a read is the kind of shortcut that costs an afternoon.
 *
 * @example
 * writeRunId('qase.env', '1234');
 * readRunId('qase.env'); // '1234'
 */
import fs from 'node:fs';

export const RUN_ID_KEY = 'QASE_TESTOPS_RUN_ID';
export const DEFAULT_RUN_ID_FILE = 'qase.env';

export function writeRunId(file: string, id: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const kept = existing
    .split('\n')
    .filter(line => line.trim() !== '' && !line.startsWith(`${RUN_ID_KEY}=`))
    .join('\n');
  fs.writeFileSync(file, `${kept === '' ? '' : `${kept}\n`}${RUN_ID_KEY}=${id}\n`, 'utf8');
}

/** The id from the file, or `undefined` when the file is absent or carries no such key. */
export function readRunId(file: string): string | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith(`${RUN_ID_KEY}=`)) {
      const value = line.slice(RUN_ID_KEY.length + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
