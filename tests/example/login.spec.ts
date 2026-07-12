import { test, expect } from '@fixtures/globalFixtures';
import { authState, ensureSession } from '@fixtures/auth';
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

test.describe('Authenticated session', () => {
    // Reuse the 'adminUser' session — logged in lazily on first use, then cached to .auth/adminUser.json.
    test.use({ session: 'adminUser' });
    test('reaches a protected page without redirecting to login', async ({ page }) => {
        // baseURL is saucedemo.com; /inventory.html is gated — an unauthenticated visit bounces to
        // the login page ('/'). With the session applied we stay on the protected page.
        await page.goto('/inventory.html');
        await expect(page).toHaveURL(/\/inventory\.html/);
    });
});

test.describe('Two roles in one test', () => {
    test('admin and customer side by side', async ({ browser }) => {
        await ensureSession(browser, 'adminUser');
        await ensureSession(browser, 'customerUser');

        const adminCtx = await browser.newContext({ storageState: authState('adminUser') });
        const customerCtx = await browser.newContext({ storageState: authState('customerUser') });

        const adminPage = await adminCtx.newPage();
        const customerPage = await customerCtx.newPage();

        await adminPage.goto('/');
        await customerPage.goto('/');
        // ...drive adminPage and customerPage against each other...

        await adminCtx.close();
        await customerCtx.close();
    });
});
