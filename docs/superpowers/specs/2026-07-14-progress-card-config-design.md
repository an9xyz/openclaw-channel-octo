# 新增卡片开关配置项(进度卡 / 展示卡)

## 背景

当前进度卡(`src/card-progress.ts`)与展示卡工具(`src/card-display-tool.ts`)的「发不发」**只由服务端 manifest 决定**,插件侧没有任何账号级开关:

- 门控唯一来源是 `GET /v1/bot/card/profile` 的 manifest:`available / enabled / profiles / card_version / elements`(`card-progress.ts` 的 `gateEnabled`,约 `:135`;`card-display-tool.ts` 的 `gateReason`,约 `:106`,两处共用 `deriveCardCaps`)。
- 唯一旁路旋钮是**进程级** env `OCTO_CARD_MESSAGE_ENABLED`,且**仅在 manifest 端点缺失(`available:false`)时**才被读取(`card-progress.ts:142`、`card-display-tool.ts:108`)。一旦服务端部署了端点并 `enabled:true`,进程内所有 bot 强制开卡,插件侧关不掉。

由此产生三个缺口:

1. **无 per-account / per-bot 开关。** 多 bot 单进程(v0.2.30+ 独立连接隔离)下,翻译 bot 想纯文本、正式 bot 想发卡,做不到——env 是进程级,一刀切。
2. **进度卡与展示卡共用一个门。** 进度卡是自动、`transient`、高频 edit 的中间帧,噪音 / token / edit 频率成本明显高于最终展示卡;想「保留最终卡、关掉过程帧」当前无法拆分。
3. **缺干净的 kill-switch。** 服务端端点已部署时,想临时关进度卡只能改服务端 `manifest.enabled=false`(波及所有 bot),env 那条此时又不生效。

## 目标

给插件加**账号级**卡片开关,让运维 / bot 作者能在不动服务端的前提下,按 bot 关闭进度卡或展示卡。开关只作**收窄**(强制关),能力上限仍由服务端 manifest 决定。

## 非目标

- **不**让配置强开卡片。开关不能绕过 manifest 的 `profiles / card_version / TextBlock` 兼容校验——绕过会稳定撞 server 400。这是 fail-closed 底线。
- **不**在插件侧复制服务端能力判断。manifest 仍是能力权威,配置只在其之上做减法。
- **不**改 env `OCTO_CARD_MESSAGE_ENABLED` 的现有语义(`available:false` 回退开关),保持向后兼容。

## 设计

新增两个**三态布尔**账号级配置项(顶层默认 + `accounts.<id>` 覆盖,与现有 `requireMention` 同款分层):

| 配置项 | 作用面 | 语义 |
|---|---|---|
| `cardProgress` | 自动进度卡(hook 链路) | `false` = 强制关;`true` / 省略 = 跟随服务端 manifest |
| `cardDisplay` | `octo_send_display_card` 工具 | `false` = 工具不 offer / 直接拒;`true` / 省略 = 跟随服务端 manifest |

**三态语义(关键):** 只有显式 `false` 才关;`true` 与省略都等价于「跟随服务端」,不改变现状。命名为 kill-switch 而非 enable-switch —— 默认行为与今天完全一致,升级无感。

**最终门 = `existingCardGate && configAllows`(与运算,只收窄):** `existingCardGate` 指现有完整门控,包括 manifest 能力判断,以及 `available:false` 时保留的 env 兼容回退。

```
finalEnabled = existingCardGate(...) && (config.cardProgress !== false)
```

config `true` 永远不能把 `existingCardGate === false` 翻成 `true`。

### 改动点

1. **`openclaw.plugin.json` + `src/config-schema.ts`** —— manifest schema、运行时 TypeScript 配置类型与 `OctoConfigJsonSchema` 同步加 `cardProgress` / `cardDisplay`(`boolean`,可选,无 default = 三态),顶层与 `accounts.*` 两处都加,附 description 说明「省略/true=跟随服务端,false=强制关」。两套 schema 必须保持 key 与 description 一致,继续通过 `manifest-schema-sync.test.ts`。

