import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Z2mDevice, Z2mProfile } from '../adapters/zigbee/exposes-mapper.js';
import { STATE_PATHS, mappingDescriptorSchema } from './descriptor.js';

/**
 * The research workspace an agent run gets as its working directory. The
 * agent's file tools (Read/Glob/Grep) are read-only and its cwd is this
 * directory, so everything it can see is written here by the hub — nothing
 * else on the machine is reachable.
 */
export interface AgentContext {
  dir: string;
  cleanup(): void;
}

/**
 * Stable home for the Claude Code runtime (CLAUDE_CONFIG_DIR). Keeping it
 * inside DATA_DIR means launchd/Docker deployments never touch the service
 * user's $HOME and everything the runtime writes lives with the hub's data.
 */
export function ensureAgentHome(dataDir: string): string {
  const home = path.resolve(dataDir, 'claude-agent');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * Write the per-run research files. Contents are exactly the data the
 * privacy contract allows off the machine: the device's published schema,
 * recent payloads of that device, and the hub's own static mapping of it.
 */
export function buildAgentContext(
  dataDir: string,
  exposesHash: string,
  device: Z2mDevice,
  staticProfile: Z2mProfile | null,
  samples: Record<string, unknown>[],
): AgentContext {
  const dir = path.resolve(dataDir, 'ai-agent', `ctx-${exposesHash.slice(0, 8)}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileSync(
    path.join(dir, 'device.json'),
    JSON.stringify(
      {
        vendor: device.definition?.vendor ?? null,
        model: device.definition?.model ?? null,
        description: device.definition?.description ?? null,
        supportedByZigbee2mqtt: device.supported !== false,
        exposes: device.definition?.exposes ?? [],
      },
      null,
      2,
    ),
  );

  writeFileSync(path.join(dir, 'samples.json'), JSON.stringify(samples, null, 2));

  if (staticProfile) {
    const fielded = staticProfile.unmapped.filter((property) => !staticProfile.uncovered.includes(property));
    writeFileSync(
      path.join(dir, 'static-mapping.json'),
      JSON.stringify(
        {
          endpoints: staticProfile.endpoints.map((endpoint) => ({
            endpointId: endpoint.endpointId,
            ...(endpoint.label !== undefined ? { label: endpoint.label } : {}),
            kind: endpoint.kind,
            capabilities: endpoint.capabilities,
            primary: endpoint.primary,
            ...(endpoint.customFields !== undefined ? { customFields: endpoint.customFields } : {}),
          })),
          genericCustomFields: fielded,
          uncovered: staticProfile.uncovered,
          unmapped: staticProfile.unmapped,
        },
        null,
        2,
      ),
    );
  }

  writeFileSync(path.join(dir, 'schema-reference.md'), schemaReference());

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Generated from the live descriptor schema so it can never drift from the code. */
function schemaReference(): string {
  const jsonSchema = z.toJSONSchema(mappingDescriptorSchema, { target: 'draft-7' });
  const paths = Object.keys(STATE_PATHS)
    .map((statePath) => `- \`${statePath}\``)
    .join('\n');
  return [
    '# MappingDescriptor reference',
    '',
    'The exact JSON schema your `submit_mapping` tool call must satisfy',
    '(the same schema is enforced when you submit):',
    '',
    '```json',
    JSON.stringify(jsonSchema, null, 2),
    '```',
    '',
    '## Whitelisted canonical state paths',
    '',
    'A `stateRules[].to` value must be one of:',
    '',
    paths,
    '',
    'Unit semantics and worked examples are in your system prompt.',
    '',
  ].join('\n');
}
