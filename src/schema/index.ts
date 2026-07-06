/**
 * The canonical GetHome device schema.
 *
 * This module is deliberately dependency-free (zod only) and imports nothing
 * from the rest of the hub, so it can later be extracted into a shared
 * package. Everything the ecosystem agrees on lives here: capability kinds,
 * device kinds, endpoint state, command intents, unit conventions, the Matter
 * device-type catalog, and the zod wire schemas.
 */
export * from './capabilities.js';
export * from './kinds.js';
export * from './state.js';
export * from './commands.js';
export * from './units.js';
export * from './catalog.js';
export * from './wire.js';