2. **`src/accounts.ts`** —— `ResolvedOctoAccount.config` 加两个可选字段,在 `resolveOctoAccount` 用 `accountConfig.cardProgress ?? channel.cardProgress` / `cardDisplay` 做顶层默认 + 账号覆盖。显式 `true` 必须能覆盖顶层 `false`,显式 `false` 也必须能覆盖顶层 `true`。

3. **`src/inbound.ts:2538`(`setCardContext`)** —— 该处已持有解析完成的 `account.config`,把 `cardProgress` 原值塞进 `CardContext`。

4. **`src/card-progress.ts`**
   - `CardContext` 加可选字段 `cardProgress?: boolean`,保留三态原值,避免正反语义转换。
   - `setCardContext` 创建本 session entry 时,`cardProgress === false` 直接置 `skip`;连 manifest 探测都省。
   - 配置禁用只属于 per-account / per-session 决策,**绝不能写入**当前按 `apiUrl` 共享的 `gateCache` / `capsCache`。否则账号 A 关闭会污染同部署账号 B。共享缓存仍只保存服务端能力事实。

5. **`src/card-display-tool.ts`(`createDisplayCardTool`)** —— 已接收 `cfg` / `agentAccountId`,同源解析 `cardDisplay`,同时做两层守卫:
   - discovery 阶段能可靠解析当前账号且其 `cardDisplay === false` 时,不注册工具,避免向模型 offer 不可用能力;多账号且当前账号不明确时允许保留工具。
   - `execute` 内以可信 `deliveryContext.accountId` / `agentAccountId` 解析账号后,在 manifest 探测前再次检查;显式关闭则立即 `err(...)` 提示改用纯文本。执行时检查是最终权威,用于覆盖 tool schema 缓存、热更新和直接调用场景。

6. **`README.md`** —— 在账号配置说明与示例中增加两个字段及三态语义,让运维侧可发现。

### 不改

- manifest 探测、`deriveCardCaps`、版本协商(精确匹配 `octo/v1` + `1.5`,Decision 10)全部保留,配置只在其结果上做 `&&`。
- 进度卡继续在当前 turn 的可信 `effectiveOnBehalfOf` 存在时无条件 skip,不受本开关影响。
- 展示卡维持当前身份边界:始终以 bot 自身身份发送,不接受/透传模型提供的 OBO 身份。它当前并非「所有 persona 账号一律 skip」;若未来要求 OBO turn 禁止展示卡,需另行把可信 turn 级 OBO 上下文接入工具。

## 备选(已否决)

- **单一 `cards` 布尔开关**:实现更省,但把进度卡与展示卡绑死,无法满足「关过程帧、留最终卡」这一主要诉求(缺口 2),否决。
- **嵌套 `cards: { progress, display }` 对象**:分组更清晰,但与现有扁平 camelCase 账号配置(`requireMention` 等)不一致;为一致性选扁平两字段。若后续卡片配置项增多,可再收敛为嵌套对象。

## 测试

`src/__tests__/accounts.test.ts` 新增配置继承用例:

- 顶层 `cardProgress/cardDisplay:false` + 账号省略 → 解析为 `false`。
- 顶层 `false` + 账号显式 `true` → 解析为 `true`。
- 顶层 `true` + 账号显式 `false` → 解析为 `false`。

`src/card-progress.test.ts` 新增门控用例:

- `cardProgress:false` → session 直接 skip,`getCardProfile` / send / edit 均不调用。
- `cardProgress` 省略 + 服务端 `enabled:true` → 返回 `true`(跟随服务端,现状不变)。
- `cardProgress: true` + 服务端不兼容(`card_version` 不匹配)→ 仍 `false`(配置不能强开,守住 400 底线)。
- 同一 `apiUrl` 下账号 A `false`、账号 B 省略 / `true` + 服务端兼容 → B 仍正常发卡(证明配置禁用未污染共享 gate cache)。

`src/card-display-tool.test.ts`:

- 已知当前账号 `cardDisplay:false` → discovery 不注册工具。
- discovery 无法确定账号但 execute 解析到 `cardDisplay:false` → 返回 `err`(提示改用纯文本),且不探测 manifest、不发送。
- 省略 → 现有行为不变(回归)。

`src/manifest-schema-sync.test.ts` 保持通过,并覆盖两个新字段在 manifest / 运行时 schema 的顶层与账号层 description 一致。
