import path from 'node:path';
import { CommissioningController } from '@project-chip/matter.js';
import { NodeStates, type Endpoint, type PairedNode } from '@project-chip/matter.js/device';
import { Environment, Millis, ServerAddress } from '@matter/main';
import { ActiveDiscoveries } from '@matter/main/node';
import { ClusterId, NodeId } from '@matter/main/types';
import type { AdapterBus, ProtocolAdapter } from '../adapter.js';
import type { EndpointState, HubCommand } from '../../schema/index.js';
import { descriptorFor, isInfrastructureOnly } from '../../schema/index.js';
import { reduceReports, type AttributeReport } from './reducer.js';
import { executeMatterCommand } from './commands.js';
import { installBle, type BleStatus } from './ble.js';
import {
  classifyCommissionError,
  CommissionError,
  commissionFailure,
  type CommissionFailure,
} from './commission-failures.js';
import {
  discoveryCapabilitiesFor,
  InvalidSetupCodeError,
  needsBluetooth,
  parseSetupCode,
} from './setup-code.js';
import type { WifiCredentials } from '../../core/wifi.js';
import type { Logger } from '../../logging.js';

const SWITCH_CLUSTER = 0x003b;

/** Switch cluster feature bits (Matter spec 1.13.4). */
const SWITCH_FEATURE = {
  momentary: 0x02,
  momentaryRelease: 0x04,
  momentaryLongPress: 0x08,
  momentaryMultiPress: 0x10,
} as const;

/** Switch cluster event ids → the canonical gesture they complete. */
const SWITCH_EVENT = {
  switchLatched: 0x00,
  initialPress: 0x01,
  longPress: 0x02,
  shortRelease: 0x03,
  longRelease: 0x04,
  multiPressComplete: 0x06,
} as const;

const PRESS_COUNT_GESTURES = ['single', 'double', 'triple', 'quadruple'] as const;

/**
 * How long the hub looks for an accessory before saying it isn't there.
 *
 * Three minutes is the Matter spec's own minimum commissioning window
 * (§ 5.4.2.3), so it is the longest a correctly-behaved accessory can be
 * waiting to be found, and matter.js defaults to the same number. It is set
 * here rather than left to the default for two reasons: the number is a
 * promise the apps make to somebody watching a spinner, so it has to be a
 * number this repository owns; and matter.js applies **no timeout at all**
 * when one is not reached — `Discovery` guards its `withTimeout` on
 * `!== undefined` — so a version that stopped filling the default in would
 * turn every failed pairing into a job that never settles. It did exactly
 * that once, and the screen said "Pairing with your hub" until the app was
 * force-quit.
 */
const DISCOVERY_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The whole job's budget, discovery *and* everything after it.
 *
 * Finding the accessory is only the first half: PASE, attestation, the
 * fabric, the network credentials and the first CASE session all follow, and
 * each of them can stall against a device that has wandered off mid-flow. The
 * discovery bound says nothing about those, so the job carries its own — half
 * again, which is enough for a slow Thread join on a small board and short
 * enough that nobody is left watching.
 */
const COMMISSION_TIMEOUT_MS = DISCOVERY_TIMEOUT_MS + 90 * 1000;

export interface MatterAdapterOptions {
  dataDir: string;
  log: Logger;
  /**
   * Whether to bring Bluetooth up for commissioning. Off leaves the hub able
   * to take in only accessories already on the network — which is what it
   * could do before this existed.
   */
  ble?: boolean;
  /** Which HCI adapter, on a machine with more than one. */
  hciId?: number;
  /**
   * The Wi-Fi to hand an accessory that has none, read afresh each time: the
   * home may have retyped its password since the hub booted.
   */
  wifi?: () => WifiCredentials | undefined;
}

/**
 * A commissionable accessory the hub can hear right now.
 *
 * The point is not the list — it is the *answer to a yes/no question asked
 * before committing to a three-minute wait*: can this hub reach the thing in
 * somebody's hand at all? Bluetooth range is the one part of pairing nobody
 * can see, and until the hub could be asked, the only way to find out was to
 * try, wait out the whole discovery budget, and read "not found" — which is
 * the same sentence for "too far away" and "not in pairing mode", two problems
 * with completely different fixes.
 */
