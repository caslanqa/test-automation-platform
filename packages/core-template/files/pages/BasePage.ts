import type { Locator, Page } from '@playwright/test';

/**
 * Base Page Object class with common functionality.
 * Extend this class for all page objects.
 *
 * @example
 * export class LoginPage extends BasePage {
 *   readonly usernameInput: Locator;
 *   readonly passwordInput: Locator;
 *
 *   constructor(page: Page) {
 *     super(page, '/login');
 *     this.usernameInput = page.getByPlaceholder('Email');
 *     this.passwordInput = page.getByPlaceholder('Password');
 *   }
 *
 *   async login(username: string, password: string) {
 *     await this.usernameInput.fill(username);
 *     await this.passwordInput.fill(password);
 *     await this.clickButton('Sign In');
 *   }
 * }
 */
export class BasePage {
  readonly page: Page;
  readonly pageUrl: string;

  constructor(page: Page, pageUrl: string = '/') {
    this.page = page;
    this.pageUrl = pageUrl;
  }

  /**
   * Navigate to the page URL
   */
  async goto(options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void> {
    await this.page.goto(this.pageUrl, options);
  }

  /**
   * Navigate to a custom path (relative to baseURL)
   */
  async navigateTo(path: string): Promise<void> {
    await this.page.goto(path);
  }

  /**
   * Wait for page to fully load
   */
  async waitForLoad(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load'): Promise<void> {
    await this.page.waitForLoadState(state);
  }

  /**
   * Get current URL
   */
  getCurrentUrl(): string {
    return this.page.url();
  }

  /**
   * Get page title
   */
  async getTitle(): Promise<string> {
    return await this.page.title();
  }

  /**
   * Click a button by its accessible name
   */
  async clickButton(name: string | RegExp): Promise<void> {
    await this.page.getByRole('button', { name }).click();
  }

  /**
   * Click a link by its accessible name
   */
  async clickLink(name: string | RegExp): Promise<void> {
    await this.page.getByRole('link', { name }).click();
  }

  /**
   * Fill a text field by label
   */
  async fillByLabel(label: string | RegExp, value: string): Promise<void> {
    await this.page.getByLabel(label).fill(value);
  }

  /**
   * Fill a text field by placeholder
   */
  async fillByPlaceholder(placeholder: string | RegExp, value: string): Promise<void> {
    await this.page.getByPlaceholder(placeholder).fill(value);
  }

  /**
   * Select an option from a dropdown by label
   */
  async selectByLabel(label: string | RegExp, value: string): Promise<void> {
    await this.page.getByLabel(label).selectOption(value);
  }

  /**
   * Check a checkbox by label
   */
  async checkByLabel(label: string | RegExp): Promise<void> {
    await this.page.getByLabel(label).check();
  }

  /**
   * Uncheck a checkbox by label
   */
  async uncheckByLabel(label: string | RegExp): Promise<void> {
    await this.page.getByLabel(label).uncheck();
  }

  /**
   * Get text content of an element
   */
  async getText(locator: Locator): Promise<string> {
    return (await locator.textContent()) ?? '';
  }

  /**
   * Get input value
   */
  async getValue(locator: Locator): Promise<string> {
    return await locator.inputValue();
  }

  /**
   * Check if element is visible
   */
  async isVisible(locator: Locator): Promise<boolean> {
    return await locator.isVisible();
  }

  /**
   * Check if element is enabled
   */
  async isEnabled(locator: Locator): Promise<boolean> {
    return await locator.isEnabled();
  }

  /**
   * Wait for element to be visible
   */
  async waitForVisible(locator: Locator, timeout?: number): Promise<void> {
    await locator.waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for element to be hidden
   */
  async waitForHidden(locator: Locator, timeout?: number): Promise<void> {
    await locator.waitFor({ state: 'hidden', timeout });
  }

  /**
   * Wait for URL to match pattern
   */
  async waitForUrl(url: string | RegExp, timeout?: number): Promise<void> {
    await this.page.waitForURL(url, { timeout });
  }

  /**
   * Take a screenshot
   */
  async screenshot(path: string): Promise<Buffer> {
    return await this.page.screenshot({ path, fullPage: true });
  }

  /**
   * Press keyboard key
   */
  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  /**
   * Scroll to bottom of page
   */
  async scrollToBottom(): Promise<void> {
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  }

  /**
   * Scroll to top of page
   */
  async scrollToTop(): Promise<void> {
    await this.page.evaluate(() => window.scrollTo(0, 0));
  }

  /**
   * Get element by test id
   */
  getByTestId(testId: string): Locator {
    return this.page.getByTestId(testId);
  }

  /**
   * Get element by role
   */
  getByRole(
    role: Parameters<Page['getByRole']>[0],
    options?: Parameters<Page['getByRole']>[1],
  ): Locator {
    return this.page.getByRole(role, options);
  }

  /**
   * Get element by text
   */
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.page.getByText(text, options);
  }

  /**
   * Locator shorthand
   */
  locator(selector: string): Locator {
    return this.page.locator(selector);
  }
}
