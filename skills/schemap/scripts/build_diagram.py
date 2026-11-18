"""schema.json → one self-contained HTML diagram (canvas viewer + embedded data). Python 3.9+, stdlib only.

Usage:
    python3 build_diagram.py schema.json -o diagram.html
    python3 build_diagram.py schema.json --check        # validate only, write nothing

Diagrams in the file, each in two views (all columns; keys only):
- overview: every table with every column, every reference; one area per module, areas in 1-4 rows;
- one diagram per module (only when there are 2+ modules): its tables in full, plus the tables of other
  modules it references, as short cards (only the columns of those references), one area per module.

viewer.template.html is the page as a claude.ai artifact publishes it: no <html>/<head>/<body> of its own.
A file build wraps it in that document skeleton; --artifact writes it as it is.

Layout: same-width columns of cards; the next card goes to the shortest column. A reference is drawn
between the first columns of its key; every column of a composite key is marked FK.
The build fails loudly when the input breaks the format (see ../schema-format.md),
when cards overlap, or when a table falls outside its area. Exit code 1 on any failure.
"""
import argparse
import colorsys
import html
import itertools
import json
import math
import re
import sys
from pathlib import Path
from typing import NoReturn

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / 'viewer.template.html'
DATA_MARK = '{{DIAGRAM_DATA}}'

# Card geometry in canvas units. The viewer reads the same numbers from the embedded data.
CARD_W = 260
# every size is on the 4-point scale the viewer uses: 8 + name 16 + title 16 + 8; a row is 24
CARD_HEAD = 48        # table name and human title
ROW_H = 24
GAP_X = 64            # between card columns: room for reference lines
GAP_Y = 32
AREA_PAD = 24
AREA_TOP = 48         # room for the area name: 12 + label 24 + 12
AREA_GAP = 128        # between areas; on the overview the name of the lower area sits here
VIEW_ASPECT = 1440 / 744
MAX_ROWS = 4          # area rows on the overview

# Module colour: for a dark and for a light background. Neighbouring areas get distant hues.
PALETTE = [
    ('#8eb7ff', '#2563eb'), ('#ff9f74', '#c2410c'), ('#8a61f5', '#6d28d9'),
    ('#c05dcf', '#a21caf'), ('#ffe374', '#a16207'), ('#42e0c0', '#0f766e'),
    ('#9ef07a', '#4d7c0f'), ('#ff6363', '#dc2626'), ('#4dee8a', '#15803d'),
    ('#7dd3fc', '#0369a1'), ('#fda4af', '#be123c'), ('#cbd5e1', '#475569'),
]
NEIGHBOUR_HUE_MIN = 45  # degrees between the hues of neighbouring areas
PK, FK, NULLABLE = 1, 2, 4
MODES = ('all', 'keys')   # views of every diagram: all columns; keys only (primary key and reference ends)
STATUSES = ('new', 'changed', 'same')
LANGS = ('en', 'ru')
WORDS = {
    'en': {'overview': 'Overview', 'database': 'Database', 'page': '{} schema'},
    'ru': {'overview': 'Обзор', 'database': 'База', 'page': 'Схема {}'},
}
# Address slugs: ASCII letters, digits, single hyphens — the only #name a claude.ai artifact link carries.
# claude.ai reserves these names for itself.
RESERVED_SLUGS = {'settings', 'sidebar', 'customize', 'upgrade', 'downloads'}
TEMPLATE_TITLE = '<title>Database diagram</title>'
HEAD_END = '</style>\n'      # the template's title and style go into <head> of a file build, the rest into <body>
DOCUMENT_START = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                  '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
                  '<meta name="color-scheme" content="light dark">\n')


class SchemaError(Exception):
    pass


def fail(message) -> NoReturn:
    sys.exit('FAILED: ' + message)


# ---------- input format ----------

