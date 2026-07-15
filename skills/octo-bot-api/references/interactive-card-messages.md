# Interactive Card Messages Reference

Use this reference when sending or editing `payload.type=17` InteractiveCard messages, using `octo_send_display_card` or `octo_send_card`, designing normal information cards, or working on agent progress cards. Content type 17 is unrelated to the legacy contact/name card at `MessageType.Card = 7`.

## Scope And Supported Profiles

- `octo/v1` provides display cards and agent progress cards, including `octo_send_display_card`, send/edit primitives, negotiated rendering, and text fallback.
- `octo/v2` submit-interactive cards are produced by `octo_send_card`. The plugin polls `card_action`, binds it to the originating card/account/channel, and dispatches it as a new turn in the same conversation.
- `octo/v1` availability does not imply `octo/v2`; the interactive tool requires the v2 profile plus `Action.Submit` and every requested `Input.*` capability.

### Three Integration Paths

Read the rest of this file according to how you send cards — the manual steps below apply to only one of them:

- **Tool path (`octo_send_display_card`).** The tool probes the profile, fail-closed rejects on an unusable deployment, degrades unsupported elements to plain text, and redacts secrets for you. You do **not** need to `curl` the profile endpoint, check capability lists, or enforce `limits.*` yourself — pass `{ title?, blocks[] }` and read the outcome. The DisplayBlock schema below is exactly this tool's `blocks` input.
- **Interactive tool path (`octo_send_card`).** Pass `{ title, text?, buttons, inputs? }`. The tool always targets the trusted current conversation, emits top-level `Action.Submit` actions for client compatibility, starts callback polling only after a successful send, and degrades the choices to text when v2 is unavailable.
- **Raw API path (hand-written HTTP client).** You own everything the tool would otherwise do: feature-detect, respect `limits.*` recursively, degrade unsupported elements, and implement the security guardrails at the end of this file. The manual "always feature-detect" / "respect limits" instructions target this path.

## When To Use Cards

- Plain text (`payload.type=1`): conversational replies, short answers, follow-ups.
- Display card (`payload.type=17`, `profile="octo/v1"`): structured, non-callback output such as status reports, key-value summaries, tables, collapsible detail sections, and local copy buttons. It has no bot callback.
- Submit-interactive card (`profile="octo/v2"`): user clicks a button and the bot receives a `card_action` event. Use only when click-back is required.

Do not overuse card messages. Plain text is the default. Use cards only when structure materially improves comprehension, such as weather, status, lists, comparisons, or detail fields. Keep ordinary chat, short answers, and follow-up replies as plain text. Do not use a blanket "use cards whenever possible" rule.

On the **raw API path**, always feature-detect before sending cards (both bundled card tools already do this for you — skip it there):

```bash
curl <apiUrl>/v1/bot/card/profile -H "Authorization: Bearer $TOKEN"
```

Important profile fields:

```jsonc
{
  "available": true,
  "enabled": true,
  "card_version": "1.5",
  "profiles": ["octo/v1", "octo/v2"],
  "elements": ["TextBlock","RichTextBlock","Container","ColumnSet","FactSet","Image","ImageSet","Table","ActionSet"],
  "inputs": ["Input.Text","Input.Toggle","Input.ChoiceSet","Input.Number","Input.Date","Input.Time"],
  "actions": ["Action.OpenUrl","Action.ToggleVisibility","Action.CopyToClipboard","Action.Submit"],
  "limits": { "max_payload_bytes": 524288, "max_nodes": 200, "max_depth": 16,
              "max_input_text_bytes": 4096, "max_inputs_bytes": 16384 }
}
```

- `available:true` with `enabled:false` is an explicit server-side disable. Do not send cards.
- For v1, `available:false` uses the legacy `OCTO_CARD_MESSAGE_ENABLED=1` compatibility switch. For v2, an unavailable manifest can never prove callback support, so `octo_send_card` always degrades to text.
- `card_version` is matched **exactly**: the client is pinned to `1.5` (Decision 10), so a server advertising any other version — including a higher one such as `1.6` — is rejected fail-closed rather than assumed backward-compatible. Fall back to text on any mismatch.
- `elements` / `inputs` / `actions` are authoritative when present, including an explicitly empty array. Missing support can produce server 400.
- `elements` lists renderable card elements such as `ColumnSet` and `Table`; it does not need to list child schemas such as `Column`, `TableRow`, or `TableCell`.
- Old deployments may omit capability lists; fall back to `TextBlock` / `Container` / `ColumnSet` / `FactSet` / `Image`, and no actions.
- Respect `limits.max_nodes`, `limits.max_depth`, and `limits.max_payload_bytes` recursively. A top-level `body.length` check is not sufficient for nested containers, tables, rich-text inlines, or long UTF-8 text.
- Interactive producers must also enforce `max_input_text_bytes` and `max_inputs_bytes`; submitted values are untrusted user input even though `Action.Submit.data` was authored by the bot.

## Submit-Interactive Cards

Use `octo_send_card` for explicit confirmation, approval/rejection, a small menu, or a short form. Do not use it for ordinary follow-up questions where a text reply is sufficient.

