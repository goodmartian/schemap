// Prisma schema → schema.json. Node 18+, no packages.
//
//   node import-prisma.mjs prisma/schema.prisma -o schema.json [--title Shop] [--lang ru]
//   node import-prisma.mjs prisma/schema/ -o schema.json          # multi-file schema: every *.prisma inside
//
// Tables and columns use database names (@@map, @map), as the diagram shows the database. Relation fields
// with @relation(fields: […], references: […]) become references; the other side of a relation (the list or
// back-reference field) is not a column and is skipped. @id / @@id mark the key, "?" makes a column nullable,
// @db.* gives the database type, @@schema sets the module, /// comments become notes. Views and composite types
// are skipped and reported.
import { addRef, collectFiles, parseArgs, readFiles, report, splitLines, tableId, writeSchema } from './schema-io.mjs';

const SCALARS = { string: 'text', int: 'integer', bigint: 'bigint', float: 'double precision', decimal: 'numeric',
  boolean: 'boolean', datetime: 'timestamp', json: 'jsonb', bytes: 'bytea' };
const W = '[\\p{L}\\p{N}_]';

/** [kind, name, body lines, preceding /// doc] for model, enum, view, type blocks. */
function* blocks(text) {
  const lines = splitLines(text), head = new RegExp(`^(model|enum|view|type|datasource|generator)\\s+(${W}+)\\s*\\{`, 'u');
  let i = 0, doc = [];
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('///')) { doc.push(line.slice(3).trim()); i += 1; continue; }
    const m = head.exec(line);
    if (!m) {
      if (line && !line.startsWith('//')) doc = [];
      i += 1;
      continue;
    }
    const body = [];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '}') { body.push(lines[i]); i += 1; }
    yield [m[1], m[2], body, doc.join(' ')];
    doc = [];
    i += 1;
  }
}

/** Arguments of @name(...) in text, or null. */
function attribute(text, name) {
  const m = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(`).exec(text);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let j = start; j < text.length; j += 1) {
    depth += text[j] === '(' ? 1 : text[j] === ')' ? -1 : 0;
    if (depth === 0) return text.slice(start + 1, j);
  }
  return null;
}

const stringArg = (args) => { const m = /"([^"]*)"/.exec(args || ''); return m ? m[1] : null; };

function listArg(args, key) {
  const m = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(args || '');
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
}

function parse(text) {
  const parsed = [...blocks(text)];
  const enums = new Set(parsed.filter(([kind]) => kind === 'enum').map(([, name]) => name));
  const models = new Map();
  for (const [kind, name, body, doc] of parsed) if (kind === 'model') models.set(name, [body, doc]);
  const skipped = parsed.filter(([kind]) => kind === 'view' || kind === 'type').map(([kind, name]) => `${kind} ${name} (not a table)`);
  const tables = new Map(), fieldColumn = new Map(), pending = [];
  const field = new RegExp(`^(${W}+)\\s+(${W}+)(\\[\\])?(\\?)?\\s*(.*)$`, 'u');
  for (const [model, [body, doc]] of models) {
    const attrs = body.map((line) => line.trim()).filter((line) => line.startsWith('@@')).join(' ');
    const dbName = stringArg(attribute(attrs, '@map')) || model;
    const tid = tableId(dbName, stringArg(attribute(attrs, '@schema')));
    const table = { id: tid, name: dbName, module: tid.split('.')[0], note: doc, columns: [] };
    const columnOf = new Map();
    fieldColumn.set(model, columnOf);
    let columnDoc = [];
    for (const raw of body) {
      const line = raw.trim();
      if (line.startsWith('///')) { columnDoc.push(line.slice(3).trim()); continue; }
      if (line.startsWith('//')) continue;   // a plain comment keeps the doc for the next field
      if (!line || line.startsWith('@@')) { columnDoc = []; continue; }
      const m = field.exec(line);
      if (!m) { skipped.push(`${model}: field ${line}`); columnDoc = []; continue; }
      const [, name, type, isList, optional, rest] = m;
      const note = columnDoc.join(' ');
      columnDoc = [];
      if (models.has(type)) {   // relation field: a reference, not a column
        const relation = attribute(rest, 'relation');
        const fields = listArg(relation, 'fields'), refs = listArg(relation, 'references');
        if (fields && fields.length && refs && refs.length) pending.push([model, fields, type, refs, line]);
        continue;
      }
      const scalar = Object.hasOwn(SCALARS, type.toLowerCase()) ? SCALARS[type.toLowerCase()] : null;
      if (enums.has(type) || scalar || type === 'Unsupported') {
        const dbType = /@db\.(\w+)(\(([^)]*)\))?/.exec(rest);
        let columnType;
        if (dbType) columnType = dbType[1].toLowerCase() + (dbType[3] ? `(${dbType[3].replaceAll(' ', '')})` : '');
        else if (type === 'Unsupported') columnType = stringArg(rest) || 'unsupported';   // Unsupported("geometry") — the type is in quotes
        else columnType = scalar || type;
        if (isList) columnType += '[]';
        const column = stringArg(attribute(rest, 'map')) || name;
        columnOf.set(name, column);
        const pk = /@id\b/.test(rest);
        table.columns.push({ name: column, type: columnType, pk, nullable: Boolean(optional) && !pk, note });
      } else skipped.push(`${model}.${name}: unknown type ${type}`);
    }
    // @@id([a, b]) or @@id(fields: [a, b], name: "…"): the first bracket list names the key fields
    const idList = /\[([^\]]*)\]/.exec(attribute(attrs, '@id') || '');
    const composite = idList ? idList[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
    for (const key of composite) {
      for (const column of table.columns) {
        if (column.name === (columnOf.get(key) ?? key)) Object.assign(column, { pk: true, nullable: false });
      }
    }
    tables.set(model, table);
  }
  const refs = [];
  for (const [model, fields, target, refFields, line] of pending) {
    const cols = fields.map((f) => fieldColumn.get(model).get(f));
    const toCols = refFields.map((f) => fieldColumn.get(target).get(f));
    if (cols.includes(undefined) || toCols.includes(undefined)) { skipped.push(`${model}: relation to unknown fields: ${line}`); continue; }
    addRef(refs, tables.get(model).id, cols, tables.get(target).id, toCols);
  }
  return { tables: [...tables.values()].filter((t) => t.columns.length), refs, skipped };
}

const args = parseArgs('import-prisma.mjs', 'Prisma schema', 'schema.prisma, or a folder of *.prisma files');
const files = collectFiles(args.sources, '.prisma');
const { tables, refs, skipped } = parse(readFiles(files).join('\n'));
const data = writeSchema(args, tables, refs);
report(data, files, [['not understood', skipped]]);
console.log(`written: ${args.output}`);
