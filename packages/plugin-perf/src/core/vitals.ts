/**
 * Core Web Vitals and navigation timing, read from the page's own performance timeline.
 *
 * Split in two deliberately. {@link harvestVitalsInPage} runs INSIDE the browser — `page.evaluate` serializes it
 * to a string, so it may not reference anything outside its own body — and it therefore does nothing but hand
 * back raw entries. Every calculation lives in {@link sampleOf}, which is pure Node and unit tested without a
 * browser. The two subtle parts of Web Vitals, CLS session windows and INP's per-interaction grouping, are
 * exactly the parts that must not be trapped in an untestable string.
 *
 * No `web-vitals` dependency: the page already ships the measurement, and the algorithms below follow the
 * definitions rather than a sum that looks close.
 *
 * @example
 * const sample = sampleOf(await page.evaluate(harvestVitalsInPage)); // harvest is async: see its note on LCP
 * compareVitals(sample, { lcp: 2500, cls: 0.1 }); // → { failures: [], unmeasurable: [] }
 */

/**
 * Raw entries as the page reported them.
 *
 * A field is `undefined` when the browser does not support that entry type, and an empty array when it does but
 * nothing happened — the distinction the skip-instead-of-fail rule rests on, since no layout shifts is a real CLS
 * of 0 while no support for layout shifts is not a measurement at all.
 */
export interface RawVitals {
  /** `PerformanceObserver.supportedEntryTypes`, carried out of the page so a skip can name what is missing. */
  supported: string[];
  navigation?: {
    responseStart: number;
    domContentLoadedEventEnd: number;
    loadEventEnd: number;
  };
  /** First Contentful Paint, in ms. */
  fcp?: number;
  /** The last LCP candidate's `startTime`. */
  lcp?: number;
  shifts?: Array<{ startTime: number; value: number; hadRecentInput: boolean }>;
  longTasks?: Array<{ startTime: number; duration: number }>;
  events?: Array<{ interactionId: number; duration: number }>;
}

/**
 * What one page reported, after the arithmetic. `undefined` means "not measured", never "measured as zero".
 *
 * Which metrics a browser can produce is read at run time from `PerformanceObserver.supportedEntryTypes`, not
 * assumed here, so this adapts as browsers gain entry types. Measured with Playwright 1.61's own builds: `ttfb`,
 * `domContentLoaded`, `load`, `fcp`, `lcp` and `inp` came back from Chromium, WebKit AND Firefox; only `cls`,
 * `tbt` and `longTasks` were Chromium-only. "LCP and INP are Chromium-only" is a common claim and was wrong here.
 */
export interface VitalsSample {
  /** Time to first byte: `responseStart` on the navigation entry, the definition web.dev uses. */
  ttfb?: number;
  /** First Contentful Paint, in ms. */
  fcp?: number;
  /** Largest Contentful Paint, in ms. Reported by all three Playwright browsers. */
  lcp?: number;
  /** Cumulative Layout Shift, unitless. Needs `layout-shift` entries: **Chromium only**. */
  cls?: number;
  /**
   * Interaction to Next Paint, in ms. Reported by all three Playwright browsers, but absent when the test never
   * interacted — there is no interaction to measure.
   */
  inp?: number;
  /** Total Blocking Time, in ms — the lab stand-in for INP. Needs `longtask` entries: **Chromium only**. */
  tbt?: number;
  /** How many tasks blocked the main thread for over 50 ms. Needs `longtask` entries: **Chromium only**. */
  longTasks?: number;
  /** `domContentLoadedEventEnd`, in ms. */
  domContentLoaded?: number;
  /** `loadEventEnd`, in ms; absent while the load event has not fired. */
  load?: number;
  /** Passed through from {@link RawVitals}, so `compareVitals` can tell unsupported from unproduced. */
  supported: string[];
}

/** A budget per metric. Every field is a ceiling, `longTasks` included — it is a count, not a duration. */
export interface VitalsBudget {
  ttfb?: number;
  fcp?: number;
  lcp?: number;
  cls?: number;
  inp?: number;
  tbt?: number;
  longTasks?: number;
  domContentLoaded?: number;
  load?: number;
}

