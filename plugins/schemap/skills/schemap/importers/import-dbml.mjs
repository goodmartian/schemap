// DBML (dbdiagram.io format) → schema.json. Node 18+, no packages.
//
//   node import-dbml.mjs schema.dbml -o schema.json [--title Shop] [--lang ru]
//
// Reads Table (columns, settings, indexes with [pk], Note), Ref (one-line, block, inline ref: > …),
// TableGroup (becomes a module; its note becomes the module name). Table notes and column notes become notes.
// Tables in no group go to a module named after their schema ("public" when there is none).
// Enum, Project, Note, Records and TablePartial blocks are skipped; many-to-many refs (<>) are reported, not drawn.
import {
  QUOTES, addRef, collectFiles, parseArgs, readFiles, report, splitLines, splitTop, tableId, unquote, writeSchema,
} from './schema-io.mjs';

const BRACKETS = '()[]{}';
const WORD = '[\\p{L}\\p{N}_$]+';
const NOTE_TEXT = String.raw`('''.*?'''|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;   // '…', "…" or '''…'''
const NOTE_START = /^\s*note\s*[:{]/i;

function stripComments(text) {
  let out = '', i = 0;
  const n = text.length;
  while (i < n) {
    if (text.startsWith("'''", i)) {   // multi-line string
      const close = text.indexOf("'''", i + 3), end = close < 0 ? n : close + 3;
      out += text.slice(i, end); i = end; continue;
    }
    const ch = text[i];
    if (QUOTES.includes(ch)) {
      let end = i + 1;
      while (end < n && text[end] !== ch) end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1); i = end + 1; continue;
    }
    if (text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) i = n; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    out += ch; i += 1;
  }
  return out;
}

/** Top-level blocks: [keyword, header, body]. Ref one-liners come back with body null. */
function* blocks(text) {
  const n = text.length, word = /\s*([A-Za-z_]+)\b/y;
  let i = 0;
  while (i < n) {
    word.lastIndex = i;
    const m = word.exec(text);
    if (!m) break;
    const keyword = m[1], after = m.index + m[0].length;
    const brace = text.indexOf('{', after);
    let newline = text.indexOf('\n', after);
    if (newline < 0) newline = n;
    // one-line Ref: no brace on its line, or the relation itself stands before the brace
    if (keyword.toLowerCase() === 'ref' && (brace < 0 || brace > newline || /<>|<|>|\s-\s/.test(text.slice(after, brace)))) {
      yield [keyword, text.slice(after, newline), null];
      i = newline + 1;
      continue;
    }
    if (brace < 0) break;
    let depth = 0, j = brace, quote = null;
    while (j < n) {
      const ch = text[j];
      if (quote) {
        if (text.startsWith("'''", j) && quote === "'''") { quote = null; j += 3; continue; }
        if (quote !== "'''" && ch === '\\') { j += 2; continue; }   // \' inside a string does not close it
        if (quote !== "'''" && ch === quote) quote = null;
        j += 1; continue;
      }
      if (text.startsWith("'''", j)) { quote = "'''"; j += 3; continue; }
      if (QUOTES.includes(ch)) quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) break; }
      j += 1;
    }
    yield [keyword, text.slice(after, brace), text.slice(brace + 1, j)];
    i = j + 1;
  }
}

/** "[pk, not null, note: '…', ref: > a.b]" → list of [key, value or null]. */
function settings(text) {
  const m = /\[([\s\S]*)\]\s*$/.exec(text);
  if (!m) return [];
  return splitTop(m[1], ',', BRACKETS, true).map((part) => {
    const colon = part.indexOf(':');
    return colon < 0 ? [part.trim().toLowerCase(), null]
      : [part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()];
  });
}

/** 'schema.table', 'table' or an alias → table id. */
function resolveTable(text, aliases) {
  const parts = splitTop(text, '.').map(unquote), name = parts.join('.');
  if (aliases.has(name)) return aliases.get(name);
  return tableId(parts.at(-1), parts.length === 2 ? parts[0] : null);
}

/** 'schema.table.col', 'table.col', 'table.(a, b)' → [table id, [columns]]. */
function endpoint(text, aliases) {
  text = text.trim();
  const m = /^(.+)\.\(([^)]*)\)$/.exec(text);
  let table, cols;
  if (m) [table, cols] = [m[1], splitTop(m[2]).map(unquote)];
  else {
    const dot = text.lastIndexOf('.');
    [table, cols] = [dot < 0 ? '' : text.slice(0, dot), [unquote(text.slice(dot + 1))]];
  }
  return [resolveTable(table, aliases), cols];
}

function parse(text) {
  text = stripComments(text);
  const tables = new Map(), refs = [], groups = [], skipped = [], aliases = new Map(), pending = [];

  function queueRef(line, inlineFrom = null) {   // resolved after every table and alias is known
    let op, left, right;
    if (inlineFrom) {
      const m2 = /^\s*(<>|<|>|-)\s*(.+?)\s*$/.exec(line);
      if (!m2) { skipped.push(`inline ref: ${line.trim()}`); return; }
      [op, left, right] = [m2[1], inlineFrom, m2[2]];
    } else {
      const m = /^\s*(?:([^:\s]+)\s*)?:?\s*([\s\S]+?)\s*(<>|<|>|-)\s*([\s\S]+?)\s*(\[[\s\S]*\])?\s*$/.exec(line);
      if (!m) { skipped.push(`ref: ${line.trim()}`); return; }
      [op, left, right] = [m[3], m[2], m[4]];
    }
    pending.push([op, left, right, line.trim()]);
  }

  for (const [keyword, header, body] of blocks(text)) {
    const kw = keyword.toLowerCase();
    if (kw === 'ref' && body === null) { queueRef(header); continue; }
    if (body === null) { skipped.push(`block ${keyword} without a body`); continue; }
    if (kw === 'table') {
      const m = new RegExp(`^\\s*((?:"[^"]+"|${WORD})(?:\\.(?:"[^"]+"|${WORD}))?)\\s*(?:as\\s+("[^"]+"|${WORD}))?\\s*(\\[.*\\])?\\s*$`, 'isu').exec(header);
      if (!m) { skipped.push(`table header: ${header.trim()}`); continue; }
      const parts = splitTop(m[1], '.').map(unquote);
      const tid = tableId(parts.at(-1), parts.length === 2 ? parts[0] : null);
      if (m[2]) aliases.set(unquote(m[2]), tid);
      if (!aliases.has(parts.at(-1))) aliases.set(parts.at(-1), tid);
      const table = { id: tid, name: parts.at(-1), module: tid.split('.')[0], note: '', columns: [] };
      for (const [key, value] of settings(m[3] || '')) if (key === 'note' && value) table.note = unquote(value);
      tables.set(tid, table);
      const pkCols = [];
      for (const sub of body.matchAll(/^\s*indexes\s*\{(.*?)\}/gims)) {
        for (const line of splitLines(sub[1])) {
          if (!/\[[^\]]*\b(pk|primary key)\b/i.test(line)) continue;
          const cols = /^\s*\(([^)]*)\)/.exec(line);
          pkCols.push(...(cols ? splitTop(cols[1]).map(unquote) : [unquote(line.split('[')[0])]));
        }
      }
      let bodyText = body.replace(/^\s*indexes\s*\{.*?\}/gims, '');
      const note = new RegExp(`^\\s*note\\s*(?::\\s*|\\{\\s*)${NOTE_TEXT}`, 'ims').exec(bodyText);
      if (note) {
        table.note = unquote(note[1]);
        bodyText = bodyText.replaceAll(note[0], '');
      }
      for (let line of splitLines(bodyText)) {
        line = line.trim();
        if (!line || line.startsWith('~') || /^note\s*[:{]/i.test(line) || line === '}') {
          if (line.startsWith('~')) skipped.push(`${tid}: table partial ${line}`);
          continue;
        }
        const cm = new RegExp(`^("[^"]+"|${WORD})\\s+("[^"]+"|[^\\s\\[]+(?:\\([^)]*\\))?(?:\\[\\])?)\\s*(\\[.*\\])?\\s*$`, 'su').exec(line);
        if (!cm) { skipped.push(`${tid}: column ${line}`); continue; }
        const column = { name: unquote(cm[1]), type: unquote(cm[2]), pk: false, nullable: true, note: '' };
        for (const [key, value] of settings(cm[3] || '')) {
          if (key === 'pk' || key === 'primary key') Object.assign(column, { pk: true, nullable: false });
          else if (key === 'not null') column.nullable = false;
          else if (key === 'note' && value) column.note = unquote(value);
          else if (key === 'ref' && value) queueRef(value, `${tid}.${column.name}`);
        }
        table.columns.push(column);
      }
      for (const col of pkCols) {
        for (const column of table.columns) if (column.name === col) Object.assign(column, { pk: true, nullable: false });
      }
    } else if (kw === 'ref') {
      for (const line of splitLines(body)) if (line.trim()) queueRef(':' + line);
    } else if (kw === 'tablegroup') {
      const m = new RegExp(`^\\s*("[^"]+"|${WORD})\\s*(\\[.*\\])?\\s*$`, 'su').exec(header);
      if (!m) { skipped.push(`table group: ${header.trim()}`); continue; }
      const code = unquote(m[1]);
      let name = code;
      for (const [key, value] of settings(m[2] || '')) if (key === 'note' && value) name = unquote(value);
      const members = splitLines(body).filter((line) => line.trim() && !NOTE_START.test(line)).map((line) => line.trim());
      groups.push([code, name, members]);
    } else if (!['project', 'enum', 'note', 'tablepartial', 'records'].includes(kw)) {
      skipped.push(`block ${keyword}`);
    }
  }

  // references, now that every table and alias is known
  for (const [op, left, right, line] of pending) {
    if (op === '<>') { skipped.push(`many-to-many ref (not drawn): ${line}`); continue; }
    const a = endpoint(left, aliases), b = endpoint(right, aliases);
    const [src, dst] = op === '<' ? [b, a] : [a, b];
    if (!tables.has(src[0]) || !tables.has(dst[0])) { skipped.push(`ref to an unknown table: ${line}`); continue; }
    addRef(refs, src[0], src[1], dst[0], dst[1]);
  }

  let modules = [];
  const grouped = new Set();
  for (const [code, name, members] of groups) {
    for (const member of members) {
      const tid = resolveTable(member, aliases);
      if (tables.has(tid)) { tables.get(tid).module = code; grouped.add(tid); }
      else skipped.push(`table group ${code}: unknown table ${member}`);
    }
    modules.push({ code, name });
  }
  for (const t of tables.values()) {
    if (!grouped.has(t.id) && !modules.some((m) => m.code === t.module)) modules.push({ code: t.module, name: t.module });
  }
  const used = new Set([...tables.values()].map((t) => t.module));
  modules = modules.filter((m) => used.has(m.code));
  return { tables: [...tables.values()], refs, modules, skipped };
}

const args = parseArgs('import-dbml.mjs', 'DBML', 'a .dbml file');
const files = collectFiles(args.sources, '.dbml');
const { tables, refs, modules, skipped } = parse(readFiles(files).join('\n'));
const data = writeSchema(args, tables, refs, modules);
report(data, files, [['not understood', skipped]]);
console.log(`written: ${args.output}`);
