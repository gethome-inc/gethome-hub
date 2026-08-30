/**
 * Signing in to the hub's own MQTT broker.
 *
 * Lives at the root of `src/` rather than in `core/` because all three
 * clients that need it are adapters, and adapters see the `AdapterBus` and
 * the two dependency-free modules beside it — `logging.ts`, `config.ts` — and
 * nothing else. A helper this small is not worth a hole in that boundary.
 */

export interface BrokerCredentials {
  /**
   * Empty means the broker takes anonymous connections, which is what every
   * hub installed before `install.sh` started minting passwords still has.
   * That is a state to connect in, not a state to fail in: the drop-in on
   * such a machine says `allow_anonymous true`, and a hub that refused to
   * talk to its own broker over a missing password would take Zigbee down to
   * make a point.
   */
  username?: string;
  password?: string;
}

/**
 * The `username`/`password` half of an mqtt.js options object, or nothing.
 *
 * Built as a spread rather than as two possibly-undefined fields because
 * `exactOptionalPropertyTypes` is on and mqtt.js reads `'username' in opts`
 * in places — an explicit `username: undefined` is not the same as an absent
 * one, and the difference is a broker refusing a connection.
 */
export function brokerCredentials(source: BrokerCredentials): BrokerCredentials {
  if (!source.username) return {};
  return { username: source.username, ...(source.password ? { password: source.password } : {}) };
}