/** What `vitals.assert()` found: budgets exceeded, and budgets this run could not measure at all. */
export interface VitalsVerdict {
  failures: string[];
  unmeasurable: string[];
}

/** Which performance entry type each metric is derived from — the basis of the skip reason. */
const ENTRY_TYPE_FOR: Record<keyof VitalsBudget, string> = {
  ttfb: 'navigation',
  fcp: 'paint',
  lcp: 'largest-contentful-paint',
  cls: 'layout-shift',
  inp: 'event',
  tbt: 'longtask',
  longTasks: 'longtask',
  domContentLoaded: 'navigation',
  load: 'navigation',
};

/** Unitless where the metric is unitless — a "0.24 ms" layout shift would be nonsense in a report. */
const UNIT_FOR: Partial<Record<keyof VitalsBudget, string>> = { cls: '', longTasks: '' };

/** A task over this many ms is a "long task"; the excess is what counts towards TBT. */
const LONG_TASK_MS = 50;
/** A layout-shift session ends after this long without a shift. */
const CLS_SESSION_GAP_MS = 1000;
/** …or once the session itself has run this long. */
const CLS_SESSION_MAX_MS = 5000;

/**
 * Hand the raw performance timeline out of the page.
 *
 * Runs in the browser, so it is self-contained by necessity. Nothing is registered before navigation: everything
 * is read after the fact, so the caller has no ordering trap to fall into.
 *
 * **`performance.getEntriesByType('largest-contentful-paint')` returns an empty array in Chromium even on a fully
 * loaded page**, which is why the dynamic entry types are read through a `PerformanceObserver` with
 * `buffered: true` instead — the way `web-vitals` does it, and the only way LCP is retrievable at all. Found by
 * running this against a real page, where an LCP budget skipped with "the browser supports
 * largest-contentful-paint entries but produced none"; every structural check had passed. Navigation and paint
 * entries ARE readable directly, so they still are.
 *
 * Buffered entries reach an observer callback in a later task rather than synchronously, hence the one-macrotask
 * wait. For `layout-shift` and `longtask` the direct read is kept as a cross-check and the LONGER of the two lists
 * wins: both describe the same underlying entries, so this cannot double count, and it means a browser where
 * buffered delivery misbehaves reports too few shifts rather than silently reporting a clean CLS of 0.
 *
 * One accepted limitation: `event` entries below the browser's default 104 ms buffering threshold are invisible.
 * Irrelevant here, since an INP budget worth asserting is far above that.
 */