export interface DiscoverableAccessory {
  /** The 12-bit discriminator, which is what a scanned code can be matched to. */
  discriminator: number;
  vendorId?: number;
  productId?: number;
  /** The accessory's own advertised name, when it publishes one. */
  name?: string;
  /** How the hub can hear it — Bluetooth means it is not on a network yet. */
  transport: 'ble' | 'ip';
  /**
   * The accessory's own hint about how it was put into pairing mode (Matter
   * core spec § 5.4.2.4, Table 71) and, where it publishes one, the sentence
   * that goes with it. Passed through rather than interpreted: it is the
   * manufacturer talking, and an app that renders the sentence is right more
   * often than a hub that invents one from the bitmap.
   */
  pairingHint?: number;
  pairingInstruction?: string;
}

/** What the caller asked for, beyond the code itself. */
export interface CommissionRequest {
  pairingCode: string;
  /**
   * Wi-Fi for an accessory being taken on over Bluetooth. Overrides the hub's
   * own, for the hub that has none to offer — see `core/wifi.ts`.
   */
  wifi?: WifiCredentials;
  /** Reported as the job moves, so a screen can say more than "working…". */
  onProgress?: (step: CommissionStep) => void;
}

/**
 * Where a pairing has got to, in the two words that change what somebody
 * should do. **Looking** is when "hold the button until it blinks" is the
 * advice; **pairing** is when the accessory has answered and the only correct
 * advice is to leave it alone.
 */
export type CommissionStep = 'looking' | 'pairing';

/**
 * Matter controller on the hub's own fabric, built on matter.js.
 *
 * Accessories are commissioned either **over Bluetooth** — a factory-new or
 * factory-reset device, which has no network yet and is handed one during the
 * conversation — or **over IP**, for anything already on the LAN: Ethernet,
 * Thread behind a border router, or a device shared from another ecosystem
 * under multi-admin. Which of the two is used is the accessory's own answer,
 * carried in its QR payload, not a setting (see `setup-code.ts`).
 *
 * Needs the host's own network: Matter is site-local UDP (port 5540) plus
 * mDNS (5353), neither of which survives being NAT-ed. The hub runs directly
 * on the host as a systemd unit, so this costs nothing to arrange and is one
 * of the reasons it isn't containerised.
 */
export class MatterAdapter implements ProtocolAdapter {
  readonly id = 'matter' as const;

  private controller: CommissioningController | null = null;
  private bus: AdapterBus | null = null;
  private readonly nodes = new Map<string, PairedNode>();
  /** Working states for the reducer, keyed `${nodeId}/${endpointId}`. */
  private readonly states = new Map<string, EndpointState>();
  /** Switch-cluster features per `${nodeId}/${endpointId}` (buttons). */
  private readonly switchFeatures = new Map<string, { multiPress: boolean }>();
  /** Whether commissioning may look over Bluetooth, and why not when it can't. */
  private ble: BleStatus = { enabled: false, reason: 'off' };
  /** The environment this controller runs in, kept so a job can stop a discovery. */
  private environment: Environment | null = null;
  /**
   * The pairing in flight, if any.
   *
   * One at a time, deliberately. Two commissionings share one BLE radio and
   * one mDNS scanner, and the only way to stop either is to stop *the*
   * discovery — so a second job would be a job whose cancel button cancelled
   * somebody else's. A hub takes in one accessory at a time in any case; the
   * person doing it is standing next to it.
   */
  private inFlight: { cancel: (failure: CommissionFailure) => void } | null = null;

  constructor(private readonly options: MatterAdapterOptions) {}

  /** Whether Bluetooth pairing is available here, for `GET /hub`. */
  get bleStatus(): BleStatus {
    return this.ble;
  }

  /** Whether the hub can offer an accessory a network of its own. */
  get hasWifiCredentials(): boolean {
    return this.options.wifi?.() !== undefined;
  }

  /** Whether a pairing is running right now. */
  get isCommissioning(): boolean {
    return this.inFlight !== null;
  }

  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
    const environment = Environment.default;
    this.environment = environment;
    environment.vars.set('storage.path', path.join(this.options.dataDir, 'matter'));

    // Before the controller is built: the BLE backend registers itself as a
    // service on the environment, and the controller reads the services it
    // has when it starts. Installed after that, it is a transport nothing is
    // holding — which is how "BLE is not enabled on this platform" ends up in
    // the log of a hub that has perfectly good Bluetooth.
    this.ble = await installBle(environment, {
      wanted: this.options.ble === true,
      ...(this.options.hciId !== undefined ? { hciId: this.options.hciId } : {}),
      log: this.options.log,
    });
    if (!this.ble.enabled && this.ble.detail !== undefined) {
      this.options.log.warn(this.ble.detail);
    }

