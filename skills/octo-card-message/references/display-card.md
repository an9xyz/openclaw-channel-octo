# Display Cards

Read this file before using `octo_send_display_card` or changing automatic progress-card presentation.

## Contents

- [Use a display card for structured output](#use-a-display-card-for-structured-output)
- [DisplayBlock input](#displayblock-input)
- [Design rules](#design-rules)
- [Progress-card boundary](#progress-card-boundary)
- [Failure and fallback](#failure-and-fallback)

## Use a display card for structured output

Use `octo_send_display_card` for status reports, key-value summaries, comparisons, tables, folded details, local copy buttons, and safe navigation links. It produces octo/v1 content with no bot callback. `copy`, `link`, and `collapsible` are client-local actions; they do not resume the agent.

Use plain text for short answers and normal conversation. Use `octo_send_card`, not a display card, when a button must call back to the bot.

## DisplayBlock input

Pass `{ title?, blocks[] }`. Author high-level blocks; never put raw Adaptive Card elements in `blocks`.

| Block | Required fields | Intended use |
|---|---|---|
| `heading` | `text`; optional `size: medium\|large` | Short section heading |
| `text` | `text` | Body paragraph |
| `rich` | `segments[{text,bold?,subtle?,fontType?,color?}]` | Compact styled line |
| `facts` | `items[{label,value}]` | Key-value details |
| `columns` | `columns[{blocks[]}]` | Summary/KPI strip |
| `table` | `rows[{cells[]}]`; optional `columns`, `firstRowAsHeader` | Dense matrix |
| `link` | `text`, `url` | Safe HTTP(S) navigation |
| `group` | `blocks[]`; optional `style` | Small semantic callout |
| `collapsible` | `summary`, `blocks[]`; optional labels/visibility | Fold long details |
| `copy` | `text`; optional `label` | Local clipboard action |

Example:

```jsonc
{
  "title": "发布检查",
  "blocks": [
    {
      "type": "columns",
      "columns": [
        { "blocks": [{ "type": "heading", "text": "测试" }, { "type": "text", "text": "通过" }] },
        { "blocks": [{ "type": "heading", "text": "风险" }, { "type": "text", "text": "低" }] }
      ]
    },
    {
      "type": "facts",
      "items": [
        { "label": "版本", "value": "v1.2.3" },
        { "label": "环境", "value": "staging" }
      ]
    },
    {
      "type": "collapsible",
      "summary": "详情",
      "expandLabel": "展开详情",
      "collapseLabel": "收起详情",
      "blocks": [{ "type": "text", "text": "所有必需检查均已完成。" }]
    }
  ]
}
```

The tool probes octo/v1 capabilities, degrades unsupported block types to safe text where possible, derives a truthful `plain` fallback, applies recursive payload limits, and removes secret-shaped content. Do not probe the profile yourself when using the tool.

## Design rules

- Keep exactly one title and a compact first screen, normally 3–6 lines.
- Use `columns` for a small top summary and `facts` for detail fields.
- Put long process details or evidence in one `collapsible` block. Summarize reasoning stages; do not paste raw tool events, stack traces, long paths, or logs.
- Do not pre-truncate content or add your own "省略 N 项" / "超出限制" / "超出服务端限制" notices. Pass the full set of high-level blocks; the tool enforces `max_nodes` / `max_depth` / `max_payload_bytes` recursively and degrades or drops to fit. If the content genuinely cannot fit as a card, reply in plain text instead of sending a hand-trimmed card annotated with a server-limit note.
- Use no `group.style` for ordinary information. Use `emphasis` for a small neutral callout and `good`, `warning`, or `attention` only for a real status.
- Use `copy` only for local clipboard content. It is not a confirmation button.
- Keep URLs and all visible/fallback text non-sensitive. Hidden and copied content is still stored in the group-visible card JSON.
- After the tool returns, send a one-line text result so the turn does not end on a side effect.

## Progress-card boundary

Automatic agent progress cards are display-only octo/v1 cards managed by the plugin lifecycle; do not replace them with `octo_send_card` or wait for callbacks from them.

When maintaining their renderer, emit `metadata.octo_layout="agent_progress_v1"` only when both `ColumnSet` and `Container` are supported and the top-level body is exactly `[ColumnSet, Container#timeline_detail]`. Otherwise render an ordinary flat card without that metadata. Running details stay visible; terminal details default collapsed when toggle support is available. Put warning/error styling on child step containers, not the entire detail container.

## Failure and fallback

If `octo_send_display_card` is absent, disabled, the profile probe fails, or no safe card fits the negotiated limits, send the answer as plain text. Unlike `octo_send_card`'s unsupported-v2 path, a display-tool error does not itself send a fallback message.

The tool always derives the current Octo account/channel/thread from runtime context and sends as the bot. Do not add target or persona fields to the arguments.
