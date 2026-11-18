#!/usr/bin/env node
// Checks a schema.json with the same code the viewer runs, and optionally builds the page.
//   node check.mjs schema.json                       → summary, or every problem and exit code 1
//   node check.mjs schema.json -o diagram.html       → page to open from disk
//   node check.mjs schema.json -o page.html --artifact → page for a claude.ai artifact (no <!doctype>)
// Needs only Node 18+: the layout code is read out of viewer.html, so there is one copy of it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const args = process.argv.slice(2);
const artifact = args.includes('--artifact');
const outIndex = args.indexOf('-o');
const out = outIndex >= 0 ? args[outIndex + 1] : null;
const schemaFile = args.find((arg, i) => !arg.startsWith('-') && (outIndex < 0 || i !== outIndex + 1));
if (!schemaFile || (outIndex >= 0 && !out)) {
  console.error('usage: node check.mjs schema.json [-o diagram.html] [--artifact]');
  process.exit(2);
}

const viewer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'viewer.html'), 'utf8');
const core = viewer.match(/<script id="schemap-core">([\s\S]*?)<\/script>/);
if (!core) throw new Error('viewer.html has no <script id="schemap-core">');
const context = vm.createContext({});
vm.runInContext(core[1], context, { filename: 'viewer.html#schemap-core' });

const text = readFileSync(schemaFile, 'utf8');
let summary;
try {
  ({ summary } = context.layoutSchema(JSON.parse(text)));
} catch (error) {
  console.error(`${schemaFile}: ${error.message}`);
  process.exit(1);
}
console.log(summary.join('\n'));

if (out) {
  // "</" inside the JSON would close the <script> early; "<\/" is the same string to JSON.parse
  const schema = text.trim().replace(/<\//g, '<\\/');
  const page = `${artifact ? '' : '<!doctype html>\n'}${viewer.trimEnd()}\n<script id="schema" type="application/json">${schema}</script>\n`;
  writeFileSync(out, page);
  console.log(`wrote ${out}`);
}
