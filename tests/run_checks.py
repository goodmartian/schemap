"""Self-check of the plugin: the three importers read the same shop identically, and every result builds.

Run from anywhere:  python3 tests/run_checks.py
Exit code 0 when everything agrees. Writes nothing outside a temporary folder.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS, FIXTURES = ROOT / 'skills' / 'schemap' / 'scripts', ROOT / 'tests' / 'fixtures'
IMPORTERS = {'sql': ('import_sql.py', 'shop.sql'), 'prisma': ('import_prisma.py', 'shop.prisma'),
             'dbml': ('import_dbml.py', 'shop.dbml')}
EXPECT = {'tables': 9, 'columns': 34, 'refs': 9, 'modules': 3}


def run(*args):
    result = subprocess.run([sys.executable, '-I', *map(str, args)], capture_output=True, text=True)
    if result.returncode:
        sys.exit(f'FAILED: {" ".join(map(str, args))}\n{result.stdout}{result.stderr}')
    return result.stdout


def shape(schema):
    """What must match across importers: tables, columns with key and nullability, references."""
    columns = {(t['id'], c['name'], c['pk'], c['nullable']) for t in schema['tables'] for c in t['columns']}
    refs = {(r['from']['table'], tuple(r['from']['columns']), r['to']['table'], tuple(r['to']['columns']))
            for r in schema['refs']}
    return {t['id'] for t in schema['tables']}, columns, refs


def main():
    failures, shapes = [], {}
    with tempfile.TemporaryDirectory() as tmp:
        for name, (script, fixture) in IMPORTERS.items():
            out = Path(tmp) / f'{name}.json'
            run(SCRIPTS / script, FIXTURES / fixture, '-o', out, '--title', 'Shop')
            schema = json.loads(out.read_text(encoding='utf-8'))
            got = {'tables': len(schema['tables']), 'columns': sum(len(t['columns']) for t in schema['tables']),
                   'refs': len(schema['refs']), 'modules': len(schema['modules'])}
            if got != EXPECT:
                failures.append(f'{name}: {got}, expected {EXPECT}')
            shapes[name] = shape(schema)
            run(SCRIPTS / 'build_diagram.py', out, '-o', Path(tmp) / f'{name}.html')
            run(SCRIPTS / 'build_diagram.py', out, '-o', Path(tmp) / f'{name}.artifact.html', '--artifact')
        for name, value in shapes.items():
            if value != shapes['sql']:
                failures.append(f'{name} differs from sql: '
                                f'{[sorted(x ^ y)[:5] for x, y in zip(value, shapes["sql"])]}')
    if failures:
        sys.exit('FAILED:\n' + '\n'.join(failures))
    print(f'ok: {", ".join(IMPORTERS)} agree on {EXPECT}; all built as a file and as an artifact page')


if __name__ == '__main__':
    main()
