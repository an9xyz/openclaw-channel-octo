import { describe, it, expect } from "vitest";
import {
  renderProgressCard,
  resolveToolMeta,
  summarizeToolParams,
  fmtDuration,
  stepLine,
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
  it("url 类只保留 scheme://host,丢弃 path/query/userinfo(含 path 内嵌密钥)", () => {
    expect(summarizeToolParams("fetch", { url: "https://u:p@host.com/a/b?token=sk-secret&x=1" })).toBe(
      "https://host.com",
    );
    // Slack webhook 密钥整段在 path 里 —— 必须连 path 一起丢弃。
    expect(summarizeToolParams("fetch", { url: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX" })).toBe(
      "https://hooks.slack.com",
    );
    expect(summarizeToolParams("fetch", { url: "not a url" })).toBe("");
  });
  it("检索类取 query/pattern", () => {
    expect(summarizeToolParams("grep", { pattern: "TODO", path: "/x" })).toBe("TODO");
    expect(summarizeToolParams("web_search", { query: "how to" })).toBe("how to");
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
