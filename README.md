# mcp-datos-co

datos.gov.co — Colombia's national open-data portal (Socrata platform).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_datasets` | Search datasets published on Colombia's open-data portal datos.gov.co. Returns each dataset's Socrata 4x4 id (e.g. "gt2j-8ykr"), name, and description (Spanish). Use the id with dataset_columns and query_dataset. Query terms can be Spanish or English (e.g. "covid", "presupuesto", "contratos"). |
| `dataset_columns` | List the columns of a datos.gov.co dataset: field name (used in SoQL $select/$where), human label, and data type. Call this before query_dataset so you know which fields exist. datasetId is the Socrata 4x4 code from search_datasets. |
| `query_dataset` | Query rows from a datos.gov.co dataset using SoQL. datasetId is the Socrata 4x4 code from search_datasets. SoQL clauses: $select (columns / aggregates like "count(*)"), $where (SQL-like filter, e.g. "departamento_nom='BOGOTA' AND edad > 60"), $order ("count desc"), $group, $q (full-text across the row). Use dataset_columns first to learn field names. Returns an array of row objects keyed by field name. Default $limit is 50 (Socrata max per page is 50000). |

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Datos Co data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
