import type { DriverCapabilities, MobileAction } from './protocol';

export interface ActionGate {
  supported: boolean;
  /** Why the action is unavailable — shown as the control's tooltip, never swallowed. */
  reason?: string;
}

export type GateFn = (kind: MobileAction['kind']) => ActionGate;

/**
 * Whether the connected driver will accept an action, so the UI can disable the control instead of
 * letting the user fire a command the service is about to reject. Only an explicit `false` refuses:
 * a driver that has not listed a kind stays enabled, and the service's `UnsupportedActionError` is
 * still the final word.
 *
 * @example actionGate(state.connected, 'pinch') // → { supported: false, reason: 'the maestro driver…' }
 */
export function actionGate(
  connected: { driver: string; capabilities: DriverCapabilities } | null,
  kind: MobileAction['kind'],
): ActionGate {
  if (!connected) {
    return { supported: false, reason: 'connect a device first' };
  }
  return connected.capabilities.gestures[kind] === false
    ? {
        supported: false,
        reason: `the ${connected.driver} driver does not support "${kind}" actions`,
      }
    : { supported: true };
}
