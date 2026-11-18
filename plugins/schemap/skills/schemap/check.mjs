// Checks a schema.json with the same code the viewer runs, and optionally writes the page or an export.
//   node check.mjs schema.json                         → summary, or every problem and exit code 1
//   node check.mjs schema.json -o diagram.html         → page to open from disk
//   node check.mjs schema.json -o page.html --artifact → page for a claude.ai artifact (no <!doctype>)
//   node check.mjs schema.json --dbml schema.dbml      → DBML for dbdiagram.io, ChartDB, drawDB
//   node check.mjs schema.json --sql schema.sql        → CREATE TABLE script for draw.io and databases
// Needs only Node 18+: the layout and export code is read out of viewer.html, so there is one copy of it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const USAGE = 'usage: node check.mjs schema.json [-o diagram.html [--artifact]] [--dbml schema.dbml] [--sql schema.sql]';
const options = { '-o': 'out', '--dbml': 'dbml', '--sql': 'sql' };
const args = { schemaFile: null, out: null, dbml: null, sql: null, artifact: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--artifact') args.artifact = true;
  else if (options[argv[i]] && i + 1 < argv.length) args[options[argv[i]]] = argv[++i];
  else if (!argv[i].startsWith('-') && !args.schemaFile) args.schemaFile = argv[i];
  else { console.error(`${USAGE}\nnot understood: ${argv[i]}`); process.exit(2); }
}
if (!args.schemaFile || (args.artifact && !args.out)) { console.error(USAGE); process.exit(2); }

const viewer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'viewer.html'), 'utf8');
const core = viewer.match(/<script id="schemap-core">([\s\S]*?)<\/script>/);
if (!core) throw new Error('viewer.html has no <script id="schemap-core">');
const context = vm.createContext({});
vm.runInContext(core[1], context, { filename: 'viewer.html#schemap-core' });

const text = readFileSync(args.schemaFile, 'utf8');
let summary, schema;
try {
  ({ summary, schema } = context.layoutSchema(JSON.parse(text)));
} catch (error) {
  console.error(`${args.schemaFile}: ${error.message}`);
  process.exit(1);
}
console.log(summary.join('\n'));

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`wrote ${file}`);
}
if (args.out) {
  // "</" inside the JSON would close the <script> early; "<\/" is the same string to JSON.parse
  const schema = text.trim().replace(/<\//g, '<\\/');
  write(args.out, `${args.artifact ? '' : '<!doctype html>\n'}${viewer.trimEnd()}\n<script id="schema" type="application/json">${schema}</script>\n`);
}
if (args.dbml) write(args.dbml, context.schemaToDbml(schema));
if (args.sql) write(args.sql, context.schemaToSql(schema));
