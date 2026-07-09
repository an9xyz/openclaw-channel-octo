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
  it("host 内建工具名 find(SDK ToolName)→ 查找文件,且走 path 摘要策略(不再裸名)", () => {
    expect(resolveToolMeta("find")).toEqual({ icon: "🔍", label: "查找文件" });
    expect(summarizeToolParams("find", { path: "/work/src/card-render.ts" })).toBe("/work/src/card-render.ts");
  });
});

describe("summarizeToolParams", () => {
  it("文件类工具取 path", () => {
    expect(summarizeToolParams("read", { path: "/work/README.md" })).toBe("/work/README.md");
    expect(summarizeToolParams("edit", { file_path: "/a/b.ts", offset: 0 })).toBe("/a/b.ts");
  });

  it("path 智能压缩:深路径保留末 2 段 + 前缀省略号,末段(文件名)必须完整", () => {
    // 典型痛点:/root/.openclaw/workspace/octo-server/modules/bot_api/send.go
    expect(summarizeToolParams("read", { path: "/root/.openclaw/workspace/octo-server/modules/bot_api/send.go" }))
      .toBe("…/bot_api/send.go");
    expect(summarizeToolParams("read", { path: "/Users/fangling/conductor/workspaces/kyoto/src/card-render.ts" }))
      .toBe("…/src/card-render.ts");
    // 3 段以内不压缩(信息本来就少)
    expect(summarizeToolParams("read", { path: "/work/README.md" })).toBe("/work/README.md");
    expect(summarizeToolParams("read", { path: "docs/card-protocol.md" })).toBe("docs/card-protocol.md");
    expect(summarizeToolParams("read", { path: "a/b/c" })).toBe("a/b/c");
    // 首段是家目录/根也一视同仁(不做特殊 `~` 标记,保持简单)
    expect(summarizeToolParams("ls", { path: "/root/.openclaw/workspace/octo-server/docs" }))
      .toBe("…/octo-server/docs");
    // 无扩展名的深目录同规则
    expect(summarizeToolParams("glob", { path: "a/b/c/d/e" })).toBe("…/d/e");
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
    expect(summarizeToolParams("read", { path: "C:/Users/me/app.ts" })).toBe("…/me/app.ts");
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
  it("前缀式密钥被前置词字符粘连也隐藏(去词界锚点;两类 sink 都覆盖)", () => {
    // 回归 yujiawei P1:`\b` 词界锚点会被"前面粘一个词字符"绕过 → 明文密钥泄露。
    // query 策略(generic=true):
    expect(summarizeToolParams("grep", { pattern: "xAKIA1234567890ABCDEF" })).toBe("");
    expect(summarizeToolParams("grep", { pattern: "9sk-ABCDEFGHIJKLMNOP1234" })).toBe("");     // 数字前缀
    expect(summarizeToolParams("web_search", { query: "a_glpat-ABCDEFGHIJ1234567890" })).toBe(""); // 下划线前缀 — gitleaks:allow (fake fixture)
    // path/shell 策略(generic=false,无高熵兜底)—— 更关键,靠前缀命中:
    expect(summarizeToolParams("read", { path: "tokenAKIAIOSFODNN7EXAMPLE" })).toBe("");
    expect(summarizeToolParams("read", { path: "keyghp_ABCDEFGHIJ1234567890XY" })).toBe("");
    expect(summarizeToolParams("exec", { command: "Xsk-ABCDEFGHIJKLMNOP1234" })).toBe("");
    // 但连字符英文不被长度下限误伤:
    expect(summarizeToolParams("grep", { pattern: "risk-averse task-force" })).toBe("risk-averse task-force");
  });
  it("path 只走关键词+明确前缀:常见 git/docker/缓存哈希路径不被误伤成空", () => {
    // 通用高熵/长 hex 检测**不**套用到 path —— 否则日常路径会频繁 blank。
    // git object 深路径 → 压缩到末 2 段;关键是 SHA(长 hex)在末段完整保留,且不被 secret 形状误伤。
    expect(summarizeToolParams("read", { path: "/repo/.git/objects/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c" })).toBe(
      "…/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
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
    // label 也过 URL 降级(与 params/error sink 一致):工具名里嵌 webhook/DSN → 只留注册域。
    const urlName = stepLine({ tool: "https://hooks.slack.com/services/T00/B00/SeCrEtXyZ", status: "running" });
    expect(urlName).toContain("https://slack.com");
    expect(urlName).not.toContain("/services/");
    expect(urlName).not.toContain("SeCrEtXyZ");
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

  it("同类合并:连续 3 个 read done → 1 行 「读取文件 × 3」,含总耗时和最近文件名", () => {
    const { card, plain } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "read", status: "done", summary: "/a/b.md", durationMs: 100 },
        { tool: "read", status: "done", summary: "/c/d.md", durationMs: 150 },
        { tool: "read", status: "done", summary: "/e/f.md", durationMs: 200 },
      ],
    });
    const body = card.body as Array<{ text: string }>;
    expect(body.length).toBe(2); // header + 1 合并行
    expect(body[1].text).toContain("读取文件 × 3");
    expect(body[1].text).toContain("450ms"); // 累加耗时
    expect(body[1].text).toContain("/e/f.md"); // 最近 = 最后一个
    expect(plain).toContain("读取文件 × 3");
  });

  it("同类合并:running/error 不合并 —— 当前重点不能糊掉", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "read", status: "done", summary: "/a.md", durationMs: 30 },
        { tool: "read", status: "done", summary: "/b.md", durationMs: 40 },
        { tool: "read", status: "error", summary: "/c.md", error: "EISDIR" }, // 中间 error
        { tool: "read", status: "done", summary: "/d.md", durationMs: 50 },
        { tool: "read", status: "running", summary: "/e.md" }, // 末尾 running
      ],
    });
    const body = card.body as Array<{ text: string }>;
    // 期望:合并组[a,b done] + error 单独 + done 单独 + running 单独 = 4 行 + header
    expect(body.length).toBe(5);
    expect(body[1].text).toContain("读取文件 × 2"); // 前两个合并
    expect(body[2].text).toContain("❌"); // error 保留
    expect(body[3].text).toContain("/d.md"); // 单个 done 不合并
    expect(body[4].text).toContain("⏳"); // running 保留
  });

  it("同类合并:跨 tool 边界不合并(read+exec+read 不能合成一组)", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "read", status: "done", summary: "/a", durationMs: 30 },
        { tool: "read", status: "done", summary: "/b", durationMs: 30 },
        { tool: "exec", status: "done", summary: "ls", durationMs: 100 },
        { tool: "read", status: "done", summary: "/c", durationMs: 30 },
        { tool: "read", status: "done", summary: "/d", durationMs: 30 },
      ],
    });
    const body = card.body as Array<{ text: string }>;
    // header + [read×2] + [exec 单个] + [read×2] = 4 行
    expect(body.length).toBe(4);
    expect(body[1].text).toContain("读取文件 × 2");
    expect(body[2].text).toContain("执行命令");
    expect(body[3].text).toContain("读取文件 × 2");
  });

  it("同类合并:done 收尾 header 计数仍用原始步数(合并不影响 N 步展示)", () => {
    const steps = [
      { tool: "read" as const, status: "done" as const, durationMs: 30 },
      { tool: "read" as const, status: "done" as const, durationMs: 30 },
      { tool: "read" as const, status: "done" as const, durationMs: 30 },
    ];
    const { card } = renderProgressCard({ phase: "done", steps, elapsedMs: 100 });
    const body = card.body as Array<{ text: string }>;
    expect(body[0].text).toBe("✅ 已完成 · 3 步 · 100ms"); // 用户看到"3 步",不是"1 组"
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

  it("R2: 含 git SHA 的步骤行不被 buildDisplayCard 二次误删(进度卡内容视为可信)", () => {
    const { card, plain } = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "read", status: "done", durationMs: 30, summary: "…/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e" }],
    });
    const b = card.body as Array<{ text?: string; inlines?: Array<{ text: string }> }>;
    // header + 步骤行 = 2(步骤行没有因 40-hex 高熵检测被删)
    expect(b.length).toBe(2);
    expect(plain).toContain("2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e");
  });

  it("R2: 错误终态帧含 commit SHA 时不整卡清空", () => {
    const { card, plain } = renderProgressCard({
      phase: "error",
      steps: [],
      errorText: "build failed at commit 5f2a1c9d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b",
    });
    const b = card.body as Array<{ text?: string }>;
    expect(b.length).toBeGreaterThan(0);
    expect(b[0].text).toContain("⚠️ 已中断");
    expect(plain).not.toBe("[卡片]");
    expect(plain).toContain("5f2a1c9d");
  });

  it("plain never empty", () => {
    expect(renderProgressCard({ phase: "tool", steps: [] }).plain.length).toBeGreaterThan(0);
  });

  it("步骤超上限 → 只渲染最近 N 步 + 折叠计数(防卡片膨胀)", () => {
    // 用交替 tool 避开同类合并 —— 这里要测的是「合并后仍超上限」的裁剪路径
    const steps = Array.from({ length: 20 }, (_, i) => ({
      tool: i % 2 === 0 ? "read" : "exec",
      status: "done" as const,
      summary: `/f${i}`,
      durationMs: 10,
    }));
    const { card } = renderProgressCard({ phase: "tool", steps });
    const body = card.body as Array<{ text: string }>;
    // 20 个 read/exec 交替 → 无合并;header(1) + 折叠行(1) + 最近 12 步 = 14 个 block
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

  it("advertise RichTextBlock → 步骤渲成 RichTextBlock(一行内多样式;label bold、状态/耗时着色),plain 一行完整不分行", () => {
    // 优于 ColumnSet 列的原因:服务端 Finalize 权威重算 plain 时,ColumnSet 会把图标列/文本列
    // 各当一行,输出成"⌨️\n执行命令:ls · 200ms"两行(降级客户端视觉退化)。RichTextBlock 是单元素,
    // 内联多段样式,plain 输出干净一行。
    const caps = { elements: new Set(["TextBlock", "RichTextBlock"]) };
    const { card, plain } = renderProgressCard(
      { phase: "tool", steps: [{ tool: "exec", status: "done", summary: "ls", durationMs: 200 }] },
      caps,
    );
    const row = (card.body as Array<Record<string, unknown>>)[1];
    expect(row.type).toBe("RichTextBlock");
    const inlines = row.inlines as Array<Record<string, unknown>>;
    // 至少有:图标段、label(bold)段、summary/duration 段
    expect(inlines.length).toBeGreaterThanOrEqual(2);
    const bolded = inlines.find((i) => i.weight === "Bolder");
    expect(bolded?.text).toBe("执行命令");
    expect(plain).toContain("⌨️ 执行命令：ls · 200ms"); // plain 一行完整
    expect(plain).not.toContain("⌨️\n执行命令"); // 关键:不分行
  });

  it("advertise 了 elements 但既无 RichTextBlock 也无 ColumnSet → TextBlock 平铺(降级)", () => {
    const caps = { elements: new Set(["TextBlock", "FactSet"]) };
    const { card } = renderProgressCard({ phase: "tool", steps: [{ tool: "read", status: "done" }] }, caps);
    expect((card.body as Array<{ type: string }>)[1].type).toBe("TextBlock");
  });

  it("caps.maxNodes 权威收紧可见步数(比本地上限更严)", () => {
    // 用不同 tool 避同类合并,保留"裁剪导致展示 cap 步"的原意图
    const steps = Array.from({ length: 20 }, (_, i) => ({
      tool: i % 2 === 0 ? "read" : "exec",
      status: "done" as const,
    }));
    const { card } = renderProgressCard({ phase: "tool", steps }, { maxNodes: 6 }); // reserve=2 → 4 步
    expect((card.body as unknown[]).length).toBe(6); // header + 折叠 + 4 步
  });

  it("P1-g: __thinking__ 特殊 tool 名 → icon 💭, label '思考'(done 时用 icon, running 时仍用 ⏳)", () => {
    // done 状态:显示 💭 思考
    const done = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "__thinking__", status: "done", durationMs: 200 }],
    });
    const body = done.card.body as Array<Record<string, unknown>>;
    const asText = (e: Record<string, unknown>) =>
      (e.text as string) ?? ((e.inlines as Array<{ text: string }>) ?? []).map((i) => i.text).join("");
    expect(asText(body[1])).toContain("💭 思考");
    expect(asText(body[1])).toContain("200ms");
    // running 状态:仍用 ⏳(running 图标),label 是"思考"
    const running = renderProgressCard({
      phase: "thinking",
      steps: [{ tool: "__thinking__", status: "running" }],
    });
    expect(asText((running.card.body as Array<Record<string, unknown>>)[1])).toContain("⏳ 思考");
  });

  it("P1-g: 连续 thinking done 触发同类合并 → 💭 思考 × N", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "__thinking__", status: "done", durationMs: 100 },
        { tool: "__thinking__", status: "done", durationMs: 200 },
        { tool: "__thinking__", status: "done", durationMs: 300 },
      ],
    });
    const body = card.body as Array<Record<string, unknown>>;
    // 无 caps → RichTextBlock 降级 TextBlock;读双兼容
    const t = (body[1].text as string) ?? ((body[1].inlines as Array<{ text: string }>) ?? []).map((i) => i.text).join("");
    expect(t).toContain("💭");
    expect(t).toContain("思考 × 3");
    expect(t).toContain("共 600ms");
  });

  it("cardSupports 支持 input/action 查询(与 element 同接口):advertise 以其为准", () => {
    // Input.* / Action.* 走同一函数,不再另开 API。基线不含输入/动作,不 advertise → 都为 false。
    expect(cardSupports(undefined, "Input.Text")).toBe(false);
    expect(cardSupports(undefined, "Action.ToggleVisibility")).toBe(false);
    expect(cardSupports({ inputs: new Set(["Input.Text", "Input.Number"]) }, "Input.Text")).toBe(true);
    expect(cardSupports({ inputs: new Set(["Input.Text"]) }, "Input.Number")).toBe(false);
    expect(cardSupports({ actions: new Set(["Action.ToggleVisibility"]) }, "Action.ToggleVisibility")).toBe(true);
    expect(cardSupports({ actions: new Set(["Action.Submit"]) }, "Action.ToggleVisibility")).toBe(false);
  });
});
