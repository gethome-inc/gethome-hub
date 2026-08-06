import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CiaoService, Responder } from '@homebridge/ciao';
import type { Logger } from '../logging.js';

export type MdnsBackend = 'auto' | 'avahi' | 'ciao' | 'off';

export interface MdnsOptions {
  hubId: string;
  hubName: string;
  port: number;
  version: string;
  backend: MdnsBackend;
  /** Directory avahi watches for static service files. */
  servicesDir: string;
  log: Logger;
}

/**
 * Advertises the hub on the LAN as `_gethome._tcp` so the GetHome apps can
 * discover it (they browse with NWBrowser). TXT records carry the identity the
 * apps need before they ever talk HTTP.
 *
 * **Two backends, and picking the right one is a bug fix, not a preference.**
 * `@homebridge/ciao` is a complete mDNS responder: it binds UDP 5353 and, to
 * give its service a target, publishes an A record for `os.hostname()`. On a
 * Raspberry Pi that name — `raspberrypi.local` — already belongs to
 * avahi-daemon. Two responders claiming one name is an mDNS conflict, and the
 * protocol settles it by making somebody rename themselves. Which one lost
 * depended on start order, so a Pi answered to `raspberrypi.local` right after
 * an install (avahi long up, ciao yielding) and stopped answering after a power
 * cut (the hub starting first, avahi renaming itself to `raspberrypi-2`). The
 * symptom was a machine that kept its IP address and lost its name.
 *
 * So where avahi exists, we hand it the service instead of competing with it: a
 * static service file in its watched directory, which it picks up and drops
 * without a reload, and which costs no memory in this process. `ciao` remains
 * for machines with no system responder.
 */
export class MdnsAdvertiser {
  private responder: Responder | null = null;
  private service: CiaoService | null = null;
  private avahiFile: string | null = null;
  private resolved: Exclude<MdnsBackend, 'auto'> = 'off';

  constructor(private readonly options: MdnsOptions) {}

  async start(claimed: boolean): Promise<void> {
    this.resolved = this.chooseBackend();
    if (this.resolved === 'off') {
      this.options.log.info('mDNS advertisement disabled; the apps can still connect by address.');
      return;
    }
    if (this.resolved === 'avahi') {
      this.writeAvahiService(claimed);
      this.options.log.info(
        `Advertising _gethome._tcp on port ${this.options.port} through avahi (${this.avahiFile}).`,
      );
      return;
    }
    const { getResponder, Protocol } = await import('@homebridge/ciao');
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
    try {
      if (this.resolved === 'avahi' && this.avahiFile) {
        this.writeAvahiService(claimed);
      } else {
        this.service?.updateTxt(this.txt(claimed));
      }
    } catch (error) {
      this.options.log.warn({ err: error }, 'Could not re-publish the mDNS claim state.');
    }
  }

  async stop(): Promise<void> {
    if (this.avahiFile) {
      // Leave nothing behind claiming a hub that isn't running.
      rmSync(this.avahiFile, { force: true });
      this.avahiFile = null;
    }
    await this.service?.end();
    await this.responder?.shutdown();
    this.service = null;
    this.responder = null;
  }

  private chooseBackend(): Exclude<MdnsBackend, 'auto'> {
    if (this.options.backend !== 'auto') return this.options.backend;
    return existsSync(this.options.servicesDir) ? 'avahi' : 'ciao';
  }

  private writeAvahiService(claimed: boolean): void {
    const file = path.join(this.options.servicesDir, 'gethome-hub.service');
    mkdirSync(this.options.servicesDir, { recursive: true });
    const txt = this.txt(claimed);
    const records = Object.entries(txt)
      .map(([key, value]) => `    <txt-record>${key}=${escapeXml(value)}</txt-record>`)
      .join('\n');
    writeFileSync(
      file,
      `<?xml version="1.0" standalone='no'?><!--*-nxml-*-->
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!-- Written by the GetHome Hub. Edits are overwritten on every start. -->
<service-group>
  <name replace-wildcards="yes">${escapeXml(this.options.hubName)}</name>
  <service>
    <type>_gethome._tcp</type>
    <port>${this.options.port}</port>
${records}
  </service>
</service-group>
`,
      { mode: 0o644 },
    );
    this.avahiFile = file;
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
