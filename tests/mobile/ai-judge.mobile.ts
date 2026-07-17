import { aiJudgeConfig } from '@config/aiJudge.config';
import { expectAi } from '@fixtures/aiExpect';
import { test } from '@fixtures/mobileFixtures';
import { devices } from '@mobile/devices';
import { getRegistry } from '@utils/ai/registry/providerRegistry';

test.describe('Mobile AI-judge — Android', () => {
  test.use({ mobile: devices.pixel9b });

  // Skip cleanly when no vision-capable AI provider is configured (an Ollama vision model, or an
  // OpenAI key), so the suite stays green on machines without one. `getRegistry` discovers the
  // available models and degrades gracefully when a provider is down.
  test.beforeEach(async () => {
    const registry = await getRegistry(aiJudgeConfig);
    test.skip(
      !registry.models.some(model => model.supportsVision),
      'no vision-capable AI provider — start an Ollama vision model (JUDGE_OLLAMA_BASE_URL) or set OPENAI_API_KEY'
    );
  });

  // The unified-QA payoff: drive a native screen with Maestro, then judge the SAME screenshot with
  // the multimodal AI judge — the identical rubric engine used for web (see docs/AI_JUDGE.md).
  test('the About screen is judged against a rubric', { tag: '@wip' }, async ({ maestro }) => {
    await maestro.launchApp('com.android.settings');

    // Emulators label it "About emulated device"; real phones say "About phone".
    const about = (await maestro.isVisible('About phone', { timeout: 1500 }))
      ? 'About phone'
      : 'About emulated device';
    await maestro.scrollUntilVisible(about);
    await maestro.tapOn(about);

    const shot = await maestro.takeScreenshot('about');
    await expectAi({
      image: shot,
      rubric:
        'An Android "About" settings screen showing device information — such as a Device name, ' +
        'Model, and Android version.',
    }).toPassRubric({ minScore: 70 });
  });
});
