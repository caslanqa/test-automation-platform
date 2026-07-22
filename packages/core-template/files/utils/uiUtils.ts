import type { Locator, Page } from '@playwright/test';

/**
 * UI Utility Functions for Playwright Tests
 * Provides common UI interaction helpers
 */

export class UIUtils {
  /**
   * Scroll to element and make it visible
   */
  static async scrollToElement(element: Locator): Promise<void> {
    await element.scrollIntoViewIfNeeded();
  }

  static async clickButton(page: Page, button: string): Promise<void> {
    await page.getByRole('button', { name: button }).first().click();
  }

  /**
   * Click element with retry logic
   */
  static async clickWithRetry(
    element: Locator,
    maxRetries: number = 3,
    delay: number = 1000,
  ): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await element.click({ timeout: 5000 });
        return;
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Force click on element (useful for hidden or overlapped elements)
   */
  static async forceClick(element: Locator): Promise<void> {
    await element.click({ force: true });
  }

  /**
   * Double click on element
   */
  static async doubleClick(element: Locator): Promise<void> {
    await element.dblclick();
  }

  /**
   * Right click on element
   */
  static async rightClick(element: Locator): Promise<void> {
    await element.click({ button: 'right' });
  }

  /**
   * Hover over element
   */
  static async hover(element: Locator): Promise<void> {
    await element.hover();
  }

  /**
   * Fill input with clearing first
   */
  static async fillInput(element: Locator, text: string): Promise<void> {
    await element.clear();
    await element.fill(text);
  }

  /**
   * Type text slowly (character by character)
   */
  static async typeSlowly(element: Locator, text: string, delay: number = 100): Promise<void> {
    await element.click();
    await element.pressSequentially(text, { delay });
  }

  /**
   * Select option from dropdown by value
   */
  static async selectDropdownByValue(element: Locator, value: string): Promise<void> {
    await element.selectOption({ value });
  }

  /**
   * Select option from dropdown by label
   */
  static async selectDropdownByLabel(element: Locator, label: string): Promise<void> {
    await element.selectOption({ label });
  }

  /**
   * Select option from dropdown by index
   */
  static async selectDropdownByIndex(element: Locator, index: number): Promise<void> {
    await element.selectOption({ index });
  }

  /**
   * Check checkbox
   */
  static async checkCheckbox(element: Locator): Promise<void> {
    await element.check();
  }

  /**
   * Uncheck checkbox
   */
  static async uncheckCheckbox(element: Locator): Promise<void> {
    await element.uncheck();
  }

  /**
   * Toggle checkbox
   */
  static async toggleCheckbox(element: Locator): Promise<void> {
    const isChecked = await element.isChecked();
    if (isChecked) {
      await element.uncheck();
    } else {
      await element.check();
    }
  }

  /**
   * Get element text content
   */
  static async getText(element: Locator): Promise<string> {
    return (await element.textContent()) || '';
  }

  /**
   * Get element input value
   */
  static async getValue(element: Locator): Promise<string> {
    return await element.inputValue();
  }

  /**
   * Check if element is visible
   */
  static async isVisible(element: Locator): Promise<boolean> {
    return await element.isVisible();
  }

  /**
   * Check if element is enabled
   */
  static async isEnabled(element: Locator): Promise<boolean> {
    return await element.isEnabled();
  }

  /**
   * Check if element exists in DOM
   */
  static async exists(element: Locator): Promise<boolean> {
    return (await element.count()) > 0;
  }

  /**
   * Upload file to input
   */
  static async uploadFile(element: Locator, filePath: string | string[]): Promise<void> {
    await element.setInputFiles(filePath);
  }

  /**
   * Clear file input
   */
  static async clearFileInput(element: Locator): Promise<void> {
    await element.setInputFiles([]);
  }

  /**
   * Get attribute value
   */
  static async getAttribute(element: Locator, name: string): Promise<string | null> {
    return await element.getAttribute(name);
  }

  /**
   * Focus element
   */
  static async focus(element: Locator): Promise<void> {
    await element.focus();
  }

  /**
   * Blur element
   */
  static async blur(element: Locator): Promise<void> {
    await element.blur();
  }

  /**
   * Press keyboard key on element
   */
  static async pressKey(element: Locator, key: string): Promise<void> {
    await element.press(key);
  }

  /**
   * Drag and drop element
   */
  static async dragAndDrop(source: Locator, target: Locator): Promise<void> {
    await source.dragTo(target);
  }

  /**
   * Take screenshot of element
   */
  static async screenshot(element: Locator, path: string): Promise<Buffer> {
    return await element.screenshot({ path });
  }

  /**
   * Wait for element animation to complete
   */
  static async waitForAnimation(element: Locator, timeout: number = 1000): Promise<void> {
    await element.evaluate((el, t) => {
      return new Promise<void>(resolve => {
        const animations = el.getAnimations();
        if (animations.length === 0) {
          setTimeout(resolve, t);
        } else {
          Promise.all(animations.map(a => a.finished)).then(() => resolve());
        }
      });
    }, timeout);
  }
}
