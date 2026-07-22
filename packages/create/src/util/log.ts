/* Minimal console logger for the scaffolder. */
export const log = {
  info: (msg: string): void => console.info(msg),
  warn: (msg: string): void => console.warn(`⚠ ${msg}`),
  error: (msg: string): void => console.error(`✖ ${msg}`),
  step: (msg: string): void => console.info(`\n▸ ${msg}`),
  done: (msg: string): void => console.info(`✓ ${msg}`),
};
