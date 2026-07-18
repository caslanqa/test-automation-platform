import { aiJudgeConfig } from '@config/aiJudge.config';
import { expectAi } from '@fixtures/aiExpect';
import { test } from '@fixtures/nativeFixtures';
import { getRegistry } from '@utils/ai/registry/providerRegistry';

test.describe('Native AI-judge — macOS', () => {
  test.use({ native: { app: 'textEdit' } });

  // Skip cleanly off-macOS, and when no vision-capable AI provider is configured (an Ollama vision
  // model, or an OpenAI key), so the suite stays green everywhere. `getRegistry` discovers available
  // models and degrades gracefully when a provider is down.
  test.beforeEach(async () => {
    test.skip(process.platform !== 'darwin', 'macOS-only native example (TextEdit)');
    const registry = await getRegistry(aiJudgeConfig);
    test.skip(
      !registry.models.some(model => model.supportsVision),
      'no vision-capable AI provider — start an Ollama vision model (JUDGE_OLLAMA_BASE_URL) or set OPENAI_API_KEY'
    );
  });

  // The unified-QA payoff: drive a native desktop app with Appium, then judge a screenshot of it with
  // the SAME multimodal AI judge used for web, mobile, and Electron (see docs/AI_JUDGE.md).
  test('the TextEdit window is judged against a rubric', async ({ app }) => {
    const shot = await app.takeScreenshot('textedit');
    await expectAi({
      image: shot,
      rubric:
        'A macOS TextEdit application — a text-editor window, or its open/new-document panel. A ' +
        'well-formed native app UI, not an error dialog or a blank screen.',
    }).toPassRubric({ minScore: 60 });
  });
});
