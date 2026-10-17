import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdapterBus } from '../src/adapters/adapter.js';
import {
  applyMatterLogLevel,
  matterLogLevel,
  type MatterLogLevel,
} from '../src/adapters/matter/log-level.js';
import { loadConfig, type HubConfig } from '../src/config.js';

// The adapter test below builds no real controller: it only needs to know
// what level matter.js was at by the time `start()` got that far.
const controller = vi.hoisted(() => ({ levelWhenBuilt: undefined as unknown }));
vi.mock('@project-chip/matter.js', async () => {
  const { Logger } = await import('@matter/main');
  return {
    CommissioningController: class {
      constructor() {
        controller.levelWhenBuilt = Logger.level;
      }
      start(): Promise<void> {
        return Promise.reject(new Error('no controller in this test'));
      }
    },
  };
});

/**
 * Every level the hub accepts, and what matter.js runs at under it. Typed
 * against the config's own enum, so a level added there fails the type check
 * here until somebody decides what matter.js does with it.
 */
const UNDER_HUB_LEVEL: Record<HubConfig['LOG_LEVEL'], MatterLogLevel> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

describe('matterLogLevel', () => {
  it.each(Object.entries(UNDER_HUB_LEVEL))('runs matter.js at %s → %s', (hub, matter) => {
    expect(matterLogLevel(hub)).toBe(matter);
  });

  it('is info on a hub that never set LOG_LEVEL', () => {
    expect(matterLogLevel(loadConfig({}).LOG_LEVEL)).toBe('info');
  });

  it('falls back to info for a level it does not know, and to fatal for silent', () => {
    expect(matterLogLevel(undefined)).toBe('info');
    expect(matterLogLevel('verbose')).toBe('info');
    expect(matterLogLevel('fatal')).toBe('fatal');
    expect(matterLogLevel('silent')).toBe('fatal');
  });
});

describe('matter.js at the hub level', () => {
  const FACILITY = 'GetHomeLogLevelProbe';
  let matter: typeof import('@matter/main');
  let originalDestination: import('@matter/main').LogDestination;
  const reached: string[] = [];

  beforeAll(async () => {
    matter = await import('@matter/main');
    // Stand in for the console, so what matter.js would have written to the
    // journal is something the test can read and the test output stays quiet.
    originalDestination = matter.Logger.destinations.default!;
    matter.Logger.destinations.default = matter.LogDestination({
      name: 'default',
      add: (message) => {
        if (message.facility === FACILITY) reached.push(matter.LogLevel.names[message.level]!);
      },
    });
  });

  afterAll(() => {
    if (matter) matter.Logger.destinations.default = originalDestination;
  });

  /** Log one line at each matter.js level and say which reached the journal. */
  function journalled(): string[] {
    reached.length = 0;
    const logger = matter.Logger.get(FACILITY);
    logger.debug('debug');
    logger.info('info');
    logger.notice('notice');
    logger.warn('warn');
    logger.error('error');
    return [...reached];
  }

  it("drops matter.js's debug lines at the hub's default and keeps everything above them", () => {
    applyMatterLogLevel(matter.Environment.default, 'info');
    expect(journalled()).toEqual(['info', 'notice', 'warn', 'error']);
  });

  it('keeps warnings and errors at warn, and errors at error', () => {
    applyMatterLogLevel(matter.Environment.default, 'warn');
    expect(journalled()).toEqual(['warn', 'error']);
    applyMatterLogLevel(matter.Environment.default, 'error');
    expect(journalled()).toEqual(['error']);
  });

  it('writes debug again when the hub is at debug or trace', () => {
    applyMatterLogLevel(matter.Environment.default, 'debug');
    expect(journalled()).toEqual(['debug', 'info', 'notice', 'warn', 'error']);
    applyMatterLogLevel(matter.Environment.default, 'info');
    applyMatterLogLevel(matter.Environment.default, 'trace');
    expect(journalled()).toContain('debug');
  });

  it("takes precedence over a level from matter.js's own variables, and holds when they are read again", () => {
    const vars = matter.Environment.default.vars;
    // What `MATTER_LOG_LEVEL=debug` or a `config.json` would have left behind.
    vars.set('log.level', 'debug');
    expect(journalled()).toContain('debug');

    applyMatterLogLevel(matter.Environment.default, 'info');
    expect(journalled()).not.toContain('debug');

    // Any `log.*` change makes matter.js re-run the configurator that writes
    // `Logger.level` from `log.level`. Assigning `Logger.level` would have been
    // undone here and debug would be back; the variable is what it re-reads.
    vars.set('log.format', matter.Logger.format);
    expect(journalled()).toEqual(['info', 'notice', 'warn', 'error']);
  });

  it("is applied by the adapter, from its own logger's level, before it builds a controller", async () => {
    const { MatterAdapter } = await import('../src/adapters/matter/adapter.js');
    const sink = { write: () => undefined };
    for (const [hub, expected] of [
      ['warn', 'warn'],
      ['debug', 'debug'],
      ['info', 'info'],
    ] as const) {
      controller.levelWhenBuilt = undefined;
      const adapter = new MatterAdapter({ dataDir: '/nonexistent/gethome-test', log: pino({ level: hub }, sink) });
      await expect(adapter.start({} as AdapterBus)).rejects.toThrow('no controller in this test');
      expect(controller.levelWhenBuilt).toBe(matter.LogLevel(expected));
    }
  });
});
