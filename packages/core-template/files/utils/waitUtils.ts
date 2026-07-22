import type { Locator, Page } from '@playwright/test';

/**
 * Wait and Retry Utility Functions
 * Provides wait helpers and retry logic
 */

export class WaitUtils {
  /**
   * Wait for specific amount of time
   */
  static async wait(milliseconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  /**
   * Wait for condition to be true
   */
  static async waitForCondition(
    condition: () => boolean | Promise<boolean>,
    options?: {
      timeout?: number;
      interval?: number;
      errorMessage?: string;
    },
  ): Promise<void> {
    const timeout = options?.timeout || 30000;
    const interval = options?.interval || 500;
    const errorMessage = options?.errorMessage || 'Condition not met within timeout';
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await condition()) {
        return;
      }
      await this.wait(interval);
    }

    throw new Error(errorMessage);
  }

  /**
   * Wait for element count to match expected value
   */
  static async waitForElementCount(
    elements: Locator,
    expectedCount: number,
    timeout: number = 30000,
  ): Promise<void> {
    await this.waitForCondition(async () => (await elements.count()) === expectedCount, {
      timeout,
      errorMessage: `Expected ${expectedCount} elements, but got different count`,
    });
  }

  /**
   * Wait for text to appear in element
   */
  static async waitForText(element: Locator, text: string, timeout: number = 30000): Promise<void> {
    await element.waitFor({ state: 'visible', timeout });
    await this.waitForCondition(
      async () => {
        const content = await element.textContent();
        return content?.includes(text) || false;
      },
      { timeout, errorMessage: `Text "${text}" did not appear in element` },
    );
  }

  /**
   * Wait for text to disappear from element
   */
  static async waitForTextToDisappear(
    element: Locator,
    text: string,
    timeout: number = 30000,
  ): Promise<void> {
    await this.waitForCondition(
      async () => {
        const content = await element.textContent();
        return !content?.includes(text);
      },
      { timeout, errorMessage: `Text "${text}" did not disappear from element` },
    );
  }

  /**
   * Wait for URL to match pattern
   */
  static async waitForURL(
    page: Page,
    urlPattern: string | RegExp,
    timeout: number = 30000,
  ): Promise<void> {
    await page.waitForURL(urlPattern, { timeout });
  }

  /**
   * Wait for URL to contain text
   */
  static async waitForURLContains(
    page: Page,
    text: string,
    timeout: number = 30000,
  ): Promise<void> {
    await this.waitForCondition(() => page.url().includes(text), {
      timeout,
      errorMessage: `URL does not contain "${text}"`,
    });
  }

  /**
   * Wait for page to be fully loaded
   */
  static async waitForPageLoad(
    page: Page,
    state: 'load' | 'domcontentloaded' | 'networkidle' = 'load',
    timeout: number = 30000,
  ): Promise<void> {
    await page.waitForLoadState(state, { timeout });
  }

  /**
   * Wait for navigation to complete
   */
  static async waitForNavigation(
    page: Page,
    action: () => Promise<void>,
    timeout: number = 30000,
  ): Promise<void> {
    await Promise.all([page.waitForNavigation({ timeout }), action()]);
  }

  /**
   * Wait for selector with custom timeout
   */
  static async waitForSelector(
    page: Page,
    selector: string,
    options?: {
      timeout?: number;
      state?: 'attached' | 'detached' | 'visible' | 'hidden';
    },
  ): Promise<void> {
    await page.locator(selector).waitFor({
      timeout: options?.timeout || 30000,
      state: options?.state || 'visible',
    });
  }

  /**
   * Retry function with exponential backoff
   */
  static async retry<T>(
    fn: () => Promise<T>,
    options?: {
      maxRetries?: number;
      initialDelay?: number;
      maxDelay?: number;
      factor?: number;
    },
  ): Promise<T> {
    const { maxRetries = 3, initialDelay = 1000, maxDelay = 10000, factor = 2 } = options || {};

    let lastError: Error;
    let delay = initialDelay;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          await this.wait(Math.min(delay, maxDelay));
          delay *= factor;
        }
      }
    }

    throw lastError!;
  }

  /**
   * Poll until condition is met or timeout
   */
  static async poll<T>(
    fn: () => Promise<T | null | undefined>,
    options?: {
      timeout?: number;
      interval?: number;
    },
  ): Promise<T> {
    const timeout = options?.timeout || 30000;
    const interval = options?.interval || 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = await fn();
      if (result !== null && result !== undefined) {
        return result;
      }
      await this.wait(interval);
    }

    throw new Error('Polling timed out');
  }
}