def load_schema(path):
    """Reads schema.json and checks it against the format. Optional fields get their documented defaults here,
    in one place; everything else must be present and consistent, or SchemaError names the problem."""
    try:
        raw = json.loads(Path(path).read_text(encoding='utf-8'))
    except json.JSONDecodeError as error:
        raise SchemaError(f'{path}: not valid JSON: {error}')
    problems = []

    def need(condition, message):
        if not condition:
            problems.append(message)
        return bool(condition)

    lang = raw.get('lang', 'en')
    need(lang in LANGS, f'"lang" must be one of {LANGS}, got {lang!r}')
    tables = raw.get('tables')
    if not need(isinstance(tables, list) and tables, '"tables" must be a non-empty list'):
        raise SchemaError('\n'.join(problems))
    refs = raw.get('refs', [])
    need(isinstance(refs, list), '"refs" must be a list')

    seen_ids = set()
    clean_tables = []
    for n, t in enumerate(tables):
        where = f'tables[{n}]'
        if not need(isinstance(t, dict), f'{where}: must be an object'):
            continue
        tid, name, module = t.get('id'), t.get('name'), t.get('module')
        need(isinstance(tid, str) and tid, f'{where}: "id" must be a non-empty string')
        where = f'table {tid}'
        need(tid not in seen_ids, f'{where}: duplicate id')
        seen_ids.add(tid)
        need(isinstance(name, str) and name, f'{where}: "name" must be a non-empty string')
        need(isinstance(module, str) and module, f'{where}: "module" must be a non-empty string')
        status = t.get('status', 'same')
        need(status in STATUSES, f'{where}: "status" must be one of {STATUSES}, got {status!r}')
        columns = t.get('columns')
        if not need(isinstance(columns, list) and columns, f'{where}: "columns" must be a non-empty list'):
            continue
        names, clean_columns = set(), []
        for c in columns:
            cname = c.get('name') if isinstance(c, dict) else None
            if not need(isinstance(cname, str) and cname, f'{where}: every column needs a "name"'):
                continue
            need(cname not in names, f'{where}: duplicate column {cname}')
            names.add(cname)
            ctype = c.get('type')
            need(isinstance(ctype, str) and ctype, f'{where}.{cname}: "type" must be a non-empty string')
            pk, nullable = c.get('pk', False), c.get('nullable', True)
            need(isinstance(pk, bool) and isinstance(nullable, bool),
                 f'{where}.{cname}: "pk" and "nullable" must be true or false')
            clean_columns.append({'name': cname, 'type': ctype or '', 'pk': pk, 'nullable': nullable,
                                  'note': c.get('note') or ''})
        clean_tables.append({'id': tid, 'name': name, 'module': module, 'status': status,
                             'title': t.get('title') or '', 'note': t.get('note') or '', 'columns': clean_columns})

    by_id = {t['id']: t for t in clean_tables}
    clean_refs = []
    for n, r in enumerate(refs if isinstance(refs, list) else []):
        where = f'refs[{n}]'
        try:
            ends = [(r[side]['table'], list(r[side]['columns'])) for side in ('from', 'to')]
        except (KeyError, TypeError):
            problems.append(f'{where}: needs "from" and "to", each with "table" and "columns"')
            continue
        ok = True
        for table, cols in ends:
            if not need(table in by_id, f'{where}: unknown table {table}'):
                ok = False
                continue
            have = {c['name'] for c in by_id[table]['columns']}
            for col in cols:
                ok &= need(col in have, f'{where}: table {table} has no column {col}')
        ok &= need(len(ends[0][1]) == len(ends[1][1]) and ends[0][1],
                   f'{where}: "from" and "to" need the same non-zero number of columns')
        if ok:
            clean_refs.append({'from': {'table': ends[0][0], 'columns': ends[0][1]},
                               'to': {'table': ends[1][0], 'columns': ends[1][1]}})
    duplicates = len(clean_refs) - len({json.dumps(r, sort_keys=True) for r in clean_refs})
    need(duplicates == 0, f'{duplicates} duplicate references')

    used = []
    for t in clean_tables:
        if t['module'] not in used:
            used.append(t['module'])
    modules = raw.get('modules')
    if modules is None:
        modules = [{'code': code, 'name': code} for code in sorted(used)]
    elif need(isinstance(modules, list), '"modules" must be a list'):
        codes = [m.get('code') for m in modules if isinstance(m, dict)]
        need(len(codes) == len(modules) and all(isinstance(c, str) and c for c in codes),
             'every module needs a "code"')
        need(len(set(codes)) == len(codes), 'duplicate module codes')
        missing = [code for code in used if code not in codes]
        need(not missing, f'tables use modules that "modules" does not list: {missing}')
        unused = [code for code in codes if code not in used]
        need(not unused, f'modules without tables: {unused}')
        modules = [{'code': m['code'], 'name': m.get('name') or m['code']} for m in modules if isinstance(m, dict)]
    if problems:
        raise SchemaError('\n'.join(problems))
    return {'title': raw.get('title') or WORDS[lang]['database'], 'lang': lang,
            'modules': modules, 'tables': clean_tables, 'refs': clean_refs}


