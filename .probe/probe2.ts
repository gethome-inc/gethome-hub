import { automationCatalog, catalogAsPrompt } from '../src/automations/catalog.js';
import { COMMAND_TYPES } from '../src/schema/commands.js';

const cat = automationCatalog();
console.log('catalog built ok; schema keys:', Object.keys(cat.schema).join(','));
console.log('paths:', cat.paths.length, 'commands:', cat.commands.length);
const catCmds = new Set(cat.commands.map((c) => c.id));
console.log('commands missing from catalog:', COMMAND_TYPES.filter((t) => !catCmds.has(t)));
console.log('paths with no unit:', cat.paths.filter((p) => p.unit === undefined).map((p) => p.id));
console.log('paths with summary === id:', cat.paths.filter((p) => p.summary === p.id).map((p) => p.id));
console.log('continuous:', cat.paths.filter((p) => p.continuous).map((p) => p.id));
console.log('--- prompt length', catalogAsPrompt().length);
console.log('--- schema json length', JSON.stringify(cat.schema).length);
