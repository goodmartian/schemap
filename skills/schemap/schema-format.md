# schema.json format

What `build_diagram.py` reads, and what every importer writes. One JSON object. The build validates all of it and names each problem. Optional fields get the default shown below, in one place: the build.

```json
{
  "title": "Shop",
  "lang": "en",
  "modules": [
    {"code": "sales", "name": "Orders and payments"},
    {"code": "catalog", "name": "Catalog"}
  ],
  "tables": [
    {
      "id": "sales.orders",
      "name": "orders",
      "module": "sales",
      "title": "Orders",
      "note": "One checkout",
      "status": "changed",
      "columns": [
        {"name": "id", "type": "uuid", "pk": true, "nullable": false},
        {"name": "buyer_id", "type": "uuid", "nullable": false, "note": "Who pays"}
      ]
    }
  ],
  "refs": [
    {"from": {"table": "sales.orders", "columns": ["buyer_id"]},
     "to": {"table": "auth.users", "columns": ["id"]}}
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `title` | no, default `Database` | Page name; the browser tab and the artifact show "Shop schema" / «Схема Shop» |
| `lang` | no, default `en` | Viewer interface language: `en` or `ru` |
| `modules` | no, default: one per distinct table `module`, named by its code | Display order and names of the coloured areas. If given, it must list every module the tables use and no others |
| `tables[].id` | yes | Unique id; `schema.table` by convention |
| `tables[].name` | yes | Table name as in the database |
| `tables[].module` | yes | A module `code` |
| `tables[].title` | no | Human name, shown under the table name |
| `tables[].note` | no | What the table is for |
| `tables[].status` | no, default `same` | `new`, `changed` or `same`. With two or more kinds present the viewer shows a status filter |
| `tables[].columns[]` | yes, at least one | In database order |
| `columns[].name`, `.type` | yes | Type as people write it: `timestamptz`, `varchar(50)` |
| `columns[].pk` | no, default `false` | Part of the primary key |
| `columns[].nullable` | no, default `true` | `false` shows "required" |
| `columns[].note` | no | Shown on hover and in the details panel |
| `refs[]` | no, default none | Foreign keys. `from` holds the referencing columns, `to` the referenced ones, the same count on both sides. A composite key is one ref with several columns; the line is drawn between the first columns |

The build fails when an id repeats, a column repeats within a table, a ref points to an unknown table or column, the two sides of a ref differ in length, the same ref appears twice, or `modules` disagrees with the tables.