    this.controller = new CommissioningController({
      environment: { environment, id: 'gethome-hub' },
      autoConnect: false,
      adminFabricLabel: 'GetHome Hub',
    });
    await this.controller.start();

    for (const nodeId of this.controller.getCommissionedNodes()) {
      // Attach in the background — an unreachable device must not stall boot.
      void this.attachNode(nodeId).catch((error) => {
        this.options.log.warn({ err: error }, `Could not attach Matter node ${nodeId}`);
      });
    }
    this.options.log.info(
      `Matter controller started with ${this.controller.getCommissionedNodes().length} commissioned node(s).`,
    );
  }

  async stop(): Promise<void> {
    await this.controller?.close();
    this.controller = null;
    this.nodes.clear();
  }

  async execute(externalId: string, endpointId: number, command: HubCommand): Promise<void> {
    const node = this.nodes.get(externalId);
    if (!node) throw new Error(`Matter node ${externalId} is not connected`);
    const endpoint = node.getDeviceById(endpointId);
    if (!endpoint) throw new Error(`Matter node ${externalId} has no endpoint ${endpointId}`);
    await executeMatterCommand(endpoint, command);
  }

  async forget(externalId: string): Promise<void> {
    if (!this.controller) return;
    await this.controller.removeNode(NodeId(BigInt(externalId)), true);
    this.nodes.delete(externalId);
  }

  /**
   * Commission a device onto the hub fabric using a manual pairing code
   * (e.g. "749701123365521327694") or a QR payload ("MT:..."). Resolves to
   * the node id once the device is attached, and rejects with a
   * `CommissionError` naming what went wrong.
   *
   * Two refusals happen *before* anything is searched for, because in both
   * cases the answer cannot change while somebody waits for it, and three
   * minutes of a spinner ending in the same word is worse than the word now:
   * a code this hub cannot read, and an accessory whose own code says
   * Bluetooth on a hub that hasn't got any.
   */
  async commission(request: CommissionRequest): Promise<string> {
    if (!this.controller) throw new Error('Matter controller is not running');
    if (this.inFlight) {
      throw new CommissionError(
        commissionFailure('failed', 'This hub is already pairing an accessory. Wait for that to finish.'),
      );
    }

    let code;
    try {
      code = parseSetupCode(request.pairingCode);
    } catch (error) {
      if (error instanceof InvalidSetupCodeError) {
        throw new CommissionError(commissionFailure('bad-code', error.message));
      }
      throw error;
    }

    if (needsBluetooth(code, { ble: this.ble.enabled })) {
      throw new CommissionError(commissionFailure('needs-bluetooth', this.ble.detail));
    }

    const capabilities = discoveryCapabilitiesFor(code, { ble: this.ble.enabled });
    // Handed over only when Bluetooth is in play. An accessory found on the IP
    // network already has a network, and offering it another is a write it did
    // not ask for on a device somebody else may also own.
    const wifi = capabilities.ble ? (request.wifi ?? this.options.wifi?.()) : undefined;

    // The third refusal that belongs before the search rather than after it.
    // An accessory whose code says Bluetooth and *only* Bluetooth has no
    // network, and the whole point of the conversation it is waiting for is to
    // be given one — so a hub with no Wi-Fi password to pass on can start this
    // and cannot finish it. Saying so now is what lets the app ask for the
    // password, which is a thing somebody can do; three minutes of a spinner
    // is not.
    if (capabilities.ble && !capabilities.onIpNetwork && wifi === undefined) {
      throw new CommissionError(commissionFailure('needs-wifi'));
    }

    this.options.log.info(
      {
        ble: capabilities.ble,
        onIpNetwork: capabilities.onIpNetwork,
        wifi: wifi !== undefined,
        ...(code.vendorId !== undefined ? { vendorId: code.vendorId } : {}),
      },
      'Matter: looking for an accessory to pair.',
    );
    request.onProgress?.('looking');

    const nodeId = await this.runCommissioning(code, capabilities, wifi, request.onProgress);

    const externalId = nodeId.toString();
    await this.attachNode(nodeId);
    this.bus?.activity({
      kind: 'matter.commissioned',
      message: `A Matter accessory was commissioned onto the hub.`,
      adapter: 'matter',
      externalId,
    });
    return externalId;
  }

  /**
   * Listen for a moment and report every commissionable accessory the hub can
   * reach.
   *
   * **Short and explicit.** This holds an HTTP request open and it drives a
   * radio, so it is seconds rather than minutes and it is asked for rather
   * than run in the background: a hub nobody is pairing with should not be
   * scanning for accessories nobody is holding.
   *
   * **Refused while a pairing is running.** The two would be contending for
   * one Bluetooth controller, and a starved scan does not fail — it reports an
   * empty list, which is the wrong answer in the one direction that matters,
   * because somebody acts on it by concluding their accessory is broken. (That
   * is not a theory: running a second scanner beside this hub's own took
   * fifteen seconds of neighbourhood advertisements from 231 down to 2.)
   */
  async discoverable(seconds: number): Promise<DiscoverableAccessory[]> {
    if (!this.controller) throw new Error('Matter controller is not running');
    if (this.inFlight) {
      throw new CommissionError(
        commissionFailure('failed', 'This hub is pairing an accessory, so it cannot look around at the same time.'),
      );
    }

    const found = await this.controller.discoverCommissionableDevices(
      {},
      { ble: this.ble.enabled, onIpNetwork: true },
      undefined,
      Millis(seconds * 1000),
    );

    const accessories = new Map<number, DiscoverableAccessory>();
    for (const device of found) {
      // `VP` is "<vendor>+<product>", and the product half is optional.
      const [vendor, product] = (device.VP ?? '').split('+');
      const vendorId = Number(vendor);
      const productId = Number(product);
      // matter.js's own type guard rather than reading a field: an IP
      // address carries no discriminant, so `address.type === 'ble'` does not
      // even type-check against the union.
      const overBle = device.addresses.some((address) => ServerAddress.isBle(address));
      const accessory: DiscoverableAccessory = {
        discriminator: device.D,
        ...(Number.isFinite(vendorId) && vendor ? { vendorId } : {}),
        ...(Number.isFinite(productId) && product ? { productId } : {}),
        ...(device.DN !== undefined && device.DN.length > 0 ? { name: device.DN } : {}),
        transport: overBle ? 'ble' : 'ip',
        ...(device.PH !== undefined ? { pairingHint: device.PH } : {}),
        ...(device.PI !== undefined && device.PI.length > 0 ? { pairingInstruction: device.PI } : {}),
      };
      // One entry per accessory, and Bluetooth wins a tie: a device answering
      // on both is one device, and the Bluetooth answer is the one that says
      // it has not got a network yet.
      const existing = accessories.get(device.D);
      if (existing === undefined || (existing.transport === 'ip' && overBle)) {
        accessories.set(device.D, accessory);
      }
    }
    return [...accessories.values()];
  }

  /**
   * Stop the pairing in flight, if there is one.
   *
   * Returns whether there was anything to stop, so a route can answer 404 for
   * a job that finished while the request was in the air rather than claiming
   * to have cancelled something.
   */
  cancelCommissioning(): boolean {
    if (!this.inFlight) return false;
    this.inFlight.cancel(commissionFailure('cancelled'));
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * The commissioning call, bounded and interruptible.
   *
   * matter.js's `commissionNode` is a plain promise with no signal to abort —
   * the cancellable object is the `Discovery` underneath it, which the legacy
   * controller awaits and never hands back. So the race is here: the job
   * settles on whichever of the pairing, the budget, and a cancel arrives
   * first, and losing the race **stops the discovery** through the
   * environment's own registry of live ones rather than leaving a Bluetooth
   * scan running behind a screen that has moved on.
   */
  private async runCommissioning(
    code: ReturnType<typeof parseSetupCode>,
    capabilities: { ble: boolean; onIpNetwork: boolean },
    wifi: WifiCredentials | undefined,
    onProgress: ((step: CommissionStep) => void) | undefined,
  ): Promise<NodeId> {
    let settle: ((failure: CommissionFailure) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      settle = (failure) => reject(new CommissionError(failure));
    });
    const budget = setTimeout(
      () => settle?.(commissionFailure('not-found')),
      COMMISSION_TIMEOUT_MS,
    );
    budget.unref?.();
    this.inFlight = { cancel: (failure) => settle?.(failure) };

    // **A real signal, not a timer.** A candidate reaches `peers` when
    // discovery has actually found an accessory matching the identifier, which
    // is the exact moment the advice changes from "hold its button until it
    // blinks" to "leave it alone now". A five-second timeout would have said
    // the same thing about a hub that had found nothing at all, which is the
    // sort of progress report that teaches people to ignore progress reports.
    const found = (): void => onProgress?.('pairing');
    this.controller!.node.peers.added.on(found);

    const pairing = this.controller!.commissionNode({
      commissioning: {
        ...(wifi !== undefined
          ? { wifiNetwork: { wifiSsid: wifi.ssid, wifiCredentials: wifi.passphrase } }
          : {}),
      },
      discovery: {
        identifierData:
          code.longDiscriminator !== undefined
            ? { longDiscriminator: code.longDiscriminator }
            : code.shortDiscriminator !== undefined
              ? { shortDiscriminator: code.shortDiscriminator }
              : {},
        discoveryCapabilities: capabilities,
        timeout: Millis(DISCOVERY_TIMEOUT_MS),
      },
      passcode: code.passcode,
    });

    try {
      return await Promise.race([pairing, interrupted]);
    } catch (error) {
      if (error instanceof CommissionError) {
        // We lost the race, so the discovery is still running. Stopping it is
        // what makes a cancel a cancel rather than a screen that closed.
        this.stopDiscoveries();
        // The pairing may still reject later; nothing is waiting for it, and
        // an unhandled rejection would take the process down.
        void pairing.catch(() => undefined);
        throw error;
      }
      throw new CommissionError(classifyCommissionError(error));
    } finally {
      clearTimeout(budget);
      this.controller!.node.peers.added.off(found);
      this.inFlight = null;
      settle = undefined;
    }
  }

  /**
   * Ask matter.js to stop looking.
   *
   * `ActiveDiscoveries` is the environment's own set of live ones and is the
   * only handle on a discovery the legacy controller started. Cancelling every
   * member is right *because* this adapter allows one pairing at a time —
   * without that rule it would be one screen's Cancel stopping another's.
   */
  private stopDiscoveries(): void {
    try {
      const discoveries = this.environment?.get(ActiveDiscoveries);
      for (const discovery of discoveries ?? []) discovery.stop();
    } catch (error) {
      this.options.log.warn({ err: error }, 'Could not stop the Matter discovery.');
    }
  }

  private async attachNode(nodeId: NodeId): Promise<void> {
    if (!this.controller || !this.bus) return;
    const externalId = nodeId.toString();
    const node = await this.controller.getNode(nodeId);
    this.nodes.set(externalId, node);

    node.events.initializedFromRemote.on(() => this.announceNode(externalId, node));
    node.events.structureChanged.on(() => this.announceNode(externalId, node));
    node.events.stateChanged.on((nodeState) => {
      this.bus?.reachabilityChanged('matter', externalId, nodeState === NodeStates.Connected);
    });
    node.events.attributeChanged.on(({ path: attributePath, value }) => {
      const report: AttributeReport = {
        endpointId: attributePath.endpointId,
        clusterId: attributePath.clusterId,
        attributeId: attributePath.attributeId,
        value,
      };
      this.applyReports(externalId, attributePath.endpointId, [report]);
    });
    node.events.eventTriggered.on(({ path: eventPath, events }) => {
      if (eventPath.clusterId !== SWITCH_CLUSTER) return;
      for (const event of events) {
        this.handleSwitchEvent(externalId, eventPath.endpointId, eventPath.eventId, event.data);
      }
    });

    if (!node.isConnected) node.connect();
    if (node.initialized) this.announceNode(externalId, node);
  }

  private announceNode(externalId: string, node: PairedNode): void {
    const endpoints: Array<{
      endpointId: number;
      deviceKind: ReturnType<typeof descriptorFor>['kind'];
      capabilities: ReturnType<typeof descriptorFor>['capabilities'];
      primary: ReturnType<typeof descriptorFor>['primary'];
    }> = [];
    const announced: Endpoint[] = [];
    for (const device of node.getDevices()) {
      const typeIds = device.getDeviceTypes().map((deviceType) => deviceType.code);
      if (isInfrastructureOnly(typeIds)) continue;
      const descriptor = descriptorFor(typeIds);
      endpoints.push({
        endpointId: device.number ?? 0,
        deviceKind: descriptor.kind,
        capabilities: descriptor.capabilities,
        primary: descriptor.primary,
      });
      announced.push(device);
    }
    if (endpoints.length === 0) return;

    const info = node.basicInformation;
    this.bus?.deviceUpserted({
      adapter: 'matter',
      externalId,
      ...(typeof info?.vendorName === 'string' ? { vendor: info.vendorName } : {}),
      ...(typeof info?.productName === 'string' ? { model: info.productName } : {}),
      ...(typeof info?.nodeLabel === 'string' && info.nodeLabel.length > 0
        ? { suggestedName: info.nodeLabel }
        : typeof info?.productName === 'string'
          ? { suggestedName: info.productName }
          : {}),
      endpoints,
    });

    for (const device of announced) {
      this.seedInitialState(externalId, device);
      this.seedSwitchButtons(externalId, device);
    }
  }

  /**
   * Push the node's cached attribute values through the reducer so a device
   * shows real state right after a hub restart or commissioning, instead of
   * an empty card until its first report.
   */
  private seedInitialState(externalId: string, device: Endpoint): void {
    const endpointId = device.number ?? 0;
    const reports: AttributeReport[] = [];
    for (const client of device.getAllClusterClients()) {
      for (const attribute of Object.values(client.attributes)) {
        try {
          const value = attribute.getLocal();
          if (value !== undefined && value !== null) {
            reports.push({ endpointId, clusterId: attribute.clusterId, attributeId: attribute.id, value });
          }
        } catch {
          // Attribute not cached yet — the subscription will deliver it.
        }
      }
    }
    if (reports.length > 0) this.applyReports(externalId, endpointId, reports);
  }

  /**
   * Generic Switch endpoints: derive the button inventory from the Switch
   * cluster's feature map so the apps can render the remote before (and
   * regardless of) the first press.
   */
  private seedSwitchButtons(externalId: string, device: Endpoint): void {
    const client = device.getClusterClientById(ClusterId(SWITCH_CLUSTER));
    if (!client) return;
    const endpointId = device.number ?? 0;
    let featureMap = 0;
    try {
      const raw = client.attributes.featureMap?.getLocal() as Record<string, boolean> | number | undefined;
      if (typeof raw === 'number') featureMap = raw;
      else if (raw && typeof raw === 'object') {
        // matter.js decodes featureMap into named booleans.
        featureMap =
          (raw.momentarySwitch ? SWITCH_FEATURE.momentary : 0) |
          (raw.momentarySwitchRelease ? SWITCH_FEATURE.momentaryRelease : 0) |
          (raw.momentarySwitchLongPress ? SWITCH_FEATURE.momentaryLongPress : 0) |
          (raw.momentarySwitchMultiPress ? SWITCH_FEATURE.momentaryMultiPress : 0);
      }
    } catch {
      // Feature map not cached — fall back to a plain single-press button.
    }
    const multiPress = (featureMap & SWITCH_FEATURE.momentaryMultiPress) !== 0;
    const longPress = (featureMap & SWITCH_FEATURE.momentaryLongPress) !== 0;
    this.switchFeatures.set(`${externalId}/${endpointId}`, { multiPress });

    const gestures = ['single'];
    if (multiPress) gestures.push('double');
    if (longPress) gestures.push('hold');
    this.bus?.stateChanged('matter', externalId, endpointId, {
      event: { buttons: [{ id: 'main', label: 'Button', gestures }] },
    });
  }

  /** Switch cluster events → the canonical event capability. */
  private handleSwitchEvent(externalId: string, endpointId: number, eventId: number, data: unknown): void {
    const features = this.switchFeatures.get(`${externalId}/${endpointId}`);
    let gesture: string | undefined;
    switch (eventId) {
      case SWITCH_EVENT.multiPressComplete: {
        const count = Number((data as { totalNumberOfPressesCounted?: unknown })?.totalNumberOfPressesCounted ?? 1);
        gesture = PRESS_COUNT_GESTURES[count - 1] ?? 'many';
        break;
      }
      case SWITCH_EVENT.shortRelease:
        // With multi-press, MultiPressComplete carries the semantic event.
        if (!features?.multiPress) gesture = 'single';
        break;
      case SWITCH_EVENT.longPress:
        gesture = 'hold';
        break;
      case SWITCH_EVENT.longRelease:
        gesture = 'release';
        break;
      case SWITCH_EVENT.switchLatched:
        gesture = 'single';
        break;
      default:
        return;
    }
    if (!gesture) return;
    this.bus?.stateChanged('matter', externalId, endpointId, {
      event: { action: gesture, button: 'main', gesture, at: Date.now() },
    });
  }

  private applyReports(externalId: string, endpointId: number, reports: AttributeReport[]): void {
    const key = `${externalId}/${endpointId}`;
    const { next, changed } = reduceReports(this.states.get(key), reports);
    if (!changed) return;
    this.states.set(key, next);
    this.bus?.stateChanged('matter', externalId, endpointId, next);
  }
}