def slugger(fallback):
    """Returns slug(text): a unique address slug for each text; texts without ASCII letters get fallback-N."""
    taken = set()

    def slug(text):
        base = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-') or f'{fallback}-{len(taken) + 1}'
        if base in RESERVED_SLUGS or base.startswith('comment-'):
            base = f'{fallback}-{base}'
        candidate, n = base, 2
        while candidate in taken:
            candidate, n = f'{base}-{n}', n + 1
        taken.add(candidate)
        return candidate
    return slug


# ---------- layout ----------

def card_height(column_count):
    return CARD_HEAD + ROW_H * column_count


def rects_intersect(a, b, gap=0):
    """Two {x, y, w, h} rectangles overlap, or come closer than gap."""
    return (a['x'] < b['x'] + b['w'] + gap and a['x'] + a['w'] + gap > b['x']
            and a['y'] < b['y'] + b['h'] + gap and a['y'] + a['h'] + gap > b['y'])


def hue(color):
    r, g, bl = (int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return colorsys.rgb_to_hsv(r, g, bl)[0] * 360


PALETTE_HUE = {pair: hue(pair[0]) for pair in PALETTE}


def hue_distance(a, b):
    d = abs(PALETTE_HUE[a] - PALETTE_HUE[b])
    return min(d, 360 - d)


def assign_colors(codes, rects):
    """A colour per module such that neighbouring areas on the overview differ in hue. Backtracking, the module
    with most neighbours first. Colours are unique while there are enough of them; past that, only neighbours differ."""
    neighbours = {c: [o for o in codes if o != c and rects_intersect(rects[c], rects[o], AREA_GAP + 1)] for c in codes}
    order = sorted(codes, key=lambda c: -len(neighbours[c]))
    unique = len(codes) <= len(PALETTE)
    chosen = {}

    def place(i):
        if i == len(order):
            return True
        code = order[i]
        for pair in PALETTE:
            if unique and pair in chosen.values():
                continue
            if all(hue_distance(pair, chosen[o]) >= NEIGHBOUR_HUE_MIN for o in neighbours[code] if o in chosen):
                chosen[code] = pair
                if place(i + 1):
                    return True
                del chosen[code]
        return False

    if not place(0):
        fail('could not colour the modules so that neighbouring areas differ in hue')
    return chosen


def column_count(items, target_height):
    """How many card columns an area needs so that none is taller than target_height."""
    total = sum(h for _, h in items) + GAP_Y * (len(items) - 1)
    return min(len(items), max(1, math.ceil(total / target_height)))


def pack(items, target_height=None, columns=None):
    """items: [(id, height)], in columns of at most target_height (or exactly `columns` columns).
    Returns the area size and the card places inside it."""
    columns = columns or column_count(items, target_height)
    filled = [0] * columns
    places = []
    for item_id, h in items:
        col = min(range(columns), key=lambda i: (filled[i], i))
        places.append((item_id, col * (CARD_W + GAP_X), filled[col]))
        filled[col] += h + GAP_Y
    return {'w': columns * CARD_W + (columns - 1) * GAP_X + 2 * AREA_PAD,
            'h': max(filled) - GAP_Y + AREA_TOP + AREA_PAD,
            'places': places}


def aspect_score(w, h):
    """First closeness to the window proportions (coarse), then the smallest area."""
    return round(abs(math.log((w / h) / VIEW_ASPECT)), 1), w * h


def targets(items_heights):
    """Column heights to try, every 100 units: from the tallest card up to everything in one column, at most 9 000."""
    tallest = max(items_heights)
    total = sum(items_heights) + GAP_Y * len(items_heights)
    return range(tallest, max(tallest, min(total, 9000)) + 100, 100)


def layout_overview(codes, items_by_module):
    heights = [h for items in items_by_module.values() for _, h in items]
    best, packs = None, {}                            # a packing depends only on the column count: keep each once
    for target in targets(heights):
        packed = {}
        for c in codes:
            key = (c, column_count(items_by_module[c], target))
            if key not in packs:
                packs[key] = pack(items_by_module[c], columns=key[1])
            packed[c] = packs[key]
        # 1–3 modules fit one row; from 4 on, one row makes tall narrow areas whose names get cut
        for rows in range(1 if len(codes) <= 3 else 2, min(len(codes), MAX_ROWS) + 1):
            for cuts in itertools.combinations(range(1, len(codes)), rows - 1):
                bounds = [0, *cuts, len(codes)]
                groups = [codes[a:b] for a, b in zip(bounds, bounds[1:])]
                widths = [sum(packed[c]['w'] for c in g) + AREA_GAP * (len(g) - 1) for g in groups]
                row_heights = [max(packed[c]['h'] for c in g) for g in groups]
                score = aspect_score(max(widths), sum(row_heights) + AREA_GAP * (rows - 1))
                if best is None or score < best[0]:
                    best = (score, packed, groups, row_heights)
    assert best is not None                           # targets() is never empty
    _, packed, groups, row_heights = best
    areas, positions = {}, {}
    y = 0
    for group, row_height in zip(groups, row_heights):
        x = 0
        for code in group:
            p = packed[code]
            areas[code] = {'x': x, 'y': y, 'w': p['w'], 'h': row_height}
            for item_id, dx, dy in p['places']:
                positions[item_id] = (x + AREA_PAD + dx, y + AREA_TOP + dy)
            x += p['w'] + AREA_GAP
        y += row_height + AREA_GAP
    return areas, positions


def layout_module(own, other_groups):
    """own: [(id, height)] of the module itself. other_groups: [(module code, [(id, height)])] — the tables of
    other modules it references, one area per module (the module's name says where a table lives; no colour
    mark needed). Those areas stack in columns to the right, a column no taller than the module's own area."""
    best = None
    heights = [h for _, h in own] + [h for _, items in other_groups for _, h in items]
    for target in targets(heights):
        a = pack(own, target)
        columns, column = [], None
        for code, items in other_groups:
            p = pack(items, max(a['h'] - AREA_TOP - AREA_PAD, max(h for _, h in items)))
            if column is None or (column['items'] and column['h'] + AREA_GAP + p['h'] > a['h']):
                column = {'w': 0, 'h': -AREA_GAP, 'items': []}
                columns.append(column)
            column['items'].append((code, p, column['h'] + AREA_GAP))
            column['h'] += AREA_GAP + p['h']
            column['w'] = max(column['w'], p['w'])
        w = a['w'] + sum(AREA_GAP + c['w'] for c in columns)
        h = max([a['h']] + [c['h'] for c in columns])
        score = aspect_score(w, h)
        if best is None or score < best[0]:
            best = (score, a, columns, h)
    assert best is not None
    _, a, columns, h = best
    areas = {'own': {'x': 0, 'y': 0, 'w': a['w'], 'h': h}}
    positions = {i: (AREA_PAD + dx, AREA_TOP + dy) for i, dx, dy in a['places']}
    x = a['w']
    for column in columns:
        x += AREA_GAP
        for code, p, y in column['items']:
            areas[code] = {'x': x, 'y': y, 'w': p['w'], 'h': p['h']}
            positions.update({i: (x + AREA_PAD + dx, y + AREA_TOP + dy) for i, dx, dy in p['places']})
        x += column['w']
    return areas, positions


class Diagram:
    """Builds one diagram and checks its numbers and geometry."""

    def __init__(self, code, mode, slug, name, label, module):
        self.data = {'code': code, 'mode': mode, 'slug': slug, 'name': name, 'label': label, 'module': module,
                     'areas': [], 'tables': [], 'refs': []}
        self.table_index, self.column_index, self.table_area = {}, {}, []
        self.rows = 0

    def add_area(self, name, rect, module):
        self.data['areas'].append({'name': name, 'module': module, **rect, 'count': 0})
        return len(self.data['areas']) - 1

    def add_table(self, t, shown, xy, area):
        """shown — names of the columns that go on the card. The columns themselves live in the shared table list."""
        indexes = [i for i, c in enumerate(t['columns']) if c['name'] in shown]
        self.table_index[t['id']] = len(self.data['tables'])
        self.column_index[t['id']] = {t['columns'][i]['name']: n for n, i in enumerate(indexes)}
        self.table_area.append(area)
        self.data['areas'][area]['count'] += 1
        self.rows += len(indexes)
        entry = {'id': t['id'], 'x': xy[0], 'y': xy[1], 'h': card_height(len(indexes))}
        if len(indexes) < len(t['columns']):
            entry['cols'] = indexes                   # short card: indexes of the shown columns
        self.data['tables'].append(entry)

    def add_ref(self, r):
        a, b = r['from'], r['to']
        self.data['refs'].append([self.table_index[a['table']], self.column_index[a['table']][a['columns'][0]],
                                  self.table_index[b['table']], self.column_index[b['table']][b['columns'][0]]])

    def check(self, expect_tables, expect_refs, expect_areas):
        d = self.data
        got = (len(d['tables']), len(d['refs']), len(d['areas']))
        if got != (expect_tables, expect_refs, expect_areas):
            fail(f"{d['name']}: tables, references, areas {got}, expected {(expect_tables, expect_refs, expect_areas)}")
        cards = [{'x': t['x'], 'y': t['y'], 'w': CARD_W, 'h': t['h'], 'id': t['id']} for t in d['tables']]
        overlaps = sum(1 for a, b in itertools.combinations(cards, 2) if rects_intersect(a, b))
        if overlaps:
            fail(f"{d['name']}: {overlaps} pairs of cards overlap")
        for card, own in zip(cards, self.table_area):
            holders = [i for i, a in enumerate(d['areas'])
                       if card['x'] >= a['x'] and card['y'] >= a['y']
                       and card['x'] + card['w'] <= a['x'] + a['w'] and card['y'] + card['h'] <= a['y'] + a['h']]
            if holders != [own]:
                fail(f"{d['name']}: table {card['id']} is outside its area")
        for a, b in itertools.combinations(d['areas'], 2):
            if rects_intersect(a, b):
                fail(f"{d['name']}: areas overlap: {a['name']} and {b['name']}")
        d['size'] = [max(a['x'] + a['w'] for a in d['areas']), max(a['y'] + a['h'] for a in d['areas'])]
        print(f"{d['name']} [{d['mode']}]: {got[0]} tables, {self.rows} column rows, {got[1]} references, {got[2]} areas, "
              f"{d['size'][0]}×{d['size'][1]}")
        return self.rows


def build(schema):
    words = WORDS[schema['lang']]
    title = schema['title']
    modules = schema['modules']
    codes = [m['code'] for m in modules]
    module_name = {m['code']: m['name'] for m in modules}
    tables, refs = schema['tables'], schema['refs']
    by_id = {t['id']: t for t in tables}
    columns_total = sum(len(t['columns']) for t in tables)

    referenced, fk_columns = {}, {t['id']: set() for t in tables}
    for r in refs:
        referenced[r['to']['table']] = referenced.get(r['to']['table'], 0) + 1
        fk_columns[r['from']['table']].update(r['from']['columns'])
    # most referenced tables first: they land at the top of their area
    by_module = {c: sorted((t for t in tables if t['module'] == c),
                           key=lambda t: (-referenced.get(t['id'], 0), t['name'])) for c in codes}

    # Two views of every diagram: all columns, and keys only (primary key and both ends of every reference).
    # Colours come from the full overview and stay the same in both views.
    keys = {t['id']: {c['name'] for c in t['columns'] if c['pk']} for t in tables}
    for r in refs:
        keys[r['from']['table']].update(r['from']['columns'])
        keys[r['to']['table']].update(r['to']['columns'])
    keys_total = sum(len(v) for v in keys.values())
    diagram_slug, table_slug = slugger('diagram'), slugger('table')
    slugs = {code: diagram_slug(code) for code in ['overview', *codes]}
    diagrams, colors = [], {}
    inner_total = outer_total = 0
    for mode in MODES:
        def shown(t, mode=mode):
            return {c['name'] for c in t['columns']} if mode == 'all' else keys[t['id']]

        d = Diagram('overview', mode, slugs['overview'], f'{title} — {words["overview"].lower()}', words['overview'], None)
        areas_xy, positions = layout_overview(
            codes, {c: [(t['id'], card_height(len(shown(t)))) for t in by_module[c]] for c in codes})
        if mode == 'all':                             # colours from the full overview, the same in both views
            colors = assign_colors(codes, areas_xy)
        area_of = {c: d.add_area(module_name[c], areas_xy[c], c) for c in codes}
        for t in tables:
            d.add_table(t, shown(t), positions[t['id']], area_of[t['module']])
        for r in refs:
            d.add_ref(r)
        if d.check(len(tables), len(refs), len(codes)) != (columns_total if mode == 'all' else keys_total):
            fail(f'overview ({mode}): column rows differ from the schema')
        diagrams.append(d.data)

        for code in codes if len(codes) > 1 else []:
            d = Diagram(code, mode, slugs[code], f'{title} — {module_name[code]}', module_name[code], code)
            own = by_module[code]
            own_ids = {t['id'] for t in own}
            touching = [r for r in refs if r['from']['table'] in own_ids or r['to']['table'] in own_ids]
            if mode == 'all':
                inner = sum(1 for r in touching if r['from']['table'] in own_ids and r['to']['table'] in own_ids)
                inner_total += inner
                outer_total += len(touching) - inner
            other_columns = {}
            for r in touching:
                for end in (r['from'], r['to']):
                    if end['table'] not in own_ids:
                        other_columns.setdefault(end['table'], set()).update(end['columns'])
            others = sorted((by_id[i] for i in other_columns), key=lambda t: (codes.index(t['module']), t['name']))
            other_codes = [c for c in codes if any(t['module'] == c for t in others)]
            areas_xy, positions = layout_module(
                [(t['id'], card_height(len(shown(t)))) for t in own],
                [(c, [(t['id'], card_height(len(other_columns[t['id']]))) for t in others if t['module'] == c])
                 for c in other_codes])
            own_area = d.add_area(module_name[code], areas_xy['own'], code)
            for t in own:
                d.add_table(t, shown(t), positions[t['id']], own_area)
            other_area = {c: d.add_area(module_name[c], areas_xy[c], c) for c in other_codes}
            for t in others:
                d.add_table(t, other_columns[t['id']], positions[t['id']], other_area[t['module']])
            for r in touching:
                d.add_ref(r)
            d.check(len(own) + len(others), len(touching), 1 + len(other_codes))
            diagrams.append(d.data)
    if len(codes) > 1 and (inner_total + outer_total // 2 != len(refs) or outer_total % 2):
        fail(f'references by module do not add up: inside {inner_total}, outward {outer_total}')

    # Shared table list: columns with notes and foreign-key targets. Diagrams point into it by id.
    link_targets = {}
    for r in refs:
        for column, to_column in zip(r['from']['columns'], r['to']['columns']):
            links = link_targets.setdefault((r['from']['table'], column), [])
            if [r['to']['table'], to_column] not in links:
                links.append([r['to']['table'], to_column])
    registry, notes = {}, 0
    for t in tables:
        columns = []
        for c in t['columns']:
            item = [c['name'], c['type'],
                    (PK if c['pk'] else 0) | (FK if c['name'] in fk_columns[t['id']] else 0)
                    | (NULLABLE if c['nullable'] else 0),
                    c['note']]
            notes += bool(c['note'])
            if (t['id'], c['name']) in link_targets:
                item.append(link_targets[(t['id'], c['name'])])
            columns.append(item)
        registry[t['id']] = {'name': t['name'], 'slug': table_slug(t['id']), 'module': t['module'], 'status': t['status'],
                             'title': t['title'], 'note': t['note'], 'columns': columns}
    data = {
        'lang': schema['lang'],
        'card': {'width': CARD_W, 'head': CARD_HEAD, 'row': ROW_H, 'areaTop': AREA_TOP, 'areaPad': AREA_PAD, 'areaGap': AREA_GAP},
        'modules': [{'code': c, 'name': module_name[c], 'dark': colors[c][0], 'light': colors[c][1]} for c in codes],
        'tables': registry,
        'diagrams': diagrams,
    }
    summary = [f'column notes: {notes} of {columns_total}',
               f'tables {len(tables)}, columns {columns_total}, references {len(refs)}, modules {len(codes)}']
    if len(codes) > 1:
        summary.append(f'references inside modules {inner_total}, between modules {outer_total // 2}')
    summary.append('cards overlap: 0; every table inside its area; areas do not overlap')
    return data, summary


def main():
    parser = argparse.ArgumentParser(description='schema.json → self-contained HTML database diagram')
    parser.add_argument('schema', help='path to schema.json')
    parser.add_argument('-o', '--output', help='where to write the HTML (default: next to schema.json, diagram.html)')
    parser.add_argument('--check', action='store_true', help='validate and lay out, write nothing')
    parser.add_argument('--artifact', action='store_true',
                        help='write the page without <html>/<head>/<body>, for publishing as a claude.ai artifact')
    args = parser.parse_args()
    try:
        schema = load_schema(args.schema)
    except SchemaError as error:
        fail(f'{args.schema} does not match the format:\n{error}')
    data, summary = build(schema)
    print('\n'.join(summary))
    if args.check:
        print('check only: nothing written')
        return
    page = TEMPLATE.read_text(encoding='utf-8')
    for mark in (DATA_MARK, TEMPLATE_TITLE, HEAD_END):
        if page.count(mark) != 1:
            fail(f'{TEMPLATE.name} must contain {mark.strip()} exactly once')
    page_title = WORDS[schema['lang']]['page'].format(schema['title'])
    # "</" inside <script> would close it early
    embedded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    page = page.replace(TEMPLATE_TITLE, f'<title>{html.escape(page_title)}</title>').replace(DATA_MARK, embedded)
    if not args.artifact:                             # a file needs the document skeleton the artifact host adds
        head, _, body = page.partition(HEAD_END)
        page = f'{DOCUMENT_START}{head}{HEAD_END}</head>\n<body>\n{body}</body>\n</html>\n'
    default_name = 'diagram.artifact.html' if args.artifact else 'diagram.html'
    out = Path(args.output) if args.output else Path(args.schema).resolve().parent / default_name
    out.write_text(page, encoding='utf-8')
    print(f'written: {out} — {len(data["diagrams"])} diagrams, {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
