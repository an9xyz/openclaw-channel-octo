# Card Messages Reference

Use this reference when sending or editing `payload.type=17` card messages, using `octo_send_display_card`, designing normal information cards, or working on agent progress cards.

## When To Use Cards

- Plain text (`payload.type=1`): conversational replies, short answers, follow-ups.
- Display card (`payload.type=17`, `profile="octo/v1"`): structured, non-callback output such as status reports, key-value summaries, tables, collapsible detail sections, and local copy buttons. It has no bot callback.
- Submit-interactive card (`profile="octo/v2"`): user clicks a button and the bot receives a `card_action` event. Use only when click-back is required.

Do not overuse card messages. Plain text is the default. Use cards only when structure materially improves comprehension, such as weather, status, lists, comparisons, or detail fields. Keep ordinary chat, short answers, and follow-up replies as plain text. Do not use a blanket "use cards whenever possible" rule.

Always feature-detect before sending cards:

```bash
curl <apiUrl>/v1/bot/card/profile -H "Authorization: Bearer $TOKEN"
```

Important profile fields:

```jsonc
{
  "enabled": true,
  "card_version": "1.5",
  "profiles": ["octo/v1", "octo/v2"],
  "elements": ["TextBlock","RichTextBlock","Container","ColumnSet","FactSet","Image","ImageSet","Table","ActionSet"],
  "inputs": ["Input.Text","Input.Toggle","Input.ChoiceSet","Input.Number","Input.Date","Input.Time"],
  "actions": ["Action.OpenUrl","Action.ToggleVisibility","Action.CopyToClipboard"],
  "limits": { "max_payload_bytes": 524288, "max_nodes": 200, "max_depth": 16 }
}
```

- If `available` is false or `enabled` is false, do not send cards.
- `elements` / `inputs` / `actions` are authoritative. Missing support can produce server 400.
- `elements` lists renderable card elements such as `ColumnSet` and `Table`; it does not need to list child schemas such as `Column`, `TableRow`, or `TableCell`.
- Old deployments may omit capability lists; fall back to `TextBlock` / `Container` / `ColumnSet` / `FactSet` / `Image`, and no actions.
- Respect `limits.max_nodes` and `max_depth`.

## Canonical Structure

Think IM summary card + expandable details, not logs converted into a card.

For final answers, prefer one display card message. If the answer needs a process affordance, put process as the first block inside that same card; do not send or leave a separate final process-only card.

Visible first screen should normally be 3-6 lines. If process information is included, show only a compact process summary plus answer content; detailed process opens under `查看过程`.

Process detail shape:

1. Status line: completed / running / failed + step count + elapsed time.
2. Summary line: reasoning stages, tool calls, failures.
3. Reasoning sections: 2-3 human-readable stage summaries; fold overflow stages and raw details.

Do not send raw `tool_events` as the card structure. Convert them into `reasoning_sections`: each section has one natural-language reasoning sentence and optional tool evidence. Keep parameters subtle and shortened. Put full calls, long paths, stack traces, and verbose logs behind `collapsible` / `Action.ToggleVisibility`.

`plain` is first-class output. Generate it from the same source as the card, keep exactly one title, and do not dump raw logs into it.

## Preferred DisplayBlock Shape

```jsonc
{
  "title": "天气卡片（模拟）",
  "blocks": [
    {
      "type": "collapsible",
      "summary": "已深度思考 · 12.3s · 3 段推理 · 4 次工具调用",
      "actionLabel": "查看过程",
      "blocks": [
        { "type": "text", "text": "先确认用户要天气摘要卡，而不是额外发送过程卡或日志卡。" },
        { "type": "rich", "segments": [
          { "text": "fetch_weather", "bold": true, "color": "accent" },
          { "text": "  city=上海 fields=weather,temp,rain_chance · 171ms", "color": "default" }
        ] },
        { "type": "text", "text": "再把首屏组织成天气、温度、降水概率三块摘要，明细只保留城市、时间、来源。" }
      ]
    },
    {
      "type": "columns",
      "columns": [
        { "blocks": [{ "type": "heading", "text": "天气" }, { "type": "text", "text": "多云转晴" }] },
        { "blocks": [{ "type": "heading", "text": "温度" }, { "type": "text", "text": "28°C / 35°C" }] },
        { "blocks": [{ "type": "heading", "text": "降水概率" }, { "type": "text", "text": "12%" }] }
      ]
    },
    {
      "type": "facts",
      "items": [
        { "label": "城市", "value": "上海" },
        { "label": "更新时间", "value": "2026-07-10 06:57 UTC" },
        { "label": "数据源", "value": "模拟数据" }
      ]
    },
    { "type": "copy", "label": "复制天气摘要", "text": "上海：多云转晴，28°C / 35°C，降水概率 12%。" }
  ]
}
```

Rules enforced by this example:

- Process, if shown, is part of the card message (`collapsible` first block), not a separate process card.
- Use stage-level reasoning summaries, not raw `tool_events`.
- Keep exactly one title. Do not repeat the same title as the first `heading`.
- Use `columns` for top summary strips such as weather / temperature / rain chance.
- Use `facts` for detail fields, not for the whole card body.
- Use `copy` for local clipboard copy; it does not call back to the bot.

## Normal Information Cards

Normal information cards should look like quiet IM content, not status banners.

