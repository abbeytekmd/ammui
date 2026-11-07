"""Builds lib/data/cofid.json, the UK food table used for ingredient calories, from
McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID).

Download the dataset spreadsheet from
https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid
then run:  python scripts/build-cofid.py path/to/CoFID.xlsx

Only the standard library is used (an .xlsx is a zip of XML files). Each food keeps its
code, name, kcal, and grams of protein, carbohydrate, fat and alcohol, per 100 g (per 100 ml for
alcoholic drinks). Where kcal is given as N (not known) the kJ figure is converted; Tr (trace)
counts as 0, and a protein, carbohydrate, fat or alcohol figure that isn't known is null.
"""
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
SHEET = '1.3 Proximates'
OUT = os.path.join(os.path.dirname(__file__), '..', 'lib', 'data', 'cofid.json')


def sheet_rows(path, sheet_name):
    z = zipfile.ZipFile(path)
    shared = [''.join(t.text or '' for t in si.iter('{%s}t' % NS['m']))
              for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
    rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    sheets = {s.get('name'): rels[s.get('{%s}id' % NS['r'])]
              for s in ET.fromstring(z.read('xl/workbook.xml')).find('m:sheets', NS)}
    part = 'xl/' + sheets[sheet_name].lstrip('/').replace('xl/', '')
    for row in ET.fromstring(z.read(part)).iter('{%s}row' % NS['m']):
        cells = {}
        for c in row.findall('m:c', NS):
            v = c.find('m:v', NS)
            if v is None:
                continue
            col = 0
            for ch in re.match(r'[A-Z]+', c.get('r')).group(0):
                col = col * 26 + ord(ch) - 64
            cells[col - 1] = shared[int(v.text)] if c.get('t') == 's' else v.text
        if cells:
            yield [cells.get(i, '') for i in range(max(cells) + 1)]


def number(value):
    value = (value or '').strip()
    if value == 'Tr':
        return 0.0
    try:
        return float(value)
    except ValueError:
        return None


def main(path):
    rows = sheet_rows(path, SHEET)
    header = next(rows)
    col = {name: i for i, name in enumerate(header)}
    code, name = col['Food Code'], col['Food Name']
    kcal_col, kj_col = col['Energy (kcal) (kcal)'], col['Energy (kJ) (kJ)']
    macro_cols = [col['Protein (g)'], col['Carbohydrate (g)'], col['Fat (g)'], col['Alcohol (g)']]
    foods, skipped = [], 0
    for row in rows:
        if not re.match(r'^\d', row[code] if len(row) > code else ''):
            continue  # the two extra header rows
        cell = lambda i: row[i] if len(row) > i else ''
        kcal = number(cell(kcal_col))
        if kcal is None:
            kj = number(cell(kj_col))
            kcal = None if kj is None else kj / 4.184
        if kcal is None:
            skipped += 1
            continue
        macros = [number(cell(i)) for i in macro_cols]
        foods.append([row[code].strip(), ' '.join(row[name].split()), round(kcal, 1),
                      *(None if m is None else round(m, 1) for m in macros)])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({
            'source': "McCance and Widdowson's The Composition of Foods Integrated Dataset 2021, Public Health England. "
                      'Contains public sector information licensed under the Open Government Licence v3.0.',
            'foods': foods,
        }, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Wrote {len(foods)} foods to {os.path.normpath(OUT)} ({skipped} without an energy figure skipped)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