```jsonc
{
  "title": "发布确认",
  "text": "是否发布到生产环境？",
  "buttons": [
    { "id": "approve", "label": "批准", "style": "positive", "data": { "workflow": "release" } },
    { "id": "reject", "label": "拒绝" }
  ],
  "inputs": [
    { "id": "reason", "kind": "text", "label": "备注" }
  ]
}
```

Rules:

- Button/input ids are stable machine identifiers, not user-facing prose.
- Current clients render submit buttons from top-level `card.actions`; do not place the only submit controls inside a body `ActionSet`.
- A click is delivered with the verified `operator_uid`, `action_id`, `inputs`, and bot-authored `data`. Form inputs remain untrusted: the adapter accepts only ids declared by the originating card and rejects sensitive or oversized values before dispatch.
- The first valid submit claims the card. The original card is edited through processing to completed/error and later clicks are ignored.
- Server membership/visibility checks prove that the operator can see and act on the card. They do not prove that the operator has business authority to approve a deployment, payment, or other privileged action.
- `cardInteraction:false` hides the tool and prevents new interaction polling for that account. It cannot force-enable a server that does not advertise v2.

## Canonical Structure

Think IM summary card + expandable details, not logs converted into a card.

For final answers, prefer one display card message. If the answer needs a process affordance, put process as the first block inside that same card; do not send or leave a separate final process-only card. A card is a side effect, not the conversational reply — after sending it you must still close the turn with a short text message stating the result (see "Always Close the Turn with Text" in SKILL.md).

Visible first screen should normally be 3-6 lines. If process information is included, show only a compact process summary plus answer content; detailed process opens under `查看过程`.

Process detail shape:

1. Status line: completed / running / failed + step count + elapsed time.
2. Summary line: reasoning stages, tool calls, failures.
3. Reasoning sections: 2-3 human-readable stage summaries; fold overflow stages and raw details.

Do not send raw `tool_events` as the card structure. Convert them into `reasoning_sections`: each section has one natural-language reasoning sentence and optional tool evidence. Keep parameters subtle and shortened. Put full calls, long paths, stack traces, and verbose logs behind `collapsible` / `Action.ToggleVisibility`.

`plain` is first-class output. Generate it from the same source as the card, keep exactly one title, and do not dump raw logs into it.

## Preferred DisplayBlock Shape

This `{ title?, blocks[] }` object is the `octo_send_display_card` tool input, and `blocks` uses the [DisplayBlock schema](#displayblock-reference) below. The tool runs it through `buildDisplayCard`, which compiles the high-level `blocks` into the low-level AdaptiveCard `card.body` shown under [Low-Level Payload](#low-level-payload) and derives the truthful `plain` fallback. Author `blocks` (not raw `card.body`) unless you are on the raw API path and building AdaptiveCards by hand.

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
| `heading` (text, size?) | Bolder TextBlock | Section title | Requires `TextBlock`; otherwise no safe card fallback |
| `text` (text) | TextBlock | Body paragraph | Requires `TextBlock`; otherwise no safe card fallback |
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

When `ColumnSet` and `Container` are advertised, agent response progress cards use the enhanced renderer contract:

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
- A card marked `metadata.octo_layout="agent_progress_v1"` must have top-level `body = [ColumnSet, Container#timeline_detail]`.
- Producers must not emit that marked layout when `ColumnSet` or `Container` is unsupported. Degrade to an ordinary flat `TextBlock` card without `agent_progress_v1` metadata; if `TextBlock` is also unsupported or the minimum card exceeds a negotiated hard limit, skip the progress card and keep the normal text reply.
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
  "channel_id": "<groupId, uid, or thread channel_id>",
  "channel_type": 2,               // must match the target: 1=DM, 2=group, 5=thread — take both from the received event
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

For a raw submit card, switch the envelope to `profile:"octo/v2"` and put `Action.Submit` objects in top-level `card.actions`. Callbacks are read with `POST /v1/bot/events` body `{ "event_id": <cursor>, "limit": 1..100 }`; the outer `event_id` is the delivery idempotency key. `POST /v1/bot/events/:event_id/ack` prunes a handled event. The bundled `octo_send_card` path performs this polling, cursor persistence, deduplication, and session dispatch for you.

## Security

- Cards are visible to every member of the group. Never render tokens, API keys, webhook URLs, or `Authorization` values into any card field, even hidden collapsibles.
- Hidden collapsible content and copy text are still stored in card JSON. Treat them as public group-visible data.
- `plain` is what non-card clients and history search see. Keep it truthful and do not include anything absent from the card.
- `buildDisplayCard` degrades embedded URLs to `scheme://<registrable-domain>` and drops blocks matching known secret shapes; hand-written clients must implement equivalent guardrails.
- Agent tools that reply to the current conversation must derive the target from trusted runtime delivery context. A model-supplied `channelId`, group id, uid, or thread id is routing input, not authorization, and must not enable cross-conversation sends.
- Display cards always send under the bot's own identity. Sender identity / OBO (persona-clone) is never taken from model input; a hand-written client must likewise not let untrusted model output pick the sending persona, or a group-visible card becomes a persona-impersonation sink.
- `operator_uid` on a `card_action` has passed server membership, visibility, anti-IDOR, and bot-sender checks. Treat it as authenticated channel identity, not as a generic business approval grant.