export async function harvestVitalsInPage(): Promise<RawVitals> {
  // Declared inline for two reasons. This function is serialized, so nothing outside its body exists at run time;
  // and typing it against the DOM lib would force `lib: ["DOM"]` on every tsconfig that so much as imports this
  // file — including the repo's aggregate test project, where Node's narrower `perf_hooks` shapes then collide
  // (`EntryType` is a closed union with no 'layout-shift'). Structural types plus one cast per global keep the
  // file compiling under any config, which is what the browser actually needs anyway: `performance` and
  // `PerformanceObserver` exist as values in both type worlds, only their declared shapes differ.
  interface TimelineEntry {
    name: string;
    startTime: number;
    duration: number;
  }
  interface NavigationEntry extends TimelineEntry {
    responseStart: number;
    domContentLoadedEventEnd: number;
    loadEventEnd: number;
  }
  interface ShiftEntry extends TimelineEntry {
    value: number;
    hadRecentInput: boolean;
  }
  interface EventEntry extends TimelineEntry {
    interactionId?: number;
  }

  interface Observer {
    observe(options: { type: string; buffered: boolean }): void;
    disconnect(): void;
  }

  const timeline = performance as unknown as {
    getEntriesByType(type: string): TimelineEntry[];
  };
  const ObserverCtor = PerformanceObserver as unknown as {
    supportedEntryTypes?: readonly string[];
    new (callback: (list: { getEntries(): TimelineEntry[] }) => void): Observer;
  };

  const supported = Array.from(ObserverCtor.supportedEntryTypes ?? []);
  const DYNAMIC_TYPES = ['largest-contentful-paint', 'layout-shift', 'longtask', 'event'];

  const observed = new Map<string, TimelineEntry[]>();
  const observers: Observer[] = [];
  for (const type of DYNAMIC_TYPES) {
    if (!supported.includes(type)) {
      continue;
    }
    const forType: TimelineEntry[] = [];
    observed.set(type, forType);
    const observer = new ObserverCtor(list => forType.push(...list.getEntries()));
    observer.observe({ type, buffered: true });
    observers.push(observer);
  }

  // Buffered entries are delivered in a later task, so yield once before reading them.
  await new Promise(resolve => setTimeout(resolve, 0));

  // LCP arrives asynchronously and LATER THAN THE LOAD EVENT — measured on a trivial local page: load at 39 ms,
  // first contentful paint at 268 ms — so `collect()` straight after `waitUntil: 'load'` finds nothing at all.
  // That is not a bug to document away: it would make every caller sleep before every collect. Wait here instead,
  // bounded, and only when the browser could produce an LCP but has not yet. A page that genuinely never paints
  // anything contentful pays this once and then skips with the reason.
  if (supported.includes('largest-contentful-paint')) {
    const deadline = Date.now() + 2000;
    while ((observed.get('largest-contentful-paint')?.length ?? 0) === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  for (const observer of observers) {
    observer.disconnect();
  }

  /** The observed list, or the direct read when that is longer — see this function's note. */
  const entriesOf = (type: string): TimelineEntry[] | undefined => {
    const fromObserver = observed.get(type);
    if (fromObserver === undefined) {
      return undefined;
    }
    const direct = timeline.getEntriesByType(type);
    return direct.length > fromObserver.length ? direct : fromObserver;
  };

  const harvest = <T>(type: string, map: (entry: TimelineEntry) => T): T[] | undefined =>
    entriesOf(type)?.map(map);

  const nav = timeline.getEntriesByType('navigation')[0] as NavigationEntry | undefined;

  // Every LCP candidate is reported as the page grows; the last one is the answer.
  const lcpEntries = entriesOf('largest-contentful-paint') ?? [];

  return {
    supported,
    navigation: nav
      ? {
          responseStart: nav.responseStart,
          domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
          loadEventEnd: nav.loadEventEnd,
        }
      : undefined,
    fcp: timeline.getEntriesByType('paint').find(entry => entry.name === 'first-contentful-paint')
      ?.startTime,
    lcp: lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1]?.startTime : undefined,
    shifts: harvest('layout-shift', entry => ({
      startTime: entry.startTime,
      value: (entry as ShiftEntry).value,
      hadRecentInput: (entry as ShiftEntry).hadRecentInput,
    })),
    longTasks: harvest('longtask', entry => ({
      startTime: entry.startTime,
      duration: entry.duration,
    })),
    events: harvest('event', entry => ({
      interactionId: (entry as EventEntry).interactionId ?? 0,
      duration: entry.duration,
    })),
  };
}

/** Turn raw entries into the metrics. Pure, so every algorithm below is unit tested. */
export function sampleOf(raw: RawVitals): VitalsSample {
  const nav = raw.navigation;
  return {
    supported: raw.supported,
    ttfb: nav?.responseStart,
    domContentLoaded: nav?.domContentLoadedEventEnd,
    // `loadEventEnd` is 0 until the load event fires, and 0 would read as an impossibly fast page.
    load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : undefined,
    fcp: raw.fcp,
    lcp: raw.lcp,
    cls: raw.shifts && clsOf(raw.shifts),
    tbt: raw.longTasks && blockingTimeOf(raw.longTasks, raw.fcp ?? 0),
    longTasks: raw.longTasks && countedLongTasks(raw.longTasks, raw.fcp ?? 0).length,
    inp: raw.events && inpOf(raw.events),
  };
}

/**
 * CLS is the worst SESSION window, not the sum of every shift.
 *
 * A new session starts after a 1 s gap, or once 5 s have passed since the session's first shift. Summing
 * everything over-reports any long-lived page, which is the usual way a hand-rolled CLS ends up wrong. Shifts the
 * user caused are excluded, as the metric defines.
 */
export function clsOf(shifts: NonNullable<RawVitals['shifts']>): number {
  let worst = 0;
  let session = 0;
  let sessionStart = 0;
  let previous = 0;

  for (const shift of shifts) {
    if (shift.hadRecentInput) {
      continue;
    }
    if (
      session > 0 &&
      (shift.startTime - previous > CLS_SESSION_GAP_MS ||
        shift.startTime - sessionStart > CLS_SESSION_MAX_MS)
    ) {
      worst = Math.max(worst, session);
      session = 0;
    }
    if (session === 0) {
      sessionStart = shift.startTime;
    }
    session += shift.value;
    previous = shift.startTime;
  }

  return Math.max(worst, session);
}

/**
 * Long tasks after the first paint.
 *
 * Counted from FCP as Lighthouse does: work that blocks the main thread before anything is painted blocks nothing
 * the user can see yet.
 */
export function countedLongTasks(
  tasks: NonNullable<RawVitals['longTasks']>,
  fcp: number,
): NonNullable<RawVitals['longTasks']> {
  return tasks.filter(task => task.startTime >= fcp);
}

/** Total Blocking Time: for every long task after FCP, the part of it beyond 50 ms. */
export function blockingTimeOf(tasks: NonNullable<RawVitals['longTasks']>, fcp: number): number {
  return countedLongTasks(tasks, fcp).reduce(
    (total, task) => total + Math.max(0, task.duration - LONG_TASK_MS),
    0,
  );
}

/**
 * INP: the worst interaction, or `undefined` when nothing was interacted with.
 *
 * Entries sharing an `interactionId` are ONE interaction, and that interaction's latency is the longest of them.
 * Under 50 interactions — every automated test — the spec's INP simply is the worst interaction, so no percentile
 * is involved. Entries with no `interactionId` are not interactions at all and are ignored.
 */
export function inpOf(events: NonNullable<RawVitals['events']>): number | undefined {
  const worstPerInteraction = new Map<number, number>();
  for (const event of events) {
    if (!event.interactionId) {
      continue;
    }
    const previous = worstPerInteraction.get(event.interactionId) ?? 0;
    worstPerInteraction.set(event.interactionId, Math.max(previous, event.duration));
  }
  return worstPerInteraction.size > 0 ? Math.max(...worstPerInteraction.values()) : undefined;
}

/**
 * Compare a sample against a budget.
 *
 * A budgeted metric with no measurement goes to `unmeasurable` rather than `failures`, and the caller skips —
 * the same rule an absent device or an unreachable database follows. The reason distinguishes the two ways that
 * happens, because they need different fixes: the browser cannot produce the metric at all (use Chromium), or it
 * can and this run did not produce one (interact with something, or wait for load).
 */
export function compareVitals(sample: VitalsSample, budget: VitalsBudget): VitalsVerdict {
  const failures: string[] = [];
  const unmeasurable: string[] = [];

  for (const [name, limit] of Object.entries(budget) as Array<
    [keyof VitalsBudget, number | undefined]
  >) {
    if (limit === undefined) {
      continue;
    }
    const measured = sample[name];
    if (measured === undefined) {
      const entryType = ENTRY_TYPE_FOR[name];
      unmeasurable.push(
        sample.supported.includes(entryType)
          ? `${name} was not reported by this run (the browser supports "${entryType}" entries but produced none — ${hint(name)})`
          : `${name} needs "${entryType}" entries, which this browser does not support — run this budget on Chromium`,
      );
      continue;
    }
    if (measured > limit) {
      const unit = UNIT_FOR[name] ?? ' ms';
      failures.push(`${name} ${round(measured)}${unit} exceeds the ${limit}${unit} budget`);
    }
  }

  return { failures, unmeasurable };
}

/** What to actually do about a metric the browser could measure but this run did not produce. */
function hint(name: keyof VitalsBudget): string {
  if (name === 'inp') {
    return 'INP needs a real interaction: click or type before collecting';
  }
  if (name === 'load') {
    return 'the load event had not fired: navigate with waitUntil "load"';
  }
  return 'navigate before collecting';
}

/** Two decimals, so a CLS of 0.0500000001 does not read as noise in a failure message. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
