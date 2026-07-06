import path from 'node:path';
import { CommissioningController } from '@project-chip/matter.js';
import { NodeStates, type PairedNode } from '@project-chip/matter.js/device';
import { Environment } from '@matter/main';
import { ManualPairingCodeCodec, NodeId, QrPairingCodeCodec } from '@matter/main/types';
import type { AdapterBus, ProtocolAdapter } from '../adapter.js';
import type { EndpointState, HubCommand } from '../../schema/index.js';
import { descriptorFor, isInfrastructureOnly } from '../../schema/index.js';
import { reduceReports, type AttributeReport } from './reducer.js';
import { executeMatterCommand } from './commands.js';
import type { Logger } from '../../logging.js';

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
 * Requires host networking in Docker: Matter uses site-local UDP (port 5540)
 * and mDNS (5353).
 */
export class MatterAdapter implements ProtocolAdapter {
  readonly id = 'matter' as const;

  private controller: CommissioningController | null = null;
  private bus: AdapterBus | null = null;
  private readonly nodes = new Map<string, PairedNode>();
  /** Working states for the reducer, keyed `${nodeId}/${endpointId}`. */
  private readonly states = new Map<string, EndpointState>();

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
      this.applyReport(externalId, report);
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
  }

  private applyReport(externalId: string, report: AttributeReport): void {
    const key = `${externalId}/${report.endpointId}`;
    const { next, changed } = reduceReports(this.states.get(key), [report]);
    if (!changed) return;
    this.states.set(key, next);
    this.bus?.stateChanged('matter', externalId, report.endpointId, next);
  }
}
