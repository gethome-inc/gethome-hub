import { automationCatalog } from '../src/automations/catalog.js';
const s = automationCatalog().schema as any;
console.log('required:', JSON.stringify(s.required));
console.log('version prop:', JSON.stringify(s.properties.version));
console.log('mode prop:', JSON.stringify(s.properties.mode));
console.log('definitions keys:', Object.keys(s.definitions ?? {}));
const text = JSON.stringify(s);
const refs = [...text.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);
console.log('refs:', [...new Set(refs)]);
console.log('has $schema:', '$schema' in s);
// conditions node
console.log('conditions:', JSON.stringify(s.properties.conditions).slice(0, 400));
