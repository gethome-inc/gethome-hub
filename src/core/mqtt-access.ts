/**
 * The broker facts this module needs, named rather than taken as the whole
 * `HubConfig`: it keeps `ApiDeps` honest about what the route actually reads,
 * and it is what lets a test build one of these without an environment.
 */
export interface MqttBrokerConfig {
  /** What the hub itself dials. Read only for the port. */
  url: string;
  username: string;
  password: string;
  integrationUsername: string;
  integrationPassword: string;
  /** Overrides the address the answer is built from. Usually empty. */
  publicHost: string;
  baseTopic: string;
}

/**
 * What an owner is handed when they want to wire something of their own into
 * this home over MQTT.
 *
 * There are two accounts on the broker and they exist for different reasons,
 * which is the whole of what this module is for: the answer has to be
 * *explainable*, not just correct, because the person reading it is holding a
 * soldering iron and a devboard rather than a threat model.
 *
 * The sentences are the hub's, deliberately — the same rule
 * `ActivityEntry.message` and `GET /permissions` follow. An app one version
 * behind this build still draws a complete, truthful card instead of a row
 * labelled `integrations`, and the two apps cannot describe one broker in two
 * different vocabularies.
 */
export interface MqttAccountWire {
  /** Stable id, so an app can pick an icon or remember a choice. */
  id: 'integrations' | 'hub';
  username: string;
  password: string;
  /** Exactly one account is the recommended one. Apps should lead with it. */
  recommended: boolean;
  title: string;
  summary: string;
  /** Topic filters this account may publish to, in the broker's own syntax. */
  publish: readonly string[];
  /** Topic filters it may subscribe to. */
  subscribe: readonly string[];
}

export interface MqttAccessWire {
  /**
   * Whether the broker asks for a password at all.
   *
   * `false` is a hub whose `install.sh` predates broker passwords: it is still
   * anonymous, and saying so is the only way an app can tell "you have no
   * credentials because none exist" from "you have none because your role
   * withholds them". Absence would read as the second.
   */
  requiresPassword: boolean;
  /** Where an integrator should point their board. */
  host: string;
  port: number;
  /** Zigbee2MQTT's base topic, so an app can print a real example. */
  baseTopic: string;
  /**
   * The accounts this caller may use — never a list with the passwords
   * blanked out. A row somebody cannot act on is a row that reads as broken.
   */
  accounts: readonly MqttAccountWire[];
}

/** Which broker port the hub dials, so the answer never asserts 1883. */
function brokerPort(mqttUrl: string): number {
  try {
    const port = new URL(mqttUrl).port;
    return port ? Number(port) : 1883;
  } catch {
    return 1883;
  }
}

/**
 * Strip the port off a `Host` header, IPv6 literals included.
 *
 * The address the request arrived on is a far better answer than anything
 * this process could work out for itself: a Pi with Wi-Fi and Ethernet has
 * two addresses and no way to rank them, while the one the app just used is
 * by construction one that reaches this machine from where the reader is
 * sitting.
 */
export function hostFromRequest(header: string | undefined): string {
  if (!header) return '';
  if (header.startsWith('[')) return header.slice(0, header.indexOf(']') + 1);
  const colon = header.lastIndexOf(':');
  return colon > 0 ? header.slice(0, colon) : header;
}

export interface MqttAccessOptions {
  config: MqttBrokerConfig;
  /** Where the request came in on — used when `MQTT_PUBLIC_HOST` is unset. */
  requestHost: string;
  /** The caller holds `hub.mqtt`: they may see the integrations account. */
  canUseIntegrations: boolean;
  /** The caller holds `hub.mqtt.admin`: they may see the hub's own account. */
  canUseFullAccess: boolean;
}

/**
 * Assemble the answer for `GET /settings/mqtt`.
 *
 * The ACL these sentences describe is written by `install.sh`, and the two
 * have to stay in step — this is the readable half of one decision made in a
 * shell script, so changing the topic filters there means changing the words
 * here.
 */
export function mqttAccess(options: MqttAccessOptions): MqttAccessWire {
  const { config } = options;
  const accounts: MqttAccountWire[] = [];

  if (options.canUseIntegrations && config.integrationUsername) {
    accounts.push({
      id: 'integrations',
      username: config.integrationUsername,
      password: config.integrationPassword,
      recommended: true,
      title: 'For your own devices',
      summary:
        'Use this one. It can publish your own devices under gethome/, and watch what your ' +
        'Zigbee devices report, but it cannot switch anything on or open the Zigbee network ' +
        'for pairing — so a board you build with it cannot take the home over if it is lost, ' +
        'resold, or reached by somebody else.',
      publish: ['gethome/#'],
      subscribe: [
        'gethome/#',
        `${config.baseTopic}/+`,
        `${config.baseTopic}/bridge/state`,
        `${config.baseTopic}/bridge/event`,
        `${config.baseTopic}/bridge/devices`,
      ],
    });
  }

  if (options.canUseFullAccess && config.username) {
    accounts.push({
      id: 'hub',
      username: config.username,
      password: config.password,
      recommended: false,
      title: 'Full access — the hub’s own account',
      summary:
        'What the hub and Zigbee2MQTT sign in as. It can control every Zigbee device directly ' +
        'and open the network for pairing, so it is worth having when you are debugging and ' +
        'is the wrong thing to leave on a devboard. Nothing you build needs it to read the home.',
      publish: ['#'],
      subscribe: ['#'],
    });
  }

  return {
    requiresPassword: config.username !== '',
    host: config.publicHost || options.requestHost,
    port: brokerPort(config.url),
    baseTopic: config.baseTopic,
    accounts,
  };
}
