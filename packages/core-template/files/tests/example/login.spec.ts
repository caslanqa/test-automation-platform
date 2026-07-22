import { expect, test } from '@fixtures';
import { LoginPage } from '@pages/LoginPage';

test.describe('Login page', () => {
  test('renders the login form', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    expect(await loginPage.isFormVisible()).toBeTruthy();
  });

  test('shows an error for invalid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    await loginPage.login('invalid@example.com', 'wrongpassword');
    await expect(loginPage.errorMessage).toBeVisible();
  });
});

// Suite-level auth: `test.use({ session })` at describe scope logs in once (lazily) and applies the
// cached storageState to every test in this group.
test.describe('Suite-level auth', () => {
  test.use({ session: 'adminUser' });

  test('reaches a protected page without redirecting to login', async ({ page }) => {
    // baseURL is saucedemo.com; /inventory.html is gated — unauthenticated visits bounce to '/'.
    await page.goto('/inventory.html');
    await expect(page).toHaveURL(/\/inventory\.html/);
  });
});

// Test-level auth: `test.as(session)` authenticates a single test. Different tests can use different
// sessions in the same describe, and the declaration modifiers (.skip/.only/.fixme/.fail) work too.
test.describe('Test-level auth (test.as)', () => {
  test.as('adminUser')('admin reaches the inventory', async ({ page }) => {
    await page.goto('/inventory.html');
    await expect(page).toHaveURL(/\/inventory\.html/);
  });

  test.as('customerUser')('customer reaches the inventory', async ({ page }) => {
    await page.goto('/inventory.html');
    await expect(page).toHaveURL(/\/inventory\.html/);
  });

  test.as('adminUser').fixme('admin flow pending a fix', async ({ page }) => {
    await page.goto('/inventory.html');
    await expect(page).toHaveURL(/\/broken/);
  });
});
