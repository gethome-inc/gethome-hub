import type { Environment } from '@matter/main';

/** matter.js's own level names — `LogLevel.names`, less `notice`, which no hub level maps to. */
export type MatterLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * The level matter.js logs at, given the level the hub's own logger is at.
 *
 * matter.js starts at **debug** and nothing used to change that, so a hub at
 * `LOG_LEVEL=info` wrote every matter.js debug line to the journal. Measured on
 * the hub this was found on (a Zero 2 W, one Matter plug reporting its power,
 * three Zigbee devices): 3,517 journal lines in ten minutes, 3,468 of them
 * matter.js debug — `MessageExchange`, `MessageChannel` and `PairedNode`'s
 * "Trigger attribute update" — and about 1 MB of message text, roughly
 * 150 MB a day before journald's own overhead. The 64 MB persistent journal,
 * which exists so a hub can be diagnosed after the fact, held about an hour.
 *
 * So matter.js follows the hub: debug only when the hub is at `debug` or
 * `trace`, and the hub's own level otherwise. matter.js has no `trace`, and
 * `notice` (between info and warn) needs no hub level of its own: at `info` it
 * is shown, and at `warn` it is not, which is where it belongs either way.
 * Anything this does not recognise is the hub's default, `info`, rather than
 * a guess in either direction; `silent` is matter.js's quietest, since it has
 * no level that says nothing at all.
 */
export function matterLogLevel(hubLevel: string | undefined): MatterLogLevel {
  switch (hubLevel) {
    case 'trace':
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    case 'fatal':
    case 'silent':
      return 'fatal';
    default:
      return 'info';
  }
}

/**
 * Point matter.js at the hub's level, through the environment it runs in.
 *
 * Through matter.js's own `log.level` variable rather than by assigning
 * `Logger.level`, because the variable is what matter.js itself reads: when
 * its Node.js environment becomes the default it registers a configurator
 * that writes `Logger.level` from `log.level` — which `MATTER_LOG_LEVEL` and a
 * `config.json` can also set — and runs it again whenever a `log.*` variable
 * changes. An assignment holds only until the next such run; the variable is
 * the answer that run gives. Setting it runs the configurator at once, so this
 * takes effect before it returns.
 *
 * Call it before anything else touches matter.js: importing `@matter/main`
 * logs nothing (measured on 0.17.9), so the first line it writes comes from
 * whatever runs next.
 */
export function applyMatterLogLevel(environment: Environment, hubLevel: string | undefined): MatterLogLevel {
  const level = matterLogLevel(hubLevel);
  environment.vars.set('log.level', level);
  return level;
}
