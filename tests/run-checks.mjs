// Self-check of the plugin: the three importers read the same shop identically, and every result builds.
//   node tests/run-checks.mjs
// Exit code 0 when everything agrees. Writes nothing outside a temporary folder. Node 18+.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, 'plugins', 'schemap', 'skills', 'schemap');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const IMPORTERS = { sql: 'shop.sql', prisma: 'shop.prisma', dbml: 'shop.dbml' };
const EXPECT = { tables: 9, columns: 34, refs: 9, modules: 3 };

function run(script, ...args) {
  try {
    return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    console.error(`FAILED: ${[script, ...args].join(' ')}\n${error.stdout}${error.stderr}`);
    process.exit(1);
  }
}

/** What must match across importers: tables, columns with key and nullability, references. */
function shape(schema) {
  const sorted = (items) => JSON.stringify([...items].sort());
  return {
    tables: sorted(schema.tables.map((t) => t.id)),
    columns: sorted(schema.tables.flatMap((t) => t.columns.map((c) => `${t.id}.${c.name} pk=${c.pk} null=${c.nullable}`))),
    refs: sorted(schema.refs.map((r) => `${r.from.table}(${r.from.columns}) → ${r.to.table}(${r.to.columns})`)),
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'schemap-checks-'));
const failures = [], shapes = {};
try {
  for (const [kind, fixture] of Object.entries(IMPORTERS)) {
    const out = join(tmp, `${kind}.json`);
    run(join(SKILL, 'importers', `import-${kind}.mjs`), join(FIXTURES, fixture), '-o', out, '--title', 'Shop');
    const schema = JSON.parse(readFileSync(out, 'utf8'));
    const got = { tables: schema.tables.length, columns: schema.tables.reduce((sum, t) => sum + t.columns.length, 0),
      refs: schema.refs.length, modules: schema.modules.length };
    if (JSON.stringify(got) !== JSON.stringify(EXPECT)) failures.push(`${kind}: ${JSON.stringify(got)}, expected ${JSON.stringify(EXPECT)}`);
    shapes[kind] = shape(schema);
    run(join(SKILL, 'check.mjs'), out, '-o', join(tmp, `${kind}.html`));
    run(join(SKILL, 'check.mjs'), out, '-o', join(tmp, `${kind}.artifact.html`), '--artifact');
  }
  for (const [kind, value] of Object.entries(shapes)) {
    for (const part of Object.keys(value)) {
      if (value[part] !== shapes.sql[part]) failures.push(`${kind} differs from sql in ${part}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error('FAILED:\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`ok: ${Object.keys(IMPORTERS).join(', ')} agree on ${JSON.stringify(EXPECT)}; all built as a file and as an artifact page`);
