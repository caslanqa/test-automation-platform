import { expectAi } from '@fixtures/aiExpect';
import { expect, test } from '@fixtures/globalFixtures';
import { judgeResponse } from '@utils/aiJudge';
import type { ChatJudgeCase } from '@utils/types';

test.describe.serial('aiJudge', () => {
  test.describe('AI Judge Examples', () => {
    test('basic response evaluation', async () => {
      const verdict = await judgeResponse({
        userMessage: 'What are your store hours?',
        botResponse: 'We are open Monday to Friday from 9am to 5pm, and Saturday from 10am to 2pm.',
        rubric: 'Response must include weekday hours and weekend hours.',
      });

      expect(verdict.pass, verdict.reasoning).toBeTruthy();
      expect(verdict.score).toBeGreaterThan(70);
    });

    test('response with missing information', async () => {
      const verdict = await judgeResponse({
        userMessage: 'What are your store hours?',
        botResponse: 'We are open during business hours.',
        rubric: 'Response must include specific opening and closing times.',
      });

      // This should fail because no specific times are given
      expect(verdict.pass).toBeFalsy();
      expect(verdict.score).toBeLessThan(50);
    });

    test('multimodal evaluation with screenshot', async ({ page }) => {
      // Navigate to a page with visual content
      await page.goto('https://example.com');

      // Take screenshot for visual evaluation
      const screenshot = await page.screenshot();

      const verdict = await judgeResponse({
        userMessage: 'Show me the example page',
        botResponse: '', // Image-only evaluation
        rubric: 'The page should display "Example Domain" as the main heading.',
        image: screenshot,
      });

      expect(verdict.pass, verdict.reasoning).toBeTruthy();
    });

    test('automatic routing with verbose trace', async () => {
      const verdict = await judgeResponse({
        userMessage: 'Explain quantum computing',
        botResponse:
          'Quantum computing uses quantum bits (qubits) that can exist in multiple states simultaneously through superposition.',
        rubric: 'Must mention qubits and superposition.',
        // No model/tier: the judge picks a tier from complexity and a concrete model from the
        // installed Ollama models. `verbose` attaches the routing trace for debugging.
        verbose: true,
      });

      expect(verdict.pass, verdict.reasoning).toBeTruthy();
      console.log(
        `[routing] tier=${verdict._meta?.tier} model=${verdict._meta?.selectedModel} ` +
          `score=${verdict._meta?.score} reasons=[${verdict._meta?.reasons.join('; ')}]`
      );
    });

    test('manual tier override', async () => {
      const verdict = await judgeResponse({
        userMessage: 'What time do you open?',
        botResponse: 'We open at 9am every day.',
        rubric: 'Must state the store opens at 9am.',
        // Force a tier explicitly; resolved to a concrete model via config/dynamic assignment.
        tier: 'simple',
      });

      expect(verdict.pass, verdict.reasoning).toBeTruthy();
    });
  });

  test.describe('Table-Driven AI Judge Tests', () => {
    const testCases: ChatJudgeCase[] = [
      {
        name: 'greeting response',
        userMessage: '',
        rubric: 'Bot should provide a friendly greeting.',
        expectPass: true,
      },
      {
        name: 'product inquiry - valid',
        userMessage: 'Do you sell laptops?',
        rubric: 'Response should confirm or deny laptop availability.',
        expectPass: true,
      },
      {
        name: 'return policy',
        userMessage: 'What is your return policy?',
        rubric: 'Must mention return window (number of days) and conditions.',
        expectPass: true,
      },
    ];

    // Mock bot responses for demonstration
    const mockResponses: Record<string, string> = {
      'greeting response': 'Hello! Welcome to our store. How can I help you today?',
      'product inquiry - valid': 'Yes, we carry a wide selection of laptops from various brands.',
      'return policy':
        'You can return items within 30 days of purchase with receipt. Items must be unused.',
    };

    for (const c of testCases) {
      test(c.name, async () => {
        const botResponse = mockResponses[c.name] || 'I apologize, I cannot help with that.';

        const verdict = await judgeResponse({
          userMessage: c.userMessage,
          botResponse,
          rubric: c.rubric,
        });

        if (c.expectPass !== false) {
          expect(verdict.pass, `Failed: ${verdict.reasoning}`).toBeTruthy();
        } else {
          expect(verdict.pass, `Expected failure but passed: ${verdict.reasoning}`).toBeFalsy();
        }
      });
    }
  });

  test.describe('Score Threshold Tests', () => {
    test('high quality response scores above 80', async () => {
      const verdict = await judgeResponse({
        userMessage: 'How do I reset my password?',
        botResponse: `To reset your password:
1. Go to the login page
2. Click "Forgot Password"
3. Enter your email address
4. Check your email for the reset link
5. Click the link and create a new password

The link expires in 24 hours. Contact support if you need help.`,
        rubric: 'Must provide clear step-by-step instructions for password reset.',
      });

      expect(verdict.pass).toBeTruthy();
      expect(verdict.score).toBeGreaterThan(80);
    });

    test('minimal response scores below 60', async () => {
      const verdict = await judgeResponse({
        userMessage: 'How do I reset my password?',
        botResponse: 'Click forgot password.',
        rubric: 'Must provide clear step-by-step instructions for password reset.',
      });

      // Minimal response should score lower
      expect(verdict.score).toBeLessThan(60);
    });
  });

  // Baseline images shipped for the compare-mode examples (see tests/example/assets/).
  const BADGE_SAVED = 'tests/example/assets/badge-saved.png';
  const BADGE_ERROR = 'tests/example/assets/badge-error.png';

  test.describe('expectAi Custom Matchers', () => {
    // toPassRubric — the everyday assertion. Judges the input inline; on failure the message
    // carries the judge's own reasoning.
    test('toPassRubric — passes a good response', async () => {
      await expectAi({
        userMessage: 'What are your store hours?',
        botResponse: 'We are open Monday to Friday, 9am to 5pm.',
        rubric: 'Response must state weekday operating hours.',
      }).toPassRubric();
    });

    // toPassRubric with a minimum score threshold.
    test('toPassRubric — with a minimum score', async () => {
      await expectAi({
        userMessage: 'How do I reset my password?',
        botResponse: 'Open Settings → Security → Reset password, then follow the emailed link.',
        rubric: 'Must give clear password-reset steps.',
      }).toPassRubric({ minScore: 60 });
    });

    // .not — assert a response should FAIL the rubric (negative cases).
    test('not.toPassRubric — flags a rubric miss', async () => {
      await expectAi({
        userMessage: 'What are your store hours?',
        botResponse: 'We are open during business hours.',
        rubric: 'Response must include specific opening and closing times.',
      }).not.toPassRubric();
    });

    test('toScoreAtLeast — on a reused verdict', async () => {
      const verdict = await judgeResponse({
        userMessage: 'How do I reset my password?',
        botResponse:
          'Go to the login page, click "Forgot Password", enter your email, and follow the reset link.',
        rubric: 'Must give step-by-step password reset instructions.',
      });

      await expectAi(verdict).not.toPassRubric();
    });

    test('override tier per assertion', async () => {
      await expectAi({
        userMessage: 'Explain quantum computing',
        botResponse: 'It uses qubits in superposition to represent multiple states at once.',
        rubric: 'Must mention qubits and superposition.',
      }).toPassRubric({ tier: 'simple' });
    });

    // toMatchImage — compare mode: check an image against a baseline instead of a text rubric.
    // In real use `image` is your live `await page.screenshot()`. Visual comparison is demanding,
    // so force a stronger model for reliability.
    test('toMatchImage — matches a baseline image', async () => {
      await expectAi({ image: BADGE_SAVED }).toMatchImage(BADGE_SAVED, { tier: 'complex' });
    });

    test('not.toMatchImage — flags a different image', async () => {
      await expectAi({ image: BADGE_SAVED }).not.toMatchImage(BADGE_ERROR, { tier: 'complex' });
    });
  });
});
