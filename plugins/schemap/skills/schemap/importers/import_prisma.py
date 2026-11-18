"""Prisma schema → schema.json. Python 3.9+, stdlib only.

Usage:
    python3 import_prisma.py prisma/schema.prisma -o schema.json [--title Shop] [--lang ru]
    python3 import_prisma.py prisma/schema/ -o schema.json          # multi-file schema: every *.prisma inside

Tables and columns use database names (@@map, @map), as the diagram shows the database. Relation fields
with @relation(fields: […], references: […]) become references; the other side of a relation (the list or
back-reference field) is not a column and is skipped. @id / @@id mark the key, "?" makes a column nullable,
@db.* gives the database type, @@schema sets the module, /// comments become notes. Views and composite types
are skipped and reported.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from schema_io import add_ref, collect_files, parse_args, report, table_id, write_schema  # noqa: E402

SCALARS = {'string': 'text', 'int': 'integer', 'bigint': 'bigint', 'float': 'double precision',
           'decimal': 'numeric', 'boolean': 'boolean', 'datetime': 'timestamp', 'json': 'jsonb', 'bytes': 'bytea'}


def blocks(text):
    """(kind, name, body lines with their preceding /// doc) for model, enum, view, type blocks."""
    lines = text.splitlines()
    i, doc = 0, []
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith('///'):
            doc.append(line[3:].strip()); i += 1; continue
        m = re.match(r'(model|enum|view|type|datasource|generator)\s+(\w+)\s*\{', line)
        if not m:
            if line and not line.startswith('//'):
                doc = []
            i += 1
            continue
        body, i = [], i + 1
        while i < len(lines) and lines[i].strip() != '}':
            body.append(lines[i]); i += 1
        yield m.group(1), m.group(2), body, ' '.join(doc)
        doc, i = [], i + 1


def attribute(text, name):
    """Arguments of @name(...) in text, or None."""
    m = re.search(rf'@{re.escape(name)}\(', text)
    if not m:
        return None
    depth, start = 0, m.end() - 1
    for j in range(start, len(text)):
        depth += {'(': 1, ')': -1}.get(text[j], 0)
        if depth == 0:
            return text[start + 1:j]
    return None


def string_arg(args):
    m = re.search(r'"([^"]*)"', args or '')
    return m.group(1) if m else None


def list_arg(args, key):
    m = re.search(rf'{key}\s*:\s*\[([^\]]*)\]', args or '')
    return [x.strip() for x in m.group(1).split(',') if x.strip()] if m else None


def parse(text):
    parsed = list(blocks(text))
    enums = {name for kind, name, _, _ in parsed if kind == 'enum'}
    models = {name: (body, doc) for kind, name, body, doc in parsed if kind == 'model'}
    skipped = [f'{kind} {name} (not a table)' for kind, name, _, _ in parsed if kind in ('view', 'type')]
    tables, field_column, pending = {}, {}, []
    for model, (body, doc) in models.items():
        attrs = ' '.join(line.strip() for line in body if line.strip().startswith('@@'))
        db_name = string_arg(attribute(attrs, '@map')) or model
        tid = table_id(db_name, string_arg(attribute(attrs, '@schema')))
        table = {'id': tid, 'name': db_name, 'module': tid.split('.')[0], 'note': doc, 'columns': []}
        field_column[model] = {}
        column_doc = []
        for raw in body:
            line = raw.strip()
            if line.startswith('///'):
                column_doc.append(line[3:].strip()); continue
            if line.startswith('//'):                  # a plain comment keeps the doc for the next field
                continue
            if not line or line.startswith('@@'):
                column_doc = []
                continue
            m = re.match(r'(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$', line)
            if not m:
                skipped.append(f'{model}: field {line}'); column_doc = []; continue
            field, ftype, is_list, optional, rest = m.groups()
            note, column_doc = ' '.join(column_doc), []
            if ftype in models:                     # relation field: a reference, not a column
                rel = attribute(rest, 'relation')
                fields, refs = list_arg(rel, 'fields'), list_arg(rel, 'references')
                if fields and refs:
                    pending.append((model, fields, ftype, refs, line))
                continue
            if ftype in enums or ftype.lower() in SCALARS or ftype == 'Unsupported':
                db_type = re.search(r'@db\.(\w+)(\(([^)]*)\))?', rest)
                if db_type:
                    ctype = db_type.group(1).lower() + (f'({db_type.group(3).replace(" ", "")})' if db_type.group(3) else '')
                elif ftype == 'Unsupported':           # Unsupported("geometry") — the database type is in quotes
                    ctype = string_arg(rest) or 'unsupported'
                else:
                    ctype = SCALARS.get(ftype.lower(), ftype)
                ctype += '[]' if is_list else ''
                column = string_arg(attribute(rest, 'map')) or field
                field_column[model][field] = column
                table['columns'].append({'name': column, 'type': ctype, 'pk': bool(re.search(r'@id\b', rest)),
                                         'nullable': bool(optional) and not re.search(r'@id\b', rest), 'note': note})
            else:
                skipped.append(f'{model}.{field}: unknown type {ftype}')
        # @@id([a, b]) or @@id(fields: [a, b], name: "…"): the first bracket list names the key fields
        id_list = re.search(r'\[([^\]]*)\]', attribute(attrs, '@id') or '')
        composite = [x.strip() for x in id_list.group(1).split(',') if x.strip()] if id_list else []
        for field in composite:
            for column in table['columns']:
                if column['name'] == field_column[model].get(field, field):
                    column['pk'], column['nullable'] = True, False
        tables[model] = table
    refs = []
    for model, fields, target, ref_fields, line in pending:
        cols = [field_column[model].get(f) for f in fields]
        to_cols = [field_column[target].get(f) for f in ref_fields]
        if None in cols or None in to_cols:
            skipped.append(f'{model}: relation to unknown fields: {line}'); continue
        add_ref(refs, tables[model]['id'], cols, tables[target]['id'], to_cols)
    return [t for t in tables.values() if t['columns']], refs, skipped


def main():
    args = parse_args('Prisma schema', 'schema.prisma, or a folder of *.prisma files')
    files = collect_files(args.sources, '*.prisma')
    tables, refs, skipped = parse('\n'.join(f.read_text(encoding='utf-8') for f in files))
    data = write_schema(args, tables, refs)
    report(data, f'{len(files)} files', [('not understood', skipped)])
    print(f'written: {args.output}')


if __name__ == '__main__':
    main()
