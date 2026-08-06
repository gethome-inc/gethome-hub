import type { Db } from '../db/client.js';
import type { SettingsService } from '../core/settings.js';
import type { Logger } from '../logging.js';
import type { AppliedAiMapping, ZigbeeAiAssist } from '../adapters/zigbee/adapter.js';
import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';

export interface LazyAiAssistOptions {
  db: Db;
  settings: SettingsService;
  log: Logger;
  dataDir: string;
}

/**
 * A `ZigbeeAiAssist` that doesn't load the AI stack until it is actually going
 * to use it.
 *
 * `AiDeviceMapper` pulls in `@anthropic-ai/claude-agent-sdk`, which is the
 * second-largest thing in the dependency graph and does nothing at all without
 * a credential — and the hub ships with no credential, so on a 512 MB board the
 * common case was paying for it in memory forever and never running it. The
 * import happens on the first device that needs a mapping *and* only when a key
 * has been configured; the check is re-done every call, so a key added through
 * the API later still works without a restart.
 */
export function lazyAiAssist(options: LazyAiAssistOptions): ZigbeeAiAssist {
  let mapper: ZigbeeAiAssist | null = null;

  return {
    async requestMapping(
      device: Z2mDevice,
      staticProfile: Z2mProfile,
      requestOptions?: { samples?: Record<string, unknown>[]; force?: boolean },
    ): Promise<AppliedAiMapping | null> {
      if (!mapper) {
        const configured = await options.settings.getAiSettings();
        if (!configured.hasKey) return null;
        const { AiDeviceMapper } = await import('./mapper.js');
        mapper = new AiDeviceMapper(options.db, options.settings, options.log, {
          dataDir: options.dataDir,
        });
      }
      return mapper.requestMapping(device, staticProfile, requestOptions);
    },
  };
}
