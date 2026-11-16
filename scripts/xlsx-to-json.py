"""One-off: convert the STS IT Project Portfolio workbook ('Project Summary' sheet) to JSON for
scripts/seed-projects.mjs.   python scripts/xlsx-to-json.py <workbook.xlsx> <out.json>
Header row is row 3. Dates become YYYY-MM-DD; everything else is passed through untouched so the
seed script can validate it. Rows with no Project ID are skipped."""
import datetime
import json
import sys
import warnings

import openpyxl

warnings.filterwarnings("ignore")
src, out = sys.argv[1], sys.argv[2]
ws = openpyxl.load_workbook(src, data_only=True)["Project Summary"]
headers = [c.value for c in ws[3]]
rows = []
for r in ws.iter_rows(min_row=4):
    rec = {}
    for h, c in zip(headers, r):
        if h is None or c.value is None:
            continue
        v = c.value
        if isinstance(v, (datetime.datetime, datetime.date)):
            v = v.strftime("%Y-%m-%d")
        elif isinstance(v, str):
            v = v.strip()
            if v == "":
                continue
        rec[h] = v
    if rec.get("Project ID"):
        rows.append(rec)
json.dump(rows, open(out, "w", encoding="utf8"), indent=1, ensure_ascii=False)
print(f"wrote {len(rows)} projects to {out}")
