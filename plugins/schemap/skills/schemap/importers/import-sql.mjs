// SQL DDL (migrations or a schema dump) → schema.json. Node 18+, no packages.
//
//   node import-sql.mjs migrations/ -o schema.json [--title Shop] [--lang ru]
//   node import-sql.mjs schema.sql other.sql -o schema.json
//
// Reads files in name order (folders: every *.sql except *.down.sql) and replays the DDL:
// CREATE TABLE, ALTER TABLE (add/drop/alter/rename column, add/drop constraint, rename table), DROP TABLE,
// COMMENT ON TABLE/COLUMN. In goose files only the "-- +goose Up" part counts, in dbmate files "-- migrate:up".
// Everything else (indexes, types, functions, data) is skipped. Postgres first; MySQL backticks, COMMENT '…'
// and AUTO_INCREMENT are understood too.
//
// This is a parser, not a database: anything it cannot read is reported, never guessed. When a real database
// is at hand, postgres_schema.sql reads the schema from it exactly.
import {
  QUOTES, addRef, collectFiles, parseArgs, readFiles, report, splitTop, squeeze, tableId, writeSchema,
} from './schema-io.mjs';

const STOP_WORDS = new Set(['not', 'null', 'default', 'primary', 'references', 'unique', 'check', 'constraint',
  'generated', 'collate', 'auto_increment', 'autoincrement', 'comment', 'on', 'identity']);
const NAME = '(?:"[^"]+"|`[^`]+`|[A-Za-z_][\\p{L}\\p{N}_$]*)';
const QUALIFIED = `${NAME}(?:\\s*\\.\\s*${NAME})?`;
const REFERENCES = `\\breferences\\s+(${QUALIFIED})\\s*(?:\\(([^)]*)\\))?`;
const re = (source, flags = '') => new RegExp(source, flags + 'u');
const at = (source, flags = '') => re(`^(?:${source})`, flags);            // matches only at the start, like re.match
const names = (text) => [...text.matchAll(re(NAME, 'g'))].map((m) => ident(m[0]));

// ---------- text → statements ----------

/** Only the forward part of a migration file. */
function upPart(text) {
  for (const [up, down] of [['-- +goose Up', '-- +goose Down'], ['-- migrate:up', '-- migrate:down']]) {
    if (text.includes(up)) return text.split(up).slice(1).join(up).split(down)[0];
  }
  return text;
}

/** Splits on top-level ';', skipping comments, quoted strings and $tag$ bodies. Comments are dropped. */
function statements(text) {
  const out = [], n = text.length, dollar = /\$[A-Za-z_]*\$/y;
  let buf = '', i = 0;
  while (i < n) {
    const ch = text[i];
    if (text.startsWith('--', i)) {
      i = text.indexOf('\n', i);
      if (i < 0) i = n;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (QUOTES.includes(ch)) {
      let end = i + 1;
      while (end < n) {
        if (text[end] === ch && text[end + 1] === ch) { end += 2; continue; }   // doubled quote inside
        if (text[end] === ch) break;
        end += 1;
      }
      buf += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    dollar.lastIndex = i;
    const tag = ch === '$' ? dollar.exec(text) : null;
    if (tag) {
      const close = text.indexOf(tag[0], i + tag[0].length);
      const end = close < 0 ? n : close + tag[0].length;
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ';') {
      out.push(buf.trim());
      buf = '';
    } else buf += ch;
    i += 1;
  }
  out.push(buf.trim());
  return out.filter(Boolean);
}

/** One identifier: quotes removed; bare names fold to lower case, as Postgres does. */
function ident(text) {
  text = text.trim();
  if ('"`'.includes(text[0]) && '"`'.includes(text.at(-1))) return text.slice(1, -1);
  return text.toLowerCase();
}

function sqlTableId(text) {
  const parts = names(text);
  return tableId(parts.at(-1), parts.length === 2 ? parts[0] : null);
}

const nameList = (text) => splitTop(text).map(ident);

function stringLiteral(text) {
  const m = /^\s*(?:E)?'((?:[^']|'')*)'/.exec(text);
  return m ? m[1].replaceAll("''", "'") : null;
}

