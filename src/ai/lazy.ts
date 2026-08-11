import type { Db } from '../db/client.js';
import type { SettingsService } from '../core/settings.js';
import type { AiRunLog } from '../core/ai-runs.js';
import type { Logger } from '../logging.js';
import type { AppliedAiMapping, ZigbeeAiAssist } from '../adapters/zigbee/adapter.js';
import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';

export interface LazyAiAssistOptions {
  db: Db;
  settings: SettingsService;
  log: Logger;
  /** Where each run is recorded and streamed from. */
  runs?: AiRunLog;
}

/**
 * A `ZigbeeAiAssist` that doesn't load the AI stack until it is actually going
 * to use it.
 *
 * This mattered enormously when `AiDeviceMapper` pulled in the Claude Agent
 * SDK — 46 MB of resident memory on import, for a stack that does nothing at
 * all without a credential, on a board that has ~76 MB of headroom. The
 * Anthropic SDK it now uses is small enough that the saving is modest, but the
 * seam is worth keeping for its second property: the credential check runs on
 * every call, so a key added through the API later starts working without a
 * restart, and a hub with no key never constructs an API client at all.
 */
export function lazyAiAssist(options: LazyAiAssistOptions): ZigbeeAiAssist {
  let mapper: ZigbeeAiAssist | null = null;

  return {
    async requestMapping(
      device: Z2mDevice,
      staticProfile: Z2mProfile,
      requestOptions?: { samples?: Record<string, unknown>[]; force?: boolean },
    ): Promise<AppliedAiMapping | null> {
      // Read every call, not once: this is what makes a key added through the
      // API work without a restart, and what makes the owner's switch take
      // effect the moment they flip it. Two gates, and neither is redundant —
      // a hub with no key must never construct an API client, and a hub whose
      // owner has turned adaptation off must not run the agent even though
      // the credential is still there.
      const configured = await options.settings.getAiSettings();
      if (!configured.hasKey || !configured.enabled) return null;
      if (!mapper) {
        const { AiDeviceMapper } = await import('./mapper.js');
        mapper = new AiDeviceMapper(options.db, options.settings, options.log, options.runs);
      }
      return mapper.requestMapping(device, staticProfile, requestOptions);
    },
  };
}
