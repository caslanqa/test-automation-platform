/**
 * Curated, pre-install plugin registry. Ships inside @pwtap/create so the interactive menu can be
 * built BEFORE any plugin is installed. The authoritative injection metadata travels with each
 * plugin (see PluginManifest); this only drives menu rendering and `--flag` resolution.
 *
 * @example
 * const chosen = KNOWN_PLUGINS.filter(p => selectedIds.includes(p.id)).map(p => p.package);
 */
export interface KnownPlugin {
  /** Stable slug — used for dirs, markers, and the Playwright project name. */
  id: string;
  /** npm package to install (e.g. '@pwtap/plugin-maestro'). */
  package: string;
  /** Menu grouping label. */
  category: string;
  /** One-line menu description. */
  description: string;
  /** Non-interactive selection flag (e.g. '--maestro'). */
  flag: string;
  defaultSelected: boolean;
  status?: 'stable' | 'coming-soon';
}

export const KNOWN_PLUGINS: KnownPlugin[] = [
  {
    id: 'maestro',
    package: '@pwtap/plugin-maestro',
    category: 'mobile',
    description: 'Mobile testing with Maestro flows (Android + iOS)',
    flag: '--maestro',
    defaultSelected: false,
    status: 'stable',
  },
  {
    id: 'appium',
    package: '@pwtap/plugin-appium',
    category: 'mobile',
    description: 'Mobile testing with Appium (iOS XCUITest, Android UiAutomator2)',
    flag: '--appium',
    defaultSelected: false,
    status: 'coming-soon',
  },
  {
    id: 'ai-judge',
    package: '@pwtap/plugin-ai-judge',
    category: 'ai',
    description: 'AI/LLM judge matchers (toPassRubric, toScoreAtLeast, toMatchImage)',
    flag: '--ai-judge',
    defaultSelected: false,
    status: 'stable',
  },
];

/** Find a known plugin by id or package name. */
export function findKnownPlugin(idOrPackage: string): KnownPlugin | undefined {
  return KNOWN_PLUGINS.find(p => p.id === idOrPackage || p.package === idOrPackage);
}
