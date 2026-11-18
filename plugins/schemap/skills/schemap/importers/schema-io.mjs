// What the importers share: reading quoted and bracketed text, the command line, writing schema.json, the report.
// Node 18+, no packages. The format is checked by the viewer itself (and by check.mjs, which runs the same
// code); the importers only write it.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export const DEFAULT_SCHEMA = 'public';
export const QUOTES = '\'"`';
export const LANGS = ['en', 'ru'];   // interface languages the viewer has
const REPORT_LIMIT = 20;

export function fail(message) {
  console.error('FAILED: ' + message);
  process.exit(1);
}

// ---------- text ----------

/** Splits on sep outside brackets and quotes. brackets: pairs of open/close characters, e.g. '()[]{}'. */
export function splitTop(text, separator = ',', brackets = '()') {
  const opens = [...brackets].filter((_, i) => i % 2 === 0), closes = [...brackets].filter((_, i) => i % 2 === 1);
  const parts = [];
  let depth = 0, buf = '', quote = null;
  for (const ch of text) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (QUOTES.includes(ch)) quote = ch;
    else if (opens.includes(ch)) depth += 1;
    else if (closes.includes(ch)) depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf.trim());
  return parts.filter(Boolean);
}

/** Removes one pair of quotes: '…', "…", `…` or '''…'''. */
export function unquote(text) {
  text = text.trim();
  if (text.startsWith("'''") && text.endsWith("'''") && text.length >= 6) return text.slice(3, -3).trim();
  if (text.length >= 2 && text[0] === text.at(-1) && QUOTES.includes(text[0])) return text.slice(1, -1).replaceAll("\\'", "'");
  return text;
}

/** Lines split on any line break, with no empty line after the last one. */
export function splitLines(text) {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Text with whitespace runs collapsed to one space and the ends trimmed. */
export function squeeze(text) {
  return text.trim().split(/\s+/).filter(Boolean).join(' ');
}

export function tableId(name, schema = null) {
  return `${schema || DEFAULT_SCHEMA}.${name}`;
}

/** One foreign key in schema.json shape; the same key twice is kept once. */
export function addRef(refs, fromTable, fromColumns, toTable, toColumns) {
  const entry = { from: { table: fromTable, columns: [...fromColumns] }, to: { table: toTable, columns: [...toColumns] } };
  const key = JSON.stringify(entry);
  if (!refs.some((ref) => JSON.stringify(ref) === key)) refs.push(entry);
}

// ---------- command line, files, result ----------

/** Positional sources, -o/--output (required), --title, --lang. Prints usage and exits on a mistake. */
export function parseArgs(script, description, sourceHelp, many = false) {
  const usage = `usage: node ${script} ${many ? 'SOURCE [SOURCE …]' : 'SOURCE'} -o schema.json [--title NAME] [--lang ${LANGS.join('|')}]\n`
    + `${description} → schema.json for the schemap viewer\n  SOURCE  ${sourceHelp}`;
  // no --lang: the file has no "lang", and the viewer follows the reader's browser
  const args = { sources: [], output: null, title: 'Database', lang: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { console.log(usage); process.exit(0); }
    const option = { '-o': 'output', '--output': 'output', '--title': 'title', '--lang': 'lang' }[arg];
    if (option) {
      if (i + 1 >= argv.length) { console.error(`${usage}\n${arg} needs a value`); process.exit(2); }
      args[option] = argv[++i];
    } else if (arg.startsWith('-')) {
      console.error(`${usage}\nunknown option ${arg}`); process.exit(2);
    } else args.sources.push(arg);
  }
  const problem = !args.output ? '-o is required'
    : !args.sources.length ? 'no source given'
      : !many && args.sources.length > 1 ? 'one source only'
        : args.lang !== null && !LANGS.includes(args.lang) ? `--lang must be one of ${LANGS.join(', ')}` : null;
  if (problem) { console.error(`${usage}\n${problem}`); process.exit(2); }
  return args;
}

function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

const byParts = (a, b) => {
  const pa = a.split(sep), pb = b.split(sep);
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return pa.length - pb.length;
};

/** Files in name order: each folder contributes its files ending in extension (recursively), each file itself. */
export function collectFiles(paths, extension, skip = () => false) {
  const files = [];
  for (const path of paths) {
    let stat = null;
    try { stat = statSync(path); } catch { fail(`${path} does not exist`); }
    if (stat.isDirectory()) files.push(...walk(path).filter((f) => f.endsWith(extension) && !skip(f)).sort(byParts));
    else files.push(path);
  }
  if (!files.length) fail(`no *${extension} files found`);
  return files;
}

export const readFiles = (files) => files.map((f) => readFileSync(f, 'utf8'));

/** Writes schema.json. modules default: one per schema. */
export function writeSchema(args, tables, refs, modules = null) {
  if (modules === null) modules = [...new Set(tables.map((t) => t.module))].sort().map((code) => ({ code, name: code }));
  const data = { title: args.title, ...(args.lang && { lang: args.lang }), modules, tables, refs };
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, JSON.stringify(data, null, 1));
  return data;
}

/** Prints what was read and every group of things left out, then where the file went. */
export function report(data, files, groups) {
  const sources = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  const columns = data.tables.reduce((sum, t) => sum + t.columns.length, 0);
  console.log(`${sources} → ${data.tables.length} tables, ${columns} columns, ${data.refs.length} references, `
    + `modules ${data.modules.map((m) => m.code).join(', ')}`);
  for (const [title, items] of groups) {
    if (!items.length) continue;
    console.log(`${title}: ${items.length}`);
    for (const item of items.slice(0, REPORT_LIMIT)) console.log('  ' + item);
    if (items.length > REPORT_LIMIT) console.log(`  … and ${items.length - REPORT_LIMIT} more`);
  }
}
