import { test, expect } from '@fixtures/globalFixtures';
import { authState, ensureSession } from '@fixtures/auth';
import { LoginPage } from '@pages/LoginPage';

test.describe('Login page', () => {
    test('renders the login form', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await loginPage.goto();

        await expect(page).toHaveURL(/login/);
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
    // Reuse the 'admin' session — logged in lazily on first use, then cached to .auth/admin.json.
    test.use({ session: 'admin' });
    test('reaches a protected page without redirecting to login', async ({ page }) => {
        await page.goto('/dashboard');
        await expect(page).not.toHaveURL(/login/);
    });
});

test.describe('Two roles in one test', () => {
    test('admin and customer side by side', async ({ browser }) => {
        await ensureSession(browser, 'admin');
        await ensureSession(browser, 'customer');

        const adminCtx = await browser.newContext({ storageState: authState('admin') });
        const customerCtx = await browser.newContext({ storageState: authState('customer') });

        const adminPage = await adminCtx.newPage();
        const customerPage = await customerCtx.newPage();

        await adminPage.goto('/');
        await customerPage.goto('/');
        // ...drive adminPage and customerPage against each other...

        await adminCtx.close();
        await customerCtx.close();
    });
});
