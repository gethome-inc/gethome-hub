import type { Environment } from '@matter/main';
import type { Logger } from '../../logging.js';

/**
 * Bluetooth for commissioning, and the honest answer when there isn't any.
 *
 * A Matter accessory that has never been on a network cannot be found on one.
 * A factory-new — or factory-reset — Wi-Fi plug advertises over Bluetooth LE
 * and nowhere else, and the conversation that follows is what gives it the
 * Wi-Fi it will live on afterwards. Without BLE the hub can only take in
 * accessories that are *already* on the LAN: Ethernet, Thread behind somebody
 * else's border router, or a device shared from another ecosystem. That is a
 * fraction of what people buy, and it was the whole of what this hub could do.
 *
 * Three things make this its own module rather than six lines in the adapter.
 *
 * **The dependency is optional and must stay that way.** `@stoprocent/noble`
 * is a native module; it has prebuilt binaries for the two architectures the
 * hub ships on and none for whatever else somebody is developing on. A hub
 * whose BLE stack failed to install must still start, run Matter over IP, and
 * say so — so the import is dynamic and every failure resolves to a reason
 * rather than throwing.
 *
 * **The reason is a product surface, not a log line.** "Bluetooth is off on
 * this hub" and "this hub has no Bluetooth" and "Bluetooth is blocked" send a
 * person to three different places, and the app can only say which if the hub
 * tells it. `GET /hub` carries it.
 *
 * **Nothing here is loaded on a hub that isn't asked.** `install()` is the
 * only entry point and it returns early when BLE is not wanted, so a Matter
 * hub on a machine with no Bluetooth never pulls the native module into its
 * heap — the same reason the adapters themselves are dynamic imports in
 * `src/index.ts`.
 */
export type BleUnavailableReason =
  /**
   * The adapter has not started yet, so nothing has been decided.
   *
   * **Not a fault, and the reason this exists is that it was being reported as
   * one.** The API listens *before* the adapters start — deliberately, so a
   * slow radio cannot hold port 8420 closed — which leaves a window of about
   * thirty seconds on every boot where `GET /hub` is answering questions about
   * a Matter adapter that has not run a line of its own code. The initial
   * value there was `off`, meaning *nobody asked for it*: specific, actionable
   * and wrong, so an app polling across a restart told somebody to go and turn
   * their Bluetooth on.
   */
  | 'starting'
  /** Nobody asked for it. */
  | 'off'
  /** Linux only — matter.js's BLE backend is BlueZ, through noble. */
  | 'unsupported-platform'
  /** The optional native module isn't installed, or won't load here. */
  | 'not-installed'
  /** It loaded and the adapter did not come up: rfkill, no hardware, no rights. */
  | 'no-adapter';

export interface BleStatus {
  /** Whether commissioning may look over Bluetooth. */
  enabled: boolean;
  reason?: BleUnavailableReason;
  /** One line for the log and for anybody reading `GET /hub`. */
  detail?: string;
}

export interface BleOptions {
  /** Whether the hub wants BLE at all. */
  wanted: boolean;
  /** Which HCI adapter, for a machine with more than one. */
  hciId?: number;
  log: Logger;
}

/**
 * Ask matter.js to add its Node.js BLE backend to this environment.
 *
 * The backend registers itself as a *service bundle* keyed on the
 * `ble.enable` environment variable, so importing the module is what makes it
 * available and setting the variable is what turns it on. Both happen here,
 * in that order, because the variable is read by a subscription the import
 * installs.
 */
export async function installBle(environment: Environment, options: BleOptions): Promise<BleStatus> {
  if (!options.wanted) return { enabled: false, reason: 'off' };

  if (process.platform !== 'linux') {
    return {
      enabled: false,
      reason: 'unsupported-platform',
      detail: `Bluetooth commissioning needs BlueZ, which is Linux only (this is ${process.platform}).`,
    };
  }

  try {
    if (options.hciId !== undefined) environment.vars.set('ble.hci.id', options.hciId);
    // Registers the bundle. Named rather than built from a variable so the
    // bundler and the type checker both see it, and wrapped because an
    // optional dependency that did not install is an ordinary outcome here.
    await import('@matter/nodejs-ble');
    environment.vars.set('ble.enable', true);
  } catch (error) {
    return {
      enabled: false,
      reason: 'not-installed',
      detail:
        "This hub's Bluetooth support isn't installed, so it can only take in Matter accessories that " +
        `are already on the network. (${(error as Error).message})`,
    };
  }

  options.log.info('Matter commissioning can use Bluetooth.');
  return { enabled: true };
}

/**
 * What to tell somebody whose accessory needs Bluetooth and whose hub hasn't
 * got it. One sentence per reason, because the fix is different every time and
 * "Bluetooth is unavailable" sends everybody to the same dead end.
 */
export function bleUnavailableSentence(status: BleStatus): string {
  switch (status.reason) {
    case 'unsupported-platform':
      return 'This hub is not running on a Raspberry Pi, so it has no Bluetooth for pairing.';
    case 'not-installed':
      return (
        "This hub's Bluetooth support isn't installed. Updating the hub installs it; until then it can " +
        'only take in accessories that are already on your network.'
      );
    case 'no-adapter':
      return (
        "This hub's Bluetooth radio didn't start. On a Raspberry Pi that is usually Bluetooth being " +
        'blocked — running the installer again turns it back on.'
      );
    case 'off':
    default:
      return 'Bluetooth pairing is turned off on this hub.';
  }
}
