import { loadEnv } from './loadEnv';

// Load the selected environment (TEST_ENV, default from environments.json)
// before any getEnv call. Centralized so every consumer switches envs via one variable.
loadEnv();

/**
 * Get environment variable value with optional default
 * Removes surrounding quotes if present
 * @param key - The environment variable key
 * @param defaultValue - Optional default value if key is not found
 * @returns The environment variable value or default value
 * @throws Error if key is not found and no default value is provided
 */
export const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key];

  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable "${key}" is not defined`);
  }

  // Remove surrounding quotes (both single and double) if present
  // This handles cases where .env values are quoted
  return value.replace(/^["']|["']$/g, '');
};

/**
 * Get environment variable as a number
 * @param key - The environment variable key
 * @param defaultValue - Optional default value
 * @returns The environment variable value as a number
 */
export const getEnvNumber = (key: string, defaultValue?: number): number => {
  const value = getEnv(key, defaultValue?.toString());
  const num = Number(value);

  if (isNaN(num)) {
    throw new Error(`Environment variable "${key}" must be a valid number, got "${value}"`);
  }

  return num;
};

/**
 * Get environment variable as a boolean
 * @param key - The environment variable key
 * @param defaultValue - Optional default value
 * @returns The environment variable value as a boolean
 */
export const getEnvBoolean = (key: string, defaultValue?: boolean): boolean => {
  const value = getEnv(key, defaultValue?.toString());
  return value.toLowerCase() === 'true' || value === '1' || value === 'yes';
};

/**
 * Check if environment variable exists
 * @param key - The environment variable key
 * @returns true if the environment variable exists, false otherwise
 */
export const hasEnv = (key: string): boolean => process.env[key] !== undefined;

/**
 * Get all environment variables as an object
 * @returns An object containing all environment variables
 */
export const getAllEnv = (): Record<string, string> =>
  ({ ...process.env }) as Record<string, string>;
