"""What the importers share: reading quoted and bracketed text, the command line, writing schema.json, the report.

Stdlib only. The importers run as scripts from this folder and import it as a sibling (import_*.py put this
folder on sys.path first, because `python3 -I` leaves it out). The written file is checked by the same
load_schema() that build_diagram.py uses, so an importer cannot hand the build a file it would reject.
"""
import argparse
import json
import sys
from pathlib import Path
from typing import NoReturn

from build_diagram import LANGS, SchemaError, load_schema

DEFAULT_SCHEMA = 'public'
QUOTES = "'\"`"
REPORT_LIMIT = 20


def fail(message) -> NoReturn:
    sys.exit('FAILED: ' + message)


# ---------- text ----------

def split_top(text, sep=',', brackets='()'):
    """Splits on sep outside brackets and quotes. brackets: pairs of open/close characters, e.g. '()[]{}'."""
    opens, closes = brackets[0::2], brackets[1::2]
    parts, depth, buf, quote = [], 0, [], None
    for ch in text:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in QUOTES:
            quote = ch
        elif ch in opens:
            depth += 1
        elif ch in closes:
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append(''.join(buf).strip())
            buf = []
            continue
        buf.append(ch)
    parts.append(''.join(buf).strip())
    return [p for p in parts if p]


def unquote(text):
    """Removes one pair of quotes: '…', "…", `…` or '''…'''."""
    text = text.strip()
    if text.startswith("'''") and text.endswith("'''") and len(text) >= 6:
        return text[3:-3].strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in QUOTES:
        return text[1:-1].replace("\\'", "'")
    return text


def table_id(name, schema=None):
    return f'{schema or DEFAULT_SCHEMA}.{name}'


def add_ref(refs, from_table, from_columns, to_table, to_columns):
    """One foreign key in schema.json shape; the same key twice is kept once."""
    entry = {'from': {'table': from_table, 'columns': list(from_columns)},
             'to': {'table': to_table, 'columns': list(to_columns)}}
    if entry not in refs:
        refs.append(entry)


# ---------- command line, files, result ----------

def parse_args(description, source_help, many=False):
    parser = argparse.ArgumentParser(description=f'{description} → schema.json for build_diagram.py')
    parser.add_argument('sources', nargs='+' if many else 1, help=source_help)
    parser.add_argument('-o', '--output', required=True, help='where to write schema.json')
    parser.add_argument('--title', default='Database', help='page name')
    parser.add_argument('--lang', default='en', choices=LANGS, help='viewer interface language')
    return parser.parse_args()


def collect_files(paths, pattern, skip=lambda path: False):
    """Files in name order: each folder contributes its matching files (recursively), each file itself."""
    files = []
    for path in map(Path, paths):
        if path.is_dir():
            files += sorted(f for f in path.rglob(pattern) if not skip(f))
        elif path.is_file():
            files.append(path)
        else:
            fail(f'{path} does not exist')
    if not files:
        fail(f'no {pattern} files found')
    return files


def write_schema(args, tables, refs, modules=None):
    """Writes schema.json and checks it with build_diagram's own validation. modules default: one per schema."""
    if modules is None:
        modules = [{'code': code, 'name': code} for code in sorted({t['module'] for t in tables})]
    data = {'title': args.title, 'lang': args.lang, 'modules': modules, 'tables': tables, 'refs': refs}
    Path(args.output).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    try:
        load_schema(args.output)
    except SchemaError as error:
        fail(f'{args.output} was written but does not match the format:\n{error}')
    return data


def report(data, sources, groups):
    """Prints what was read and every group of things left out, then where the file went."""
    columns = sum(len(t['columns']) for t in data['tables'])
    print(f'{sources} → {len(data["tables"])} tables, {columns} columns, {len(data["refs"])} references, '
          f'modules {[m["code"] for m in data["modules"]]}')
    for title, items in groups:
        if items:
            print(f'{title}: {len(items)}')
            for item in items[:REPORT_LIMIT]:
                print('  ' + item)
            if len(items) > REPORT_LIMIT:
                print(f'  … and {len(items) - REPORT_LIMIT} more')
