"""SQL DDL (migrations or a schema dump) → schema.json. Python 3.9+, stdlib only.

Usage:
    python3 import_sql.py migrations/ -o schema.json [--title Shop] [--lang ru]
    python3 import_sql.py schema.sql other.sql -o schema.json

Reads files in name order (folders: every *.sql except *.down.sql) and replays the DDL:
CREATE TABLE, ALTER TABLE (add/drop/alter/rename column, add/drop constraint, rename table), DROP TABLE,
COMMENT ON TABLE/COLUMN. In goose files only the "-- +goose Up" part counts, in dbmate files "-- migrate:up".
Everything else (indexes, types, functions, data) is skipped. Postgres first; MySQL backticks, COMMENT '…'
and AUTO_INCREMENT are understood too.

This is a parser, not a database: anything it cannot read is reported, never guessed. When a real database
is at hand, postgres_schema.sql reads the schema from it exactly.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from schema_io import (QUOTES, add_ref, collect_files, parse_args, report, split_top,  # noqa: E402
                       table_id, write_schema)

STOP_WORDS = ('not', 'null', 'default', 'primary', 'references', 'unique', 'check', 'constraint', 'generated',
              'collate', 'auto_increment', 'autoincrement', 'comment', 'on', 'identity')
DOLLAR_TAG = re.compile(r'\$[A-Za-z_]*\$')
NAME = r'(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)'
QUALIFIED = rf'{NAME}(?:\s*\.\s*{NAME})?'
REFERENCES = re.compile(rf'\breferences\s+({QUALIFIED})\s*(?:\(([^)]*)\))?', re.I | re.S)


# ---------- text → statements ----------

def up_part(text):
    """Only the forward part of a migration file."""
    for up, down in (('-- +goose Up', '-- +goose Down'), ('-- migrate:up', '-- migrate:down')):
        if up in text:
            return text.split(up, 1)[1].split(down, 1)[0]
    return text


def statements(text):
    """Splits on top-level ';', skipping comments, quoted strings and $tag$ bodies. Comments are dropped."""
    out, buf, i, n = [], [], 0, len(text)
    while i < n:
        ch = text[i]
        if text.startswith('--', i):
            i = text.find('\n', i)
            i = n if i < 0 else i
            continue
        if text.startswith('/*', i):
            end = text.find('*/', i + 2)
            i = n if end < 0 else end + 2
            continue
        if ch in QUOTES:
            end = i + 1
            while end < n:
                if text[end] == ch and text[end + 1:end + 2] == ch:   # doubled quote inside
                    end += 2
                    continue
                if text[end] == ch:
                    break
                end += 1
            buf.append(text[i:end + 1])
            i = end + 1
            continue
        tag = DOLLAR_TAG.match(text, i) if ch == '$' else None
        if tag:
            end = text.find(tag.group(), tag.end())
            end = n if end < 0 else end + len(tag.group())
            buf.append(text[i:end])
            i = end
            continue
        if ch == ';':
            out.append(''.join(buf).strip())
            buf = []
        else:
            buf.append(ch)
        i += 1
    out.append(''.join(buf).strip())
    return [s for s in out if s]


def ident(text):
    """One identifier: quotes removed; bare names fold to lower case, as Postgres does."""
    text = text.strip()
    if text[:1] in '"`' and text[-1:] in '"`':
        return text[1:-1]
    return text.lower()


def sql_table_id(text):
    parts = [ident(p) for p in re.findall(NAME, text)]
    return table_id(parts[-1], parts[0] if len(parts) == 2 else None)


def name_list(text):
    return [ident(p) for p in split_top(text)]


def string_literal(text):
    m = re.match(r"\s*(?:E)?'((?:[^']|'')*)'", text)
    return m.group(1).replace("''", "'") if m else None


def paren_body(text, start):
    """Text inside the parenthesis that opens at text[start], and the index after it closes."""
    depth, quote = 0, None
    for i in range(start, len(text)):
        ch = text[i]
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in QUOTES:
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
    raise ValueError('unbalanced parentheses')


# ---------- the replayed schema ----------

class Schema:
    def __init__(self):
        self.tables = {}          # id → {'name', 'module', 'note', 'columns': {name: column}}
        self.refs = []            # {'name', 'from': {table, columns}, 'to': {table, columns or None}}
        self.skipped = []         # statements or clauses it could not read

    def note_skip(self, what, statement):
        self.skipped.append(f'{what}: {" ".join(statement.split())[:140]}')

    def reference(self, name, tid, columns, match):
        """A foreign key from a REFERENCES match; no column list means the target's primary key."""
        self.refs.append({'name': name, 'from': {'table': tid, 'columns': columns},
                          'to': {'table': sql_table_id(match.group(1)),
                                 'columns': name_list(match.group(2)) if match.group(2) else None}})

    # --- columns and constraints ---
    def column(self, tid, text, statement):
        m = re.match(rf'({NAME})\s+(.*)$', text, re.S)
        if not m:
            return self.note_skip('column', statement)
        name, rest = ident(m.group(1)), m.group(2)
        depth, type_end = 0, len(rest)
        for w in re.finditer(r"\(|\)|'(?:[^']|'')*'|[^\s()']+", rest):
            token = w.group()
            if token == '(':
                depth += 1
            elif token == ')':
                depth -= 1
            elif depth == 0 and token.lower() in STOP_WORDS:
                type_end = w.start()
                break
        ctype = re.sub(r'\s*,\s*', ',', ' '.join(rest[:type_end].split()).lower())   # numeric(12, 2) → numeric(12,2)
        tail = rest[type_end:]
        column = {'name': name, 'type': ctype, 'pk': bool(re.search(r'\bprimary\s+key\b', tail, re.I)),
                  'nullable': not re.search(r'\bnot\s+null\b|\bprimary\s+key\b', tail, re.I), 'note': ''}
        comment = re.search(r"\bcomment\s+('(?:[^']|'')*')", tail, re.I)
        if comment:
            column['note'] = string_literal(comment.group(1))
        self.tables[tid]['columns'][name] = column
        ref = REFERENCES.search(tail)
        if ref:
            self.reference(None, tid, [name], ref)

    def constraint(self, tid, text, statement):
        """A table-level constraint. Returns False when the text is not a constraint at all."""
        cname = None
        m = re.match(rf'constraint\s+({NAME})\s+(.*)$', text, re.S | re.I)
        if m:
            cname, text = ident(m.group(1)), m.group(2)
        lower = text.lower()
        if lower.startswith('primary key'):
            for col in name_list(paren_body(text, text.index('('))[0]):
                if col in self.tables[tid]['columns']:
                    self.tables[tid]['columns'][col].update(pk=True, nullable=False)
                else:
                    self.note_skip(f'primary key on unknown column {tid}.{col}', statement)
            if cname:
                self.tables[tid].setdefault('pk_name', cname)
            return True
        if lower.startswith('foreign key'):
            cols, after = paren_body(text, text.index('('))
            ref = REFERENCES.match(text[after:].lstrip())
            if ref:
                self.reference(cname, tid, name_list(cols), ref)
            else:
                self.note_skip('foreign key', statement)
            return True
        return bool(re.match(r'(unique|check|exclude|index|key|fulltext|spatial)\b', lower) or cname)

    # --- statements ---
    def create_table(self, statement):
        m = re.match(rf'create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+'
                     rf'(?:if\s+not\s+exists\s+)?({QUALIFIED})\s*\(', statement, re.I | re.S)
        if not m:
            return self.note_skip('create table', statement)
        tid = sql_table_id(m.group(1))
        body, _ = paren_body(statement, m.end() - 1)
        schema, name = tid.split('.', 1)
        self.tables[tid] = {'name': name, 'module': schema, 'note': '', 'columns': {}}
        for item in split_top(body):
            if re.match(r'like\s', item, re.I):
                self.note_skip('LIKE inside create table (columns not copied)', statement)
            elif not self.constraint(tid, item, statement):
                self.column(tid, item, statement)

    def alter_table(self, statement):
        m = re.match(rf'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?({QUALIFIED})\s+(.*)$', statement, re.I | re.S)
        if not m:
            return self.note_skip('alter table', statement)
        tid = sql_table_id(m.group(1))
        if tid not in self.tables:
            return self.note_skip(f'alter of unknown table {tid}', statement)
        for action in split_top(m.group(2)):
            tid = self.alter_action(tid, action, statement)   # a rename hands the next action the new id

    def alter_action(self, tid, action, statement):
        """Applies one ALTER TABLE action and returns the table's id after it."""
        table = self.tables[tid]
        if m := re.match(rf'rename\s+to\s+({QUALIFIED})', action, re.I):
            new_name = ident(re.findall(NAME, m.group(1))[-1])
            new_id = table_id(new_name, table['module'])
            self.tables[new_id] = {**self.tables.pop(tid), 'name': new_name}
            self.each_end(lambda end: end.update(table=new_id) if end['table'] == tid else None)
            return new_id
        if m := re.match(r'add\s+(column\s+)?(?:if\s+not\s+exists\s+)?(.*)$', action, re.I | re.S):
            if m.group(1) or not self.constraint(tid, m.group(2), statement):
                self.column(tid, m.group(2), statement)
        elif m := re.match(rf'drop\s+constraint\s+(?:if\s+exists\s+)?({NAME})', action, re.I):
            cname = ident(m.group(1))         # unique and check constraints are not tracked: dropping one changes nothing
            self.refs = [r for r in self.refs if not (r['from']['table'] == tid and r['name'] == cname)]
            if table.get('pk_name') == cname:
                for column in table['columns'].values():
                    column['pk'] = False
        elif m := re.match(rf'drop\s+(?:column\s+)?(?:if\s+exists\s+)?({NAME})', action, re.I):
            col = ident(m.group(1))
            table['columns'].pop(col, None)
            # a reference loses meaning when either of its ends loses the column
            self.refs = [r for r in self.refs
                         if not any(end['table'] == tid and col in (end['columns'] or []) for end in (r['from'], r['to']))]
        elif m := re.match(rf'rename\s+(?:column\s+)?({NAME})\s+to\s+({NAME})', action, re.I):
            old, new = ident(m.group(1)), ident(m.group(2))
            if old not in table['columns']:
                self.note_skip(f'rename of unknown column {tid}.{old}', statement)
            else:
                table['columns'] = {(new if k == old else k): ({**v, 'name': new} if k == old else v)
                                    for k, v in table['columns'].items()}
                self.each_end(lambda end: end.update(columns=[new if c == old else c for c in end['columns']])
                              if end['table'] == tid and end['columns'] else None)
        elif m := re.match(rf'alter\s+(?:column\s+)?({NAME})\s+(.*)$', action, re.I | re.S):
            col, change = ident(m.group(1)), m.group(2).lower()
            if col not in table['columns']:
                self.note_skip(f'alter of unknown column {tid}.{col}', statement)
            elif re.match(r'set\s+not\s+null', change):
                table['columns'][col]['nullable'] = False
            elif re.match(r'drop\s+not\s+null', change):
                table['columns'][col]['nullable'] = True
            elif t := re.match(r'(?:set\s+data\s+)?type\s+(.+?)(?:\s+using\s+.*)?$', change, re.S):
                table['columns'][col]['type'] = ' '.join(t.group(1).split())
        elif not re.match(r'(enable|disable|force|no\s+force|owner|set|reset|cluster|inherit|no\s+inherit|attach|'
                          r'detach|validate|replica|alter\s+constraint|drop\s+index|add\s+index)\b', action, re.I):
            self.note_skip('alter table action', statement)
        return tid

    def each_end(self, change):
        for r in self.refs:
            change(r['from'])
            change(r['to'])

    def drop_table(self, statement):
        m = re.match(r'drop\s+table\s+(?:if\s+exists\s+)?(.*?)(?:\s+(?:cascade|restrict))?$', statement, re.I | re.S)
        for name in split_top(m.group(1)) if m else []:
            tid = sql_table_id(name)
            self.tables.pop(tid, None)
            self.refs = [r for r in self.refs if tid not in (r['from']['table'], r['to']['table'])]

    def comment(self, statement):
        m = re.match(rf'comment\s+on\s+(table|column)\s+({QUALIFIED}(?:\s*\.\s*{NAME})?)\s+is\s+(.*)$',
                     statement, re.I | re.S)
        if not m:
            return
        text = string_literal(m.group(3)) or ''      # "is null" removes a comment
        parts = [ident(p) for p in re.findall(NAME, m.group(2))]
        if m.group(1).lower() == 'table':
            tid = table_id(parts[-1], parts[0] if len(parts) == 2 else None)
            if tid in self.tables:
                self.tables[tid]['note'] = text
            return
        tid = table_id(parts[-2], parts[0] if len(parts) == 3 else None)
        if tid in self.tables and parts[-1] in self.tables[tid]['columns']:
            self.tables[tid]['columns'][parts[-1]]['note'] = text

    def apply(self, statement):
        lower = statement.lower()
        try:
            if re.match(r'create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\b', lower):
                if re.search(r'\bas\s+select\b|\bpartition\s+of\b', lower):
                    return self.note_skip('create table as/partition of', statement)
                self.create_table(statement)
            elif lower.startswith('alter table'):
                self.alter_table(statement)
            elif lower.startswith('drop table'):
                self.drop_table(statement)
            elif lower.startswith('comment on'):
                self.comment(statement)
        except (ValueError, IndexError, KeyError) as error:
            self.note_skip(f'unreadable ({error})', statement)

    # --- result ---
    def contract(self):
        """Tables and references in schema.json shape, plus what was left out and why."""
        pk_of = {tid: [c['name'] for c in t['columns'].values() if c['pk']] for tid, t in self.tables.items()}
        refs, dropped = [], []
        for r in self.refs:
            target = r['to']['table']
            if target not in self.tables:
                dropped.append(f"{r['from']['table']} → {target} (table not in these files)")
                continue
            cols = r['to']['columns'] or pk_of[target]
            if len(cols) != len(r['from']['columns']):
                dropped.append(f"{r['from']['table']} → {target}: column counts differ")
                continue
            add_ref(refs, r['from']['table'], r['from']['columns'], target, cols)
        tables = [{'id': tid, 'name': t['name'], 'module': t['module'], 'note': t['note'],
                   'columns': list(t['columns'].values())} for tid, t in self.tables.items() if t['columns']]
        empty = [tid for tid, t in self.tables.items() if not t['columns']]
        return tables, refs, dropped, empty


def main():
    args = parse_args('SQL DDL', '.sql files or folders of migrations', many=True)
    schema = Schema()
    files = collect_files(args.sources, '*.sql', skip=lambda f: f.name.endswith('.down.sql'))
    for f in files:
        for statement in statements(up_part(f.read_text(encoding='utf-8'))):
            schema.apply(statement)
    tables, refs, dropped, empty = schema.contract()
    data = write_schema(args, tables, refs)
    report(data, f'{len(files)} files', [('references left out', dropped),
                                         ('tables without columns, left out', empty),
                                         ('not understood', schema.skipped)])
    print(f'written: {args.output}')


if __name__ == '__main__':
    main()