- Use no `group.style` for ordinary summaries by default; use `style: "emphasis"` only for a small neutral callout.
- Do not wrap a whole weather/example/info card in `style: "good"` / `"warning"` / `"attention"`. Reserve those colors for actual success, pending, risk, or error sections.
- Keep gray/tinted blocks small. Put `facts` as its own detail block instead of nesting paragraphs + FactSet + buttons inside one large tinted container.
- Limit title hierarchy: one card `title`, then short labels in `columns` or one section heading. Avoid three stacked Bolder headings.
- Put `copy` near the content it copies, either below the summary or in the same local area; do not make it read like the primary CTA of a large green block.
- Name detail folds plainly: summary `"详情"` / `"过程"`; button labels `"展开详情"` / `"收起详情"` for non-process details, and `"查看过程"` only for reasoning/process sections.
- Use fewer emoji. A single status symbol is acceptable; do not prefix every row with mixed emoji.

## DisplayBlock Reference

| Block | Renders to | Purpose | Degrades to |
|---|---|---|---|
| `heading` (text, size?) | Bolder TextBlock | Section title | Always available |
| `text` (text) | TextBlock | Body paragraph | Always available |
| `rich` (segments[]) | RichTextBlock + TextRun inlines (`bold`, `color`, `fontType:"Monospace"`) | One-line multi-style text | TextBlock, segments joined |
| `facts` (items[]) | FactSet | Key-value rows | TextBlock `label:value` rows |
| `columns` (columns[].blocks[]) | ColumnSet | Summary/KPI strip | One TextBlock line joined with pipes |
| `table` (columns?, rows[].cells[]) | Table | Dense matrix data | TextBlock rows joined with pipes |
| `link` (text, url) | ActionSet `Action.OpenUrl`, or TextBlock `selectAction` fallback | Visible local/navigation link | TextBlock `text: url` |
| `group` (blocks[], style?) | Container with `style: good/warning/attention/emphasis` | Grouped/tinted section | Flattened |
| `collapsible` (summary, actionLabel?/expandLabel?/collapseLabel?/defaultVisible?, blocks[]) | Summary ColumnSet + right-side ActionSet buttons + Container `isVisible` | Fold long details | Summary + inner blocks expanded |
| `copy` (label?, text) | ActionSet `Action.CopyToClipboard` | Local copy, no bot callback | TextBlock containing copy text |

Capability rules:

- `collapsible` requires `Container`, `ColumnSet`, `ActionSet`, and `Action.ToggleVisibility`.
- `copy` requires `ActionSet` and `Action.CopyToClipboard`.
- `link` should render a visible ActionSet button when `ActionSet` and `Action.OpenUrl` are advertised. Never put `Action.Submit` in `selectAction`.
- `table` may use `columns: [{ "width": 1 }, { "width": 2 }]`, `firstRowAsHeader`, simple cells (`{ "text": "..." }`), or rich cells (`{ "blocks": [...] }`).
- `copy.text` is limited to 4KiB measured as UTF-8 bytes.
- `RichTextBlock.inlines` must be objects such as `{ "type": "TextRun", "text": "..." }`; current frontend validation does not accept Adaptive Cards string shorthand.

## Agent Progress Cards

Agent response progress cards use a separate renderer contract:

```jsonc
{
  "metadata": { "octo_layout": "agent_progress_v1" },
  "body": [
    { "type": "ColumnSet" },
    {
      "type": "Container",
      "id": "timeline_detail",
      "isVisible": false,
      "items": []
    }
  ]
}
```

Rules:

- Renderers match known `metadata.octo_layout` values and treat unknown values as ordinary Adaptive Cards.
- Top-level `body` must be `[ColumnSet, Container#timeline_detail]`.
- Running cards keep `timeline_detail.isVisible: true`.
- Terminal cards (`done` / `error`) default collapsed when toggle is available: `timeline_detail:false`, `btn_collapse:false`, `btn_expand:true`.
- Do not set `style` on `timeline_detail`. Put `style: "warning"` / `"attention"` only on child step containers.
- Toggle buttons live inside the right-side `ColumnSet` column, not root `actions`.
- Adaptive Cards does not auto-switch a single button label; emit two `ActionSet`s and toggle all three targets: `timeline_detail`, `btn_collapse`, `btn_expand`.
- Continuous timeline lines/dots can only be approximated in pure Adaptive Cards; precise line/dot/tool-row styling belongs in the client renderer.

## Low-Level Payload

```jsonc
POST /v1/bot/sendMessage
{
  "channel_id": "<groupId or uid>",
  "channel_type": 2,
  "payload": {
    "type": 17,
    "profile": "octo/v1",
    "card_version": "1.5",
    "card": {
      "type": "AdaptiveCard",
      "version": "1.5",
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": []
    },
    "plain": "truthful fallback text"
  }
}
```

For edits:

```bash
POST /v1/bot/message/edit
{ "message_id":"<original>", "channel_id":"…",
  "content_edit": "<JSON.stringify({ type:17, card:…, profile, card_version, transient:true })>" }
```

`transient` lives inside the stringified `content_edit` envelope, not as a top-level edit-body field. Use `transient: true` for intermediate progress frames; omit it for the terminal frame.

## Security

- Cards are visible to every member of the group. Never render tokens, API keys, webhook URLs, or `Authorization` values into any card field, even hidden collapsibles.
- Hidden collapsible content and copy text are still stored in card JSON. Treat them as public group-visible data.
- `plain` is what non-card clients and history search see. Keep it truthful and do not include anything absent from the card.
- `buildDisplayCard` degrades embedded URLs to `scheme://<registrable-domain>` and drops blocks matching known secret shapes; hand-written clients must implement equivalent guardrails.
