import type { Locator, Page } from '@playwright/test';

import { BasePage } from './BasePage';

/**
 * Login page object — a basic POM. Selectors, the login URL, and the post-login URL below are wired
 * to the saucedemo.com example app (the scaffold's placeholder, set as BASE_URL in
 * env/environments.json). For your own app, point BASE_URL at it and swap the four selectors +
 * success URL here — the rest of the framework (lazy session auth, fixtures) stays the same.
 *
 * @example
 * const login = new LoginPage(page);
 * await login.signIn('standard_user', 'secret_sauce');
 */
export class LoginPage extends BasePage {
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    super(page, '/'); // saucedemo serves the login form at the site root
    this.usernameInput = page.locator('#user-name');
    this.passwordInput = page.locator('#password');
    this.loginButton = page.locator('#login-button');
    this.errorMessage = page.locator('[data-test="error"]');
  }

  /** Whether the login form is visible. */
  async isFormVisible(): Promise<boolean> {
    return this.usernameInput.isVisible();
  }

  /** Fill the credentials and submit (without waiting for navigation). */
  async login(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  /**
   * Navigate to the login page, sign in, and wait for the post-login page. This is the single entry
   * point the lazy auth flow (fixtures/auth.ts) calls to establish a session.
   */
  async signIn(username: string, password: string): Promise<void> {
    await this.goto();
    await this.login(username, password);
    await this.page.waitForURL(/\/inventory\.html/);
  }
}
