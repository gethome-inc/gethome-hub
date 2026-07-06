import { getResponder, Protocol, type CiaoService, type Responder } from '@homebridge/ciao';
import type { Logger } from '../logging.js';

/**
 * Advertises the hub on the LAN as `_gethome._tcp` so the GetHome apps can
 * discover it (they browse with NWBrowser). TXT records carry the identity
 * the apps need before they ever talk HTTP.
 */
export class MdnsAdvertiser {
  private responder: Responder | null = null;
  private service: CiaoService | null = null;

  constructor(
    private readonly options: {
      hubId: string;
      hubName: string;
      port: number;
      version: string;
      log: Logger;
    },
  ) {}

  async start(claimed: boolean): Promise<void> {
    this.responder = getResponder();
    this.service = this.responder.createService({
      name: this.options.hubName,
      type: 'gethome',
      protocol: Protocol.TCP,
      port: this.options.port,
      txt: this.txt(claimed),
    });
    await this.service.advertise();
    this.options.log.info(`Advertising _gethome._tcp on port ${this.options.port}.`);
  }

  /** Re-publish TXT when the claim state changes. */
  updateClaimed(claimed: boolean): void {
    this.service?.updateTxt(this.txt(claimed));
  }

  async stop(): Promise<void> {
    await this.service?.end();
    await this.responder?.shutdown();
    this.service = null;
    this.responder = null;
  }

  private txt(claimed: boolean): Record<string, string> {
    return {
      id: this.options.hubId,
      ver: this.options.version,
      api: '1',
      claimed: claimed ? '1' : '0',
    };
  }
}
