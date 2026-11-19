---
layout: docu
redirect_from:
- /docs/sql/introduction
- /docs/stable/sql/introduction
title: SQL Introduction
blurb: A short introduction to SQL.
---

This page gives an overview. It is adapted from the [PostgreSQL tutorial](https://www.postgresql.org/docs/current/tutorial-sql-intro.html).

> DuckDB's SQL dialect follows PostgreSQL. See the [compatibility page]({% link docs/2.0/sql/dialect/postgresql_compatibility.md %}) and the [install page]({% link docs/2.0/installation.html %}?environment=cli).

{% include tooltip.html label="Primary" id="support_tier_primary" %}

## Concepts

DuckDB is a relational database. A blog post: [CSV sniffer]({% post_url 2023-10-27-csv-sniffer %}).

{% raw %}
Literal `{{ braces }}` stay.
{% endraw %}

<div class="monospace_table"></div>

## Example

```sql
SELECT '{% link docs/2.0/not-a-link.md %}' AS kept;
```

<div class="language-c highlighter-rouge"><div class="highlight"><pre class="highlight"><code><span class="kt">int</span> <span class="n">x</span> <span class="o">=</span> <span class="mi">1</span><span class="p">;</span> <span class="c1">// a &lt; b</span>
</code></pre></div></div>

### Details

See [the select page]({% link docs/2.0/sql/statements/select.md %}#where-clause) and [a sibling](overview.md).
