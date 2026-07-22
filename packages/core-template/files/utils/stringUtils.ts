/**
 * String Utility Functions
 * Provides string manipulation and formatting helpers
 */

export class StringUtils {
  /**
   * Generate random string
   */
  static generateRandomString(length: number = 10): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  /**
   * Generate random alphanumeric string
   */
  static generateRandomAlphanumeric(length: number = 10): string {
    return this.generateRandomString(length);
  }

  /**
   * Generate random numeric string
   */
  static generateRandomNumeric(length: number = 10): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += Math.floor(Math.random() * 10);
    }
    return result;
  }

  /**
   * Generate random email
   */
  static generateRandomEmail(domain: string = 'example.com'): string {
    const username = this.generateRandomString(10).toLowerCase();
    return `${username}@${domain}`;
  }

  /**
   * Generate a timestamp-based email, unique per run.
   *
   * @param prefix - Username prefix (default: 'test_user')
   * @param domain - Email domain (default: 'example.com')
   * @param digits - Number of trailing timestamp digits to append (default: 4)
   * @returns Email like "test_user_5821@example.com"
   */
  static generateTimestampEmail(
    prefix: string = 'test_user',
    domain: string = 'example.com',
    digits: number = 4,
  ): string {
    const timestamp = Date.now().toString();
    const suffix = timestamp.slice(-digits);
    return `${prefix}_${suffix}@${domain}`;
  }

  /**
   * Generate random phone number
   * @param countryCode - Country code (default: '+1')
   * @param prefix - Phone number prefix (default: '555')
   * @param length - Number of random digits after prefix (default: 7)
   * @returns Phone number in format like "+1 5551234567"
   */
  static generateRandomPhoneNumber(
    countryCode: string = '+1',
    prefix: string = '555',
    length: number = 7,
  ): string {
    const randomDigits = this.generateRandomNumeric(length);
    return `${countryCode} ${prefix}${randomDigits}`;
  }

  /**
   * Generate UUID v4
   */
  static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Capitalize first letter
   */
  static capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Convert to title case
   */
  static toTitleCase(str: string): string {
    return str
      .toLowerCase()
      .split(' ')
      .map(word => this.capitalize(word))
      .join(' ');
  }

  /**
   * Convert to camelCase
   */
  static toCamelCase(str: string): string {
    return str
      .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
        index === 0 ? word.toLowerCase() : word.toUpperCase(),
      )
      .replace(/\s+/g, '');
  }

  /**
   * Convert to snake_case
   */
  static toSnakeCase(str: string): string {
    return str
      .replace(/\W+/g, ' ')
      .split(/ |\B(?=[A-Z])/)
      .map(word => word.toLowerCase())
      .join('_');
  }

  /**
   * Convert to kebab-case
   */
  static toKebabCase(str: string): string {
    return str
      .replace(/\W+/g, ' ')
      .split(/ |\B(?=[A-Z])/)
      .map(word => word.toLowerCase())
      .join('-');
  }

  /**
   * Truncate string to specified length
   */
  static truncate(str: string, length: number, suffix: string = '...'): string {
    if (str.length <= length) return str;
    return str.slice(0, length - suffix.length) + suffix;
  }

  /**
   * Check if string is empty or whitespace
   */
  static isBlank(str: string | null | undefined): boolean {
    return !str || str.trim().length === 0;
  }

  /**
   * Remove extra whitespace
   */
  static normalizeWhitespace(str: string): string {
    return str.trim().replace(/\s+/g, ' ');
  }

  /**
   * Escape HTML special characters
   */
  static escapeHtml(str: string): string {
    const htmlEntities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return str.replace(/[&<>"']/g, char => htmlEntities[char]);
  }

  /**
   * Extract numbers from string
   */
  static extractNumbers(str: string): string {
    return str.replace(/\D/g, '');
  }

  /**
   * Mask string (e.g., for sensitive data)
   */
  static mask(str: string, visibleChars: number = 4, maskChar: string = '*'): string {
    if (str.length <= visibleChars) return str;
    const masked = maskChar.repeat(str.length - visibleChars);
    return masked + str.slice(-visibleChars);
  }
}
