---
layout: docu
title: SELECT Statement
blurb: The SELECT statement retrieves rows from the database.
---

The `SELECT` statement retrieves rows. See the [introduction]({% link docs/2.0/sql/introduction.md %}).

## Syntax

```sql
SELECT * FROM tbl;
```

## WHERE Clause

The `WHERE` clause filters rows before grouping.

### Examples

Filter by a column:

```sql
SELECT * FROM tbl WHERE id = 1;
```