/** Text inside the parenthesis that opens at text[start], and the index after it closes. */
function parenBody(text, start) {
  if (start < 0) throw new Error('substring not found');
  let depth = 0, quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (QUOTES.includes(ch)) quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return [text.slice(start + 1, i), i + 1];
    }
  }
  throw new Error('unbalanced parentheses');
}

// ---------- the replayed schema ----------

class Schema {
  tables = new Map();   // id → { name, module, note, columns: Map(name → column), pkName }
  refs = [];            // { name, from: { table, columns }, to: { table, columns or null } }
  skipped = [];         // statements or clauses it could not read

  noteSkip(what, statement) {
    this.skipped.push(`${what}: ${squeeze(statement).slice(0, 140)}`);
  }

  /** A foreign key from a REFERENCES match; no column list means the target's primary key. */
  reference(name, tid, columns, match) {
    this.refs.push({ name, from: { table: tid, columns },
      to: { table: sqlTableId(match[1]), columns: match[2] ? nameList(match[2]) : null } });
  }

  // --- columns and constraints ---
  column(tid, text, statement) {
    const m = re(`^(${NAME})\\s+(.*)$`, 's').exec(text);
    if (!m) return this.noteSkip('column', statement);
    const name = ident(m[1]), rest = m[2];
    let depth = 0, typeEnd = rest.length;
    for (const w of rest.matchAll(/\(|\)|'(?:[^']|'')*'|[^\s()']+/g)) {
      const token = w[0];
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
      else if (depth === 0 && STOP_WORDS.has(token.toLowerCase())) { typeEnd = w.index; break; }
    }
    const type = squeeze(rest.slice(0, typeEnd)).toLowerCase().replace(/\s*,\s*/g, ',');   // numeric(12, 2) → numeric(12,2)
    const tail = rest.slice(typeEnd);
    const column = { name, type, pk: /\bprimary\s+key\b/i.test(tail),
      nullable: !/\bnot\s+null\b|\bprimary\s+key\b/i.test(tail), note: '' };
    const comment = /\bcomment\s+('(?:[^']|'')*')/i.exec(tail);
    if (comment) column.note = stringLiteral(comment[1]);
    this.tables.get(tid).columns.set(name, column);
    const ref = re(REFERENCES, 'is').exec(tail);
    if (ref) this.reference(null, tid, [name], ref);
  }

  /** A table-level constraint. Returns false when the text is not a constraint at all. */
  constraint(tid, text, statement) {
    let cname = null;
    const m = re(`^constraint\\s+(${NAME})\\s+(.*)$`, 'si').exec(text);
    if (m) { cname = ident(m[1]); text = m[2]; }
    const lower = text.toLowerCase(), table = this.tables.get(tid);
    if (lower.startsWith('primary key')) {
      for (const col of nameList(parenBody(text, text.indexOf('('))[0])) {
        if (table.columns.has(col)) Object.assign(table.columns.get(col), { pk: true, nullable: false });
        else this.noteSkip(`primary key on unknown column ${tid}.${col}`, statement);
      }
      if (cname && !('pkName' in table)) table.pkName = cname;
      return true;
    }
    if (lower.startsWith('foreign key')) {
      const [cols, after] = parenBody(text, text.indexOf('('));
      const ref = at(REFERENCES, 'is').exec(text.slice(after).trimStart());
      if (ref) this.reference(cname, tid, nameList(cols), ref);
      else this.noteSkip('foreign key', statement);
      return true;
    }
    return /^(unique|check|exclude|index|key|fulltext|spatial)\b/.test(lower) || Boolean(cname);
  }

  // --- statements ---
  createTable(statement) {
    const m = re(`^create\\s+(?:(?:global|local)\\s+)?(?:temp(?:orary)?\\s+|unlogged\\s+)?table\\s+`
      + `(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED})\\s*\\(`, 'is').exec(statement);
    if (!m) return this.noteSkip('create table', statement);
    const tid = sqlTableId(m[1]);
    const [body] = parenBody(statement, m.index + m[0].length - 1);
    const dot = tid.indexOf('.');
    this.tables.set(tid, { name: tid.slice(dot + 1), module: tid.slice(0, dot), note: '', columns: new Map() });
    for (const item of splitTop(body)) {
      if (/^like\s/i.test(item)) this.noteSkip('LIKE inside create table (columns not copied)', statement);
      else if (!this.constraint(tid, item, statement)) this.column(tid, item, statement);
    }
  }

  alterTable(statement) {
    const m = re(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QUALIFIED})\\s+(.*)$`, 'is').exec(statement);
    if (!m) return this.noteSkip('alter table', statement);
    let tid = sqlTableId(m[1]);
    if (!this.tables.has(tid)) return this.noteSkip(`alter of unknown table ${tid}`, statement);
    for (const action of splitTop(m[2])) tid = this.alterAction(tid, action, statement);   // a rename hands the next action the new id
  }

  /** Applies one ALTER TABLE action and returns the table's id after it. */
  alterAction(tid, action, statement) {
    const table = this.tables.get(tid);
    let m;
    if ((m = at(`rename\\s+to\\s+(${QUALIFIED})`, 'i').exec(action))) {
      const newName = names(m[1]).at(-1), newId = tableId(newName, table.module);
      this.tables.delete(tid);
      this.tables.set(newId, { ...table, name: newName });
      this.eachEnd((end) => { if (end.table === tid) end.table = newId; });
      return newId;
    }
    if ((m = at('add\\s+(column\\s+)?(?:if\\s+not\\s+exists\\s+)?(.*)$', 'is').exec(action))) {
      if (m[1] || !this.constraint(tid, m[2], statement)) this.column(tid, m[2], statement);
    } else if ((m = at(`drop\\s+constraint\\s+(?:if\\s+exists\\s+)?(${NAME})`, 'i').exec(action))) {
      const cname = ident(m[1]);   // unique and check constraints are not tracked: dropping one changes nothing
      this.refs = this.refs.filter((r) => !(r.from.table === tid && r.name === cname));
      if (table.pkName === cname) for (const column of table.columns.values()) column.pk = false;
    } else if ((m = at(`drop\\s+(?:column\\s+)?(?:if\\s+exists\\s+)?(${NAME})`, 'i').exec(action))) {
      const col = ident(m[1]);
      table.columns.delete(col);
      // a reference loses meaning when either of its ends loses the column
      this.refs = this.refs.filter((r) => ![r.from, r.to].some((end) => end.table === tid && (end.columns || []).includes(col)));
    } else if ((m = at(`rename\\s+(?:column\\s+)?(${NAME})\\s+to\\s+(${NAME})`, 'i').exec(action))) {
      const old = ident(m[1]), renamed = ident(m[2]);
      if (!table.columns.has(old)) this.noteSkip(`rename of unknown column ${tid}.${old}`, statement);
      else {
        table.columns = new Map([...table.columns].map(([k, v]) => (k === old ? [renamed, { ...v, name: renamed }] : [k, v])));
        this.eachEnd((end) => {
          if (end.table === tid && end.columns) end.columns = end.columns.map((c) => (c === old ? renamed : c));
        });
      }
    } else if ((m = at(`alter\\s+(?:column\\s+)?(${NAME})\\s+(.*)$`, 'is').exec(action))) {
      const col = ident(m[1]), change = m[2].toLowerCase(), column = table.columns.get(col);
      let type;
      if (!column) this.noteSkip(`alter of unknown column ${tid}.${col}`, statement);
      else if (/^set\s+not\s+null/.test(change)) column.nullable = false;
      else if (/^drop\s+not\s+null/.test(change)) column.nullable = true;
      else if ((type = /^(?:set\s+data\s+)?type\s+(.+?)(?:\s+using\s+.*)?$/s.exec(change))) column.type = squeeze(type[1]);
    } else if (!/^(enable|disable|force|no\s+force|owner|set|reset|cluster|inherit|no\s+inherit|attach|detach|validate|replica|alter\s+constraint|drop\s+index|add\s+index)\b/i.test(action)) {
      this.noteSkip('alter table action', statement);
    }
    return tid;
  }

  eachEnd(change) {
    for (const r of this.refs) { change(r.from); change(r.to); }
  }

  dropTable(statement) {
    const m = /^drop\s+table\s+(?:if\s+exists\s+)?(.*?)(?:\s+(?:cascade|restrict))?$/is.exec(statement);
    for (const name of m ? splitTop(m[1]) : []) {
      const tid = sqlTableId(name);
      this.tables.delete(tid);
      this.refs = this.refs.filter((r) => r.from.table !== tid && r.to.table !== tid);
    }
  }

  comment(statement) {
    const m = re(`^comment\\s+on\\s+(table|column)\\s+(${QUALIFIED}(?:\\s*\\.\\s*${NAME})?)\\s+is\\s+(.*)$`, 'is').exec(statement);
    if (!m) return;
    const text = stringLiteral(m[3]) || '';   // "is null" removes a comment
    const parts = names(m[2]);
    if (m[1].toLowerCase() === 'table') {
      const table = this.tables.get(tableId(parts.at(-1), parts.length === 2 ? parts[0] : null));
      if (table) table.note = text;
      return;
    }
    if (parts.length < 2) throw new Error('column comment without a table');
    const table = this.tables.get(tableId(parts.at(-2), parts.length === 3 ? parts[0] : null));
    if (table && table.columns.has(parts.at(-1))) table.columns.get(parts.at(-1)).note = text;
  }

  apply(statement) {
    const lower = statement.toLowerCase();
    try {
      if (/^create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\b/.test(lower)) {
        if (/\bas\s+select\b|\bpartition\s+of\b/.test(lower)) return this.noteSkip('create table as/partition of', statement);
        this.createTable(statement);
      } else if (lower.startsWith('alter table')) this.alterTable(statement);
      else if (lower.startsWith('drop table')) this.dropTable(statement);
      else if (lower.startsWith('comment on')) this.comment(statement);
    } catch (error) {
      this.noteSkip(`unreadable (${error.message})`, statement);
    }
  }

  // --- result ---
  /** Tables and references in schema.json shape, plus what was left out and why. */
  contract() {
    const pkOf = new Map([...this.tables].map(([tid, t]) => [tid, [...t.columns.values()].filter((c) => c.pk).map((c) => c.name)]));
    const refs = [], dropped = [];
    for (const r of this.refs) {
      const target = r.to.table;
      if (!this.tables.has(target)) { dropped.push(`${r.from.table} → ${target} (table not in these files)`); continue; }
      const cols = r.to.columns && r.to.columns.length ? r.to.columns : pkOf.get(target);
      if (cols.length !== r.from.columns.length) { dropped.push(`${r.from.table} → ${target}: column counts differ`); continue; }
      addRef(refs, r.from.table, r.from.columns, target, cols);
    }
    const tables = [...this.tables].filter(([, t]) => t.columns.size)
      .map(([id, t]) => ({ id, name: t.name, module: t.module, note: t.note, columns: [...t.columns.values()] }));
    const empty = [...this.tables].filter(([, t]) => !t.columns.size).map(([id]) => id);
    return { tables, refs, dropped, empty };
  }
}

const args = parseArgs('import-sql.mjs', 'SQL DDL', '.sql files or folders of migrations', true);
const schema = new Schema();
const files = collectFiles(args.sources, '.sql', (f) => f.endsWith('.down.sql'));
for (const text of readFiles(files)) for (const statement of statements(upPart(text))) schema.apply(statement);
const { tables, refs, dropped, empty } = schema.contract();
const data = writeSchema(args, tables, refs);
report(data, files, [['references left out', dropped], ['tables without columns, left out', empty],
  ['not understood', schema.skipped]]);
console.log(`written: ${args.output}`);
