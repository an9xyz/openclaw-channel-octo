import { describe, it, expect } from "vitest";
import {
  renderProgressCard,
  resolveToolMeta,
  summarizeToolParams,
  fmtDuration,
  stepLine,
  cardSupports,
} from "./card-render.js";

describe("resolveToolMeta", () => {
  it("已知工具 → 图标 + 中文标签", () => {
    expect(resolveToolMeta("read")).toEqual({ icon: "📖", label: "读取文件" });
    expect(resolveToolMeta("exec")).toEqual({ icon: "⌨️", label: "执行命令" });
    expect(resolveToolMeta("process")).toEqual({ icon: "⚙️", label: "运行进程" });
  });
  it("MCP 工具解析 server / tool", () => {
    expect(resolveToolMeta("mcp__github__create_issue")).toEqual({
      icon: "🔌",
      label: "MCP github / create_issue",
    });
  });
  it("未知工具 → 通用图标 + 原名", () => {
    expect(resolveToolMeta("weirdtool")).toEqual({ icon: "🔧", label: "weirdtool" });
  });
});

describe("summarizeToolParams", () => {
  it("文件类工具取 path", () => {
    expect(summarizeToolParams("read", { path: "/work/README.md" })).toBe("/work/README.md");
    expect(summarizeToolParams("edit", { file_path: "/a/b.ts", offset: 0 })).toBe("/a/b.ts");
  });
  it("shell 类只取程序名,不渲染完整命令(避免参数泄露)", () => {
    expect(summarizeToolParams("exec", { command: "git commit -m x" })).toBe("git");
    expect(summarizeToolParams("bash", { command: "curl -H 'Authorization: Bearer sk-xxx' https://x" })).toBe("curl");
  });
  it("shell 跳过前缀式环境变量赋值(VAR=secret cmd),不泄露密钥值", () => {
    expect(summarizeToolParams("exec", { command: "SLACK_WEBHOOK=https://hooks.slack.com/services/T/B/X curl -X POST" })).toBe("curl");
    expect(summarizeToolParams("bash", { command: "MY_CREDS=abc123 DEPLOY_KEY=xyz ./deploy.sh" })).toBe("./deploy.sh");
  });
  it("shell 带引号多词环境变量值 → 落在值片段则整体不展示(形状校验)", () => {
    // 空白分词把 TOKEN="a b" 切成 TOKEN="a / b" —— 落在片段 b",含引号 → 不展示。
    expect(summarizeToolParams("exec", { command: 'TOKEN="a b" node app.js' })).toBe("");
    // 合法程序名/路径不受影响。
    expect(summarizeToolParams("exec", { command: "/usr/bin/python3 x.py" })).toBe("/usr/bin/python3");
  });
  it("query/shell 策略也降级内嵌 URL(与 url/error 路径对称,单一 choke point)", () => {
    // query 里的 webhook URL:路径段短、无关键词 → isSensitive 抓不到,靠 URL 降级。
    expect(summarizeToolParams("web_search", { query: "https://hooks.slack.com/services/T00/B00/abcdEFGH1234abcdEFGH1234" })).toBe(
      "https://slack.com",
    );
    // query 里的 userinfo / PII query / 内网主机 —— 非密钥形状,但仍不该原样泄露。
    expect(summarizeToolParams("grep", { pattern: "https://user:pw@example.com/x" })).toBe("https://example.com");
    expect(summarizeToolParams("grep", { pattern: "https://example.com/reset?email=ceo@corp.com" })).toBe("https://example.com");
    // shell:URL 作为程序名(argv[0])→ 降级为注册域,不原样渲染。
    expect(summarizeToolParams("exec", { command: "https://hooks.slack.com/services/T1/B2/tok arg" })).toBe("https://slack.com");
    // 常规 query 不受影响。
    expect(summarizeToolParams("grep", { pattern: "TODO fix later" })).toBe("TODO fix later");
  });
  it("非 http scheme 的凭据 URI 也降级(postgres/mysql/redis/ssh…),明文密码不泄露", () => {
    // query 里的 DB DSN:密码短、无关键词 → isSensitive 抓不到,靠 URL 降级丢掉 userinfo。
    expect(summarizeToolParams("web_search", { query: "postgres://admin:s3cr3t@db.internal:5432/app" })).toBe("postgres://db.internal");
    // shell:DSN 作为程序名(argv[0])。
    expect(summarizeToolParams("bash", { command: "mysql://root:hunter2@10.0.0.5:3306/prod" })).toBe("mysql://10.0.0.5");
    // 其它 scheme。
    expect(summarizeToolParams("grep", { pattern: "redis://:pw@cache.internal:6379/0" })).toBe("redis://cache.internal");
    expect(summarizeToolParams("grep", { pattern: "ssh://deploy:key@bastion.example.com" })).toBe("ssh://example.com");
    // 不误伤 Windows 盘符路径(无 ://)。
    expect(summarizeToolParams("read", { path: "C:/Users/me/app.ts" })).toBe("C:/Users/me/app.ts");
  });
  it("url 类只保留 scheme://注册域,丢弃 path/query/userinfo 与所有子域", () => {
    expect(summarizeToolParams("fetch", { url: "https://u:p@host.com/a/b?token=sk-secret&x=1" })).toBe(
      "https://host.com",
    );
    // Slack webhook 密钥整段在 path 里 —— 连 path 与子域一起丢。
    expect(summarizeToolParams("fetch", { url: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX" })).toBe(
      "https://slack.com",
    );
    // 隧道/预签名:主机名本身即密钥(随机子域)→ 只留注册域,子域丢弃。
    expect(summarizeToolParams("fetch", { url: "https://s3cr3ttok.abc1234.ngrok.io/hook" })).toBe(
      "https://ngrok.io",
    );
    // 多段有效后缀多保留一段。
    expect(summarizeToolParams("fetch", { url: "https://x.example.com.cn/p" })).toBe("https://example.com.cn");
    expect(summarizeToolParams("fetch", { url: "not a url" })).toBe("");
  });
  it("检索类取 query/pattern", () => {
    expect(summarizeToolParams("grep", { pattern: "TODO", path: "/x" })).toBe("TODO");
    expect(summarizeToolParams("web_search", { query: "how to" })).toBe("how to");
  });
  it("形状脱敏:query/pattern 里的裸密钥(无关键词)也隐藏", () => {
    expect(summarizeToolParams("grep", { pattern: "AKIAIOSFODNN7EXAMPLE" })).toBe(""); // AWS key id
    expect(summarizeToolParams("web_search", { query: "d41d8cd98f00b204e9800998ecf8427e" })).toBe(""); // 32 hex
    expect(summarizeToolParams("grep", { pattern: "ghp_16C7e42F292c6912E7710c838347Ae178B4a" })).toBe(""); // GitHub token — gitleaks:allow (fake fixture)
    expect(summarizeToolParams("web_search", { query: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456" })).toBe(""); // JWT — gitleaks:allow (fake fixture)
    // 混合字母数字的 40+ 位随机串。
    expect(summarizeToolParams("grep", { pattern: "aB3dE7gH1jK4mN8pQ2rS5tU9vW6xY0zA1bC2dE3f" })).toBe("");
    // 正常长英文 / 纯字母长串不误伤。
    expect(summarizeToolParams("web_search", { query: "how to configure oauth flow correctly" })).toBe("how to configure oauth flow correctly");
  });
  it("path 只走关键词+明确前缀:常见 git/docker/缓存哈希路径不被误伤成空", () => {
    // 通用高熵/长 hex 检测**不**套用到 path —— 否则日常路径会频繁 blank。
    expect(summarizeToolParams("read", { path: "/repo/.git/objects/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c" })).toBe(
      "/repo/.git/objects/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    );
    expect(summarizeToolParams("edit", { file_path: ".cache/webpack/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" })).toBe(
      ".cache/webpack/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    );
    // 但明确前缀式密钥(AKIA/sk-/gh_)即使出现在路径里仍隐藏。
    expect(summarizeToolParams("read", { path: "/tmp/AKIAIOSFODNN7EXAMPLE.pem" })).toBe("");
  });
  it("MCP / 未知工具 → 不显示摘要(不渲染任意参数)", () => {
    expect(summarizeToolParams("mcp__github__create_issue", { title: "leak", body: "secret" })).toBe("");
    expect(summarizeToolParams("weirdtool", { foo: "bar" })).toBe("");
  });
  it("命中敏感串守卫 → 整串隐藏", () => {
    expect(summarizeToolParams("read", { path: "/etc/my-api-key.txt" })).toBe("");
    expect(summarizeToolParams("grep", { pattern: "password=hunter2" })).toBe("");
  });
  it("非法输入 → 空串", () => {
    expect(summarizeToolParams("read", undefined)).toBe("");
    expect(summarizeToolParams(undefined, { path: "/a" })).toBe("");
    expect(summarizeToolParams("read", "x")).toBe("");
  });
  it("超长截断 + 折叠空白", () => {
    const long = "/a/" + "x".repeat(80);
    const out = summarizeToolParams("read", { path: long });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(65);
    expect(summarizeToolParams("read", { path: "/a\n  b\tc" })).toBe("/a b c");
  });
});

describe("fmtDuration", () => {
  it("<1s 用 ms", () => expect(fmtDuration(200)).toBe("200ms"));
  it(">=1s 用 x.xs", () => expect(fmtDuration(10165)).toBe("10.2s"));
  it("undefined → 空", () => expect(fmtDuration(undefined)).toBe(""));
});

describe("stepLine", () => {
  it("running:⏳ + 标签 + 摘要", () =>
    expect(stepLine({ tool: "exec", status: "running", summary: "ls -la" })).toBe("⏳ 执行命令：ls -la"));
  it("done:图标 + 标签 + 摘要 + 耗时", () =>
    expect(stepLine({ tool: "exec", status: "done", summary: "ls -la", durationMs: 10165 })).toBe(
      "⌨️ 执行命令：ls -la · 10.2s",
    ));
  it("done 无摘要", () =>
    expect(stepLine({ tool: "read", status: "done", durationMs: 200 })).toBe("📖 读取文件 · 200ms"));
  it("error", () =>
    expect(stepLine({ tool: "bash", status: "error", summary: "rm x", error: "boom" })).toBe(
      "❌ 执行命令：rm x — boom",
    ));
  it("error 详情脱敏:命中敏感串则只留状态、不渲染原始错误", () => {
    // 含 token 关键词
    expect(stepLine({ tool: "bash", status: "error", error: "auth failed: Bearer sk-live-abc" })).toBe("❌ 执行命令");
    // 裸 sk- 前缀长 token(不在 URL 里)→ 整行隐藏
    expect(stepLine({ tool: "bash", status: "error", error: "token sk-live-ABC123XYZ456def789ghi rejected" })).toBe("❌ 执行命令");
    // AKIA 出现在错误里
    expect(stepLine({ tool: "exec", status: "error", error: "invalid key AKIAIOSFODNN7EXAMPLE" })).toBe("❌ 执行命令");
  });
  it("error 详情超长截断,折叠空白", () => {
    const long = "line1\n" + "z".repeat(200); // 非 hex、无数字 → 不算密钥,仅超长
    const out = stepLine({ tool: "read", status: "error", error: long });
    expect(out.startsWith("❌ 读取文件 — line1 ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(140); // 图标+标签 + 120 上限 + 省略号
  });
  it("error 含 git SHA / digest / UUID 不被整段吞掉(不套用长 hex/高熵)", () => {
    // webhook 由 URL 降级兜住,故错误文本不套用长 hex/高熵形状 → 普通运维错误不被 blank。
    expect(stepLine({ tool: "read", status: "error", error: "build failed at commit 5f2a1c9d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b" })).toBe(
      "❌ 读取文件 — build failed at commit 5f2a1c9d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b",
    );
    // 但明确关键词/前缀仍拦。
    expect(stepLine({ tool: "read", status: "error", error: "AKIAIOSFODNN7EXAMPLE rejected" })).toBe("❌ 读取文件");
  });
  it("P2-1: 工具名 label 过长截断 / 敏感形状回退通用标签", () => {
    // 超长 MCP 工具名 → 截断,防卡片被 label 撑爆。
    const longName = "mcp__" + "z".repeat(60) + "__tool"; // 非 hex、无数字 → 只超长,不算密钥形状
    const out = stepLine({ tool: longName, status: "running" });
    expect(out.length).toBeLessThan(60);
    expect(out.endsWith("…")).toBe(true);
    // 未知工具名命中敏感关键词 → 回退通用「工具」(不把疑似密钥的标识符渲进群卡片)。
    expect(stepLine({ tool: "fetch_api_key_helper", status: "running" })).toBe("⏳ 工具");
  });
  it("error 内嵌 URL 降级为注册域(对称参数路径),webhook 路径/隧道主机不泄露", () => {
    // 短、无关键词的 webhook 路径段:isSensitive 抓不到,靠 URL 降级丢掉。
    const slack = stepLine({ tool: "bash", status: "error", error: "curl: (22) https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/Xy8zQw3rT7uVwXyZ0 returned 404" });
    expect(slack).toContain("https://slack.com");
    expect(slack).not.toContain("services");
    expect(slack).not.toContain("Xy8zQw3rT7uVwXyZ0");
    // Discord webhook。
    const discord = stepLine({ tool: "bash", status: "error", error: "POST https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwX failed" });
    expect(discord).toContain("https://discord.com");
    expect(discord).not.toContain("webhooks");
    // 内网主机 + 短 opaque token(16 hex,<32 → 形状抓不到),靠降级丢子域+path。
    const internal = stepLine({ tool: "exec", status: "error", error: "failed to POST https://mytenant.internal.corp:8443/webhook/9f8e7d6c5b4a3210 — 500" });
    expect(internal).toContain("https://internal.corp");
    expect(internal).not.toContain("mytenant");
    expect(internal).not.toContain("9f8e7d6c5b4a3210");
    // 预签名 URL 的签名在 query,降级后连同子域一起丢。
    const s3 = stepLine({ tool: "bash", status: "error", error: "fetch https://mybucket.s3.amazonaws.com/f?X-Amz-Signature=deadbeefcafe returned 403" });
    expect(s3).toContain("https://amazonaws.com");
    expect(s3).not.toContain("mybucket");
    expect(s3).not.toContain("Signature");
    // 最可达:DB 驱动连接错误回显完整 DSN(非 http scheme)→ 明文密码不泄露。
    const dsn = stepLine({ tool: "exec", status: "error", error: "connect ECONNREFUSED postgres://svc:Hunter2Pw@10.0.0.5:5432/prod" });
    expect(dsn).toContain("postgres://10.0.0.5");
    expect(dsn).not.toContain("Hunter2Pw");
    expect(dsn).not.toContain("svc:");
  });
});

describe("renderProgressCard", () => {
  it("thinking 骨架", () => {
    const { card, plain } = renderProgressCard({ phase: "thinking", steps: [] });
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.5");
    expect((card.body as Array<{ text: string }>)[0].text).toBe("🤖 思考中…");
    expect(plain).toBe("🤖 思考中…");
  });

  it("tool 阶段带摘要步骤", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "read", status: "done", summary: "/work/README.md", durationMs: 200 }],
    });
    const body = card.body as Array<{ text: string }>;
    expect(body[0].text).toBe("🤖 正在处理…");
    expect(body[1].text).toBe("📖 读取文件：/work/README.md · 200ms");
  });

  it("done 收尾:步数 + 耗时", () => {
    const { card } = renderProgressCard({
      phase: "done",
      steps: [{ tool: "read", status: "done" }],
      elapsedMs: 2500,
    });
    expect((card.body as Array<{ text: string }>)[0].text).toBe("✅ 已完成 · 1 步 · 2.5s");
  });

  it("error 收尾", () => {
    const { card } = renderProgressCard({ phase: "error", steps: [], errorText: "超时" });
    expect((card.body as Array<{ text: string }>)[0].text).toContain("⚠️ 已中断");
  });

  it("plain never empty", () => {
    expect(renderProgressCard({ phase: "tool", steps: [] }).plain.length).toBeGreaterThan(0);
  });

  it("步骤超上限 → 只渲染最近 N 步 + 折叠计数(防卡片膨胀)", () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({
      tool: "read",
      status: "done" as const,
      summary: `/f${i}`,
      durationMs: 10,
    }));
    const { card } = renderProgressCard({ phase: "tool", steps });
    const body = card.body as Array<{ text: string }>;
    // header(1) + 折叠行(1) + 最近 12 步 = 14 个 block
    expect(body.length).toBe(14);
    expect(body[1].text).toBe("… 省略前 8 步");
    // 最后一步是最新的 /f19
    expect(body[body.length - 1].text).toContain("/f19");
    // 已折叠掉最早的 /f0
    expect(body.every((b) => !b.text.includes("/f0："))).toBe(true);
  });

  it("done 收尾 header 计数用全量步数(不受裁剪影响)", () => {
    const steps = Array.from({ length: 20 }, () => ({ tool: "read", status: "done" as const }));
    const { card } = renderProgressCard({ phase: "done", steps, elapsedMs: 1000 });
    expect((card.body as Array<{ text: string }>)[0].text).toBe("✅ 已完成 · 20 步 · 1.0s");
  });
});

describe("cardSupports / CardCaps 渲染协商(波 C)", () => {
  it("cardSupports:明确 advertise 以其为准,否则用基线", () => {
    expect(cardSupports({ elements: new Set(["TextBlock"]) }, "TextBlock")).toBe(true);
    expect(cardSupports({ elements: new Set(["TextBlock"]) }, "ColumnSet")).toBe(false);
    expect(cardSupports(undefined, "ColumnSet")).toBe(true); // 基线含
    expect(cardSupports(undefined, "Input.Text")).toBe(false); // 基线不含输入
  });

  it("无 caps → 默认 TextBlock 平铺(零回归)", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "read", status: "done", summary: "/a", durationMs: 200 }],
    });
    expect((card.body as Array<{ type: string }>)[1].type).toBe("TextBlock");
  });

  it("advertise ColumnSet(Column 是其固有子元素,不单独 advertise)→ 步骤渲成 ColumnSet 行,plain 不变", () => {
    const caps = { elements: new Set(["TextBlock", "ColumnSet"]) }; // 实测服务端不单列 Column
    const { card, plain } = renderProgressCard(
      { phase: "tool", steps: [{ tool: "exec", status: "done", summary: "ls", durationMs: 200 }] },
      caps,
    );
    const row = (card.body as Array<Record<string, unknown>>)[1];
    expect(row.type).toBe("ColumnSet");
    const cols = row.columns as Array<{ items: Array<{ text: string }> }>;
    expect(cols[0].items[0].text).toBe("⌨️");
    expect(cols[1].items[0].text).toBe("执行命令：ls · 200ms");
    expect(plain).toContain("⌨️ 执行命令：ls · 200ms"); // plain 与布局无关
  });

  it("advertise 了 elements 但不含 ColumnSet → 仍 TextBlock(降级)", () => {
    const caps = { elements: new Set(["TextBlock", "FactSet"]) };
    const { card } = renderProgressCard({ phase: "tool", steps: [{ tool: "read", status: "done" }] }, caps);
    expect((card.body as Array<{ type: string }>)[1].type).toBe("TextBlock");
  });

  it("caps.maxNodes 权威收紧可见步数(比本地上限更严)", () => {
    const steps = Array.from({ length: 20 }, () => ({ tool: "read", status: "done" as const }));
    const { card } = renderProgressCard({ phase: "tool", steps }, { maxNodes: 6 }); // TextBlock:reserve2 → 4 步
    expect((card.body as unknown[]).length).toBe(6); // header + 折叠 + 4 步
  });
});
