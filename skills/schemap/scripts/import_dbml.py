"""DBML (dbdiagram.io format) → schema.json. Python 3.9+, stdlib only.

Usage:
    python3 import_dbml.py schema.dbml -o schema.json [--title Shop] [--lang ru]

Reads Table (columns, settings, indexes with [pk], Note), Ref (one-line, block, inline ref: > …),
TableGroup (becomes a module; its note becomes the module name). Table notes and column notes become notes.
Tables in no group go to a module named after their schema ("public" when there is none).
Enum, Project, Note, Records and TablePartial blocks are skipped; many-to-many refs (<>) are reported, not drawn.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from schema_io import (QUOTES, add_ref, collect_files, parse_args, report, split_top,  # noqa: E402
                       table_id, unquote, write_schema)

BRACKETS = '()[]{}'
NOTE_TEXT = r"""('''.*?'''|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")"""   # '…', "…" or '''…'''


def strip_comments(text):
    out, i, n = [], 0, len(text)
    while i < n:
        if text.startswith("'''", i):                  # multi-line string
            end = text.find("'''", i + 3)
            end = n if end < 0 else end + 3
            out.append(text[i:end]); i = end; continue
        ch = text[i]
        if ch in QUOTES:
            end = i + 1
            while end < n and text[end] != ch:
                end += 2 if text[end] == '\\' else 1
            out.append(text[i:end + 1]); i = end + 1; continue
        if text.startswith('//', i):
            i = text.find('\n', i); i = n if i < 0 else i; continue
        if text.startswith('/*', i):
            end = text.find('*/', i + 2); i = n if end < 0 else end + 2; continue
        out.append(ch); i += 1
    return ''.join(out)


def blocks(text):
    """Top-level blocks: (keyword, header, body). Ref one-liners come back with body None."""
    i, n = 0, len(text)
    while i < n:
        m = re.compile(r'\s*([A-Za-z_]+)\b').match(text, i)
        if not m:
            break
        keyword = m.group(1)
        brace = text.find('{', m.end())
        newline = text.find('\n', m.end())
        newline = n if newline < 0 else newline
        # one-line Ref: no brace on its line, or the relation itself stands before the brace
        if keyword.lower() == 'ref' and (brace < 0 or brace > newline
                                         or re.search(r'<>|<|>|\s-\s', text[m.end():brace])):
            yield keyword, text[m.end():newline], None
            i = newline + 1
            continue
        if brace < 0:
            break
        depth, j, quote = 0, brace, None
        while j < n:
            ch = text[j]
            if quote:
                if text.startswith("'''", j) and quote == "'''":
                    quote = None; j += 3; continue
                if quote != "'''" and ch == quote:
                    quote = None
                j += 1; continue
            if text.startswith("'''", j):
                quote = "'''"; j += 3; continue
            if ch in QUOTES:
                quote = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield keyword, text[m.end():brace], text[brace + 1:j]
        i = j + 1


def settings(text):
    """'[pk, not null, note: '…', ref: > a.b]' → list of (key, value or None)."""
    m = re.search(r'\[(.*)\]\s*$', text, re.S)
    if not m:
        return []
    out = []
    for part in split_top(m.group(1), brackets=BRACKETS):
        key, _, value = part.partition(':')
        out.append((key.strip().lower(), value.strip() if _ else None))
    return out


def resolve_table(text, aliases):
    """'schema.table', 'table' or an alias → table id."""
    parts = [unquote(p) for p in split_top(text, '.')]
    name = '.'.join(parts)
    if name in aliases:
        return aliases[name]
    return table_id(parts[-1], parts[0] if len(parts) == 2 else None)


def endpoint(text, aliases):
    """'schema.table.col', 'table.col', 'table.(a, b)' → (table id, [columns])."""
    text = text.strip()
    m = re.match(r'(.+)\.\(([^)]*)\)$', text)
    if m:
        table, cols = m.group(1), [unquote(c) for c in split_top(m.group(2))]
    else:
        table, _, col = text.rpartition('.')
        cols = [unquote(col)]
    return resolve_table(table, aliases), cols


def parse(text):
    text = strip_comments(text)
    tables, refs, groups, skipped, aliases, pending = {}, [], [], [], {}, []

    def queue_ref(line, inline_from=None):              # resolved after every table and alias is known
        m = re.match(r'\s*(?:([^:\s]+)\s*)?:?\s*(.+?)\s*(<>|<|>|-)\s*(.+?)\s*(\[.*\])?\s*$', line, re.S)
        if inline_from:
            m2 = re.match(r'\s*(<>|<|>|-)\s*(.+?)\s*$', line)
            if not m2:
                skipped.append(f'inline ref: {line.strip()}'); return
            op, left, right = m2.group(1), inline_from, m2.group(2)
        elif m:
            op, left, right = m.group(3), m.group(2), m.group(4)
        else:
            skipped.append(f'ref: {line.strip()}'); return
        pending.append((op, left, right, line.strip()))

    for keyword, header, body in blocks(text):
        kw = keyword.lower()
        if kw == 'ref' and body is None:
            queue_ref(header)
            continue
        if body is None:
            skipped.append(f'block {keyword} without a body'); continue
        if kw == 'table':
            m = re.match(r'\s*((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s*(?:as\s+("[^"]+"|[\w$]+))?\s*(\[.*\])?\s*$',
                         header, re.S | re.I)
            if not m:
                skipped.append(f'table header: {header.strip()}'); continue
            parts = [unquote(p) for p in split_top(m.group(1), '.')]
            tid = table_id(parts[-1], parts[0] if len(parts) == 2 else None)
            if m.group(2):
                aliases[unquote(m.group(2))] = tid
            aliases[parts[-1]] = aliases.get(parts[-1], tid)
            table = {'id': tid, 'name': parts[-1], 'module': tid.split('.')[0], 'note': '', 'columns': []}
            for key, value in settings(m.group(3) or ''):
                if key == 'note' and value:
                    table['note'] = unquote(value)
            tables[tid] = table
            body_text = body
            for sub in re.finditer(r'(?im)^\s*indexes\s*\{(.*?)\}', body_text, re.S):
                for line in sub.group(1).splitlines():
                    if re.search(r'\[[^\]]*\b(pk|primary key)\b', line, re.I):
                        cols = re.match(r'\s*\(([^)]*)\)', line)
                        names = [unquote(c) for c in split_top(cols.group(1))] if cols else [unquote(line.split('[')[0])]
                        table.setdefault('pk_cols', []).extend(names)
            body_text = re.sub(r'(?im)^\s*indexes\s*\{.*?\}', '', body_text, flags=re.S)
            note = re.search(rf"(?im)^\s*note\s*(?::\s*|\{{\s*){NOTE_TEXT}", body_text, re.S)
            if note:
                table['note'] = unquote(note.group(1))
                body_text = body_text.replace(note.group(0), '')
            for line in body_text.splitlines():
                line = line.strip()
                if not line or line.startswith('~') or re.match(r'(?i)note\s*[:{]', line) or line == '}':
                    if line.startswith('~'):
                        skipped.append(f'{tid}: table partial {line}')
                    continue
                cm = re.match(r'("[^"]+"|[\w$]+)\s+("[^"]+"|[^\s\[]+(?:\([^)]*\))?(?:\[\])?)\s*(\[.*\])?\s*$', line, re.S)
                if not cm:
                    skipped.append(f'{tid}: column {line}'); continue
                column = {'name': unquote(cm.group(1)), 'type': unquote(cm.group(2)), 'pk': False, 'nullable': True, 'note': ''}
                for key, value in settings(cm.group(3) or ''):
                    if key in ('pk', 'primary key'):
                        column['pk'], column['nullable'] = True, False
                    elif key == 'not null':
                        column['nullable'] = False
                    elif key == 'note' and value:
                        column['note'] = unquote(value)
                    elif key == 'ref' and value:
                        queue_ref(value, inline_from=f'{tid}.{column["name"]}')
                table['columns'].append(column)
            for col in table.pop('pk_cols', []):
                for column in table['columns']:
                    if column['name'] == col:
                        column['pk'], column['nullable'] = True, False
        elif kw == 'ref':
            for line in body.splitlines():
                if line.strip():
                    queue_ref(':' + line)
        elif kw == 'tablegroup':
            m = re.match(r'\s*("[^"]+"|[\w$]+)\s*(\[.*\])?\s*$', header, re.S)
            if not m:
                skipped.append(f'table group: {header.strip()}'); continue
            code = unquote(m.group(1))
            name = code
            for key, value in settings(m.group(2) or ''):
                if key == 'note' and value:
                    name = unquote(value)
            members = [line.strip() for line in body.splitlines()
                       if line.strip() and not re.match(r'(?i)\s*note\s*[:{]', line)]
            groups.append((code, name, members))
        elif kw in ('project', 'enum', 'note', 'tablepartial', 'records'):
            continue
        else:
            skipped.append(f'block {keyword}')

    # references, now that every table and alias is known
    for op, left, right, line in pending:
        if op == '<>':
            skipped.append(f'many-to-many ref (not drawn): {line}'); continue
        a, b = endpoint(left, aliases), endpoint(right, aliases)
        src, dst = (b, a) if op == '<' else (a, b)
        if src[0] not in tables or dst[0] not in tables:
            skipped.append(f'ref to an unknown table: {line}'); continue
        add_ref(refs, src[0], src[1], dst[0], dst[1])

    modules, grouped = [], set()
    for code, name, members in groups:
        for member in members:
            tid = resolve_table(member, aliases)
            if tid in tables:
                tables[tid]['module'] = code
                grouped.add(tid)
            else:
                skipped.append(f'table group {code}: unknown table {member}')
        modules.append({'code': code, 'name': name})
    for t in tables.values():
        if t['id'] not in grouped and t['module'] not in [m['code'] for m in modules]:
            modules.append({'code': t['module'], 'name': t['module']})
    used = {t['module'] for t in tables.values()}
    modules = [m for m in modules if m['code'] in used]
    return list(tables.values()), refs, modules, skipped


def main():
    args = parse_args('DBML', 'a .dbml file')
    files = collect_files(args.sources, '*.dbml')
    tables, refs, modules, skipped = parse('\n'.join(f.read_text(encoding='utf-8') for f in files))
    data = write_schema(args, tables, refs, modules)
    report(data, f'{len(files)} files', [('not understood', skipped)])
    print(f'written: {args.output}')


if __name__ == '__main__':
    main()
