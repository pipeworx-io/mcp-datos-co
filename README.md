# @pipeworx/datos-co

Colombia national open data: generic dataset search/query tools, plus a lookup for Colombian collective investment funds (fondos de inversión colectiva, FIC).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1882+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `search_datasets(q)`, `dataset_columns(datasetId)`, `query_dataset(datasetId, $where, ...)` — generic access to any dataset on the national open-data portal.
- `co_fic_search(name)` — find a fund by name or by its management company. Case, accents and word order do not matter; one typo per word is tolerated. Returns `fund_code`, entity and fund name, or `found:false` with the closest names.
- `co_fic_unit_value(fund | fund_code, date?, from?, to?, participation_class?)` — unit value (valor de la unidad), fund size, investors and daily/monthly/semester/annual returns per participation class. Default is the latest published day.

## Behaviour worth knowing

- A name that matches nothing returns `found:false` with `reason: "no_fund_matches_all_words"` and the `closest` funds. A name that matches several returns `reason: "ambiguous_fund_name"` with `candidates`; pass `fund_code` to choose. A malformed date or missing fund is an error, not a miss.
- Publication lags a few days; `data_as_of` is the latest published day and `fund_last_reported` the fund's own last row. A requested date past that returns `fund_matched_but_no_rows_for_request`.
- Duplicate upstream rows are collapsed to one per day and participation class.
- Return fields: the regulator publishes percentages but does not document their basis. Our reading, verified against the same unit-value series: each is an effective annual rate (compounded to 365 days) over a trailing 1 / 30 / 183 / 365-day window, so the daily figure is annualised, not the day's price change.
- Only funds that reported in the last 30 days are searchable.

## Auth

Keyless. No platform key.

## Data source

Superintendencia Financiera de Colombia, daily collective investment fund (FIC) series, published on the national open-data portal. Proxied per request; nothing is mirrored.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "datos-co": {
      "url": "https://gateway.pipeworx.io/datos-co/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/datos-co/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1882+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/datos_co_search_datasets \
  -H 'Content-Type: application/json' \
  -d '{"q":"covid"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/datos_co_search_datasets`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "datos-co": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-datos-co"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-datos-co
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Datos Co data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
