import path from 'node:path';
import { CommissioningController } from '@project-chip/matter.js';
import { NodeStates, type Endpoint, type PairedNode } from '@project-chip/matter.js/device';
import { Environment } from '@matter/main';
import { ClusterId, ManualPairingCodeCodec, NodeId, QrPairingCodeCodec } from '@matter/main/types';
import type { AdapterBus, ProtocolAdapter } from '../adapter.js';
import type { EndpointState, HubCommand } from '../../schema/index.js';
import { descriptorFor, isInfrastructureOnly } from '../../schema/index.js';
import { reduceReports, type AttributeReport } from './reducer.js';
import { executeMatterCommand } from './commands.js';
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

export interface MatterAdapterOptions {
  dataDir: string;
  log: Logger;
}

/**
 * Matter controller on the hub's own fabric, built on matter.js. Devices are
 * commissioned over IP (a device already on the network — Wi-Fi provisioned
 * by a phone, Ethernet, or shared via multi-admin). BLE-assisted
 * commissioning is a documented follow-up (docs/matter.md).
 *
 * Needs the host's own network: Matter is site-local UDP (port 5540) plus
 * mDNS (5353), neither of which survives being NAT-ed. The hub runs directly
 * on the host — a systemd unit on Linux, a launchd agent on macOS — so this
 * costs nothing to arrange and is one of the reasons it isn't containerised.
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

  constructor(private readonly options: MatterAdapterOptions) {}

  async start(bus: AdapterBus): Promise<void> {
    this.bus = bus;
    const environment = Environment.default;
    environment.vars.set('storage.path', path.join(this.options.dataDir, 'matter'));

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
   * the node id once the device is attached.
   */
  async commission(pairingCode: string): Promise<string> {
    if (!this.controller) throw new Error('Matter controller is not running');

    const trimmed = pairingCode.trim();
    let passcode: number;
    let shortDiscriminator: number | undefined;
    let longDiscriminator: number | undefined;
    if (trimmed.startsWith('MT:')) {
      const payload = QrPairingCodeCodec.decode(trimmed)[0];
      if (!payload) throw new Error('Invalid QR pairing code');
      passcode = payload.passcode;
      longDiscriminator = payload.discriminator;
    } else {
      const payload = ManualPairingCodeCodec.decode(trimmed.replace(/[^0-9]/g, ''));
      passcode = payload.passcode;
      shortDiscriminator = payload.shortDiscriminator;
    }

    const nodeId = await this.controller.commissionNode({
      commissioning: {},
      discovery: {
        identifierData:
          longDiscriminator !== undefined
            ? { longDiscriminator }
            : shortDiscriminator !== undefined
              ? { shortDiscriminator }
              : {},
        discoveryCapabilities: { onIpNetwork: true },
      },
      passcode,
    });
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

  // ── Internals ───────────────────────────────────────────────────────────

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
