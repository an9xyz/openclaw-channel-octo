import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";

// Mock child_process at module level
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(() => ""),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

async function loadModule() {
  vi.resetModules();
  return await import("./openclaw-cli.js");
}

describe("pluginsInspect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse JSON with preceding log noise", async () => {
    const { pluginsInspect } = await loadModule();
    mockExecFileSync.mockReturnValue(
      '[octo] registering before_prompt_build hook\n' +
        JSON.stringify({
          plugin: { id: "test", version: "1.0.0", enabled: true },
          install: { source: "npm", version: "1.0.0", installPath: "/tmp" },
        }),
    );

    const result = pluginsInspect("test");
    expect(result?.plugin?.version).toBe("1.0.0");
    expect(result?.plugin?.enabled).toBe(true);
  });

  it("should return null when plugin not found", async () => {
    const { pluginsInspect } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(pluginsInspect("nonexistent")).toBeNull();
  });
});

describe("getOpenClawVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should extract version from openclaw --version output", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockReturnValue("OpenClaw 2026.4.11 (769908e)\n");

    expect(getOpenClawVersion()).toBe("2026.4.11");
  });

  it("should return null when openclaw is not installed (ENOENT)", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("spawn openclaw ENOENT") as any;
      err.code = "ENOENT";
      throw err;
    });

    expect(getOpenClawVersion()).toBeNull();
  });

  it("should return null on non-ENOENT errors", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(getOpenClawVersion()).toBeNull();
  });
});

describe("configGet / configSet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should pass correct args to execFileSync", async () => {
    const { configGet } = await loadModule();
    mockExecFileSync.mockReturnValue("some_value\n");

    const result = configGet("channels.octo.accounts.my_bot.botToken");
    expect(result).toBe("some_value");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "openclaw",
      ["config", "get", "channels.octo.accounts.my_bot.botToken"],
      expect.any(Object),
    );
  });

  it("should return null on empty output", async () => {
    const { configGet } = await loadModule();
    mockExecFileSync.mockReturnValue("\n");

    expect(configGet("nonexistent.path")).toBeNull();
  });
});

describe("findGlobalOpenclaw (via module load)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should skip _npx paths and pick global path", async () => {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockReturnValue(
      "/Users/test/.npm/_npx/abc123/node_modules/.bin/openclaw\n/usr/local/bin/openclaw\n",
    );
    const mod = await loadModule();
    mockExecFileSync.mockReturnValue("test\n");
    mod.configGet("test.path");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("should handle CRLF output from Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { execSync } = await import("node:child_process");
      vi.mocked(execSync).mockReturnValue(
        "C:\\npm\\_npx\\openclaw.cmd\r\nC:\\Program Files\\openclaw\\openclaw.exe\r\n",
      );
      const mod = await loadModule();
      mockExecFileSync.mockReturnValue("test\n");
      mod.configGet("test.path");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "C:\\Program Files\\openclaw\\openclaw.exe",
        expect.any(Array),
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should prefer .cmd when where returns both shim variants on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { execSync } = await import("node:child_process");
      vi.mocked(execSync).mockReturnValue(
        "C:\\Users\\mLamp\\AppData\\Roaming\\npm\\openclaw\r\nC:\\Users\\mLamp\\AppData\\Roaming\\npm\\openclaw.cmd\r\n",
      );
      const mod = await loadModule();
      mockExecFileSync.mockReturnValue("OpenClaw 2026.4.21\n");
      mod.getOpenClawVersion();
      // Windows .cmd files are executed via cmd.exe /d /v:off /c call
      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.stringContaining("cmd.exe"),
        expect.arrayContaining(["/d", "/v:off", "/c", "call"]),
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should fallback to npm prefix when where openclaw fails on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { execSync } = await import("node:child_process");
      const { existsSync } = await import("node:fs");

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("where") && cmdStr.includes("openclaw") && !cmdStr.includes("npm")) {
          throw new Error("not found");
        }
        if (cmdStr.includes("where") && cmdStr.includes("npm")) {
          return "C:\\Users\\mLamp\\AppData\\Roaming\\npm\\npm.cmd\r\n";
        }
        return "";
      });

      mockExecFileSync.mockClear();
      mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
        const argsArr = args as string[];
        if (argsArr?.includes?.("prefix")) {
          return "C:\\Users\\mLamp\\AppData\\Roaming\\npm\n";
        }
        return "OpenClaw 2026.4.21\n";
      });

      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        return String(p).endsWith("openclaw.cmd");
      });

      const mod = await loadModule();
      mod.getOpenClawVersion();

      const cmdExeCalls = mockExecFileSync.mock.calls.filter(
        (call) => String(call[0]).includes("cmd.exe"),
      );
      expect(cmdExeCalls.length).toBeGreaterThanOrEqual(2);
      expect(cmdExeCalls.some(
        (call) => (call[1] as string[]).some((a) => a.includes("openclaw.cmd")),
      )).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should fallback to candidate paths when which/where fails", async () => {
    const { execSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("not found"); });
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === "/usr/local/bin/openclaw",
    );
    const mod = await loadModule();
    mockExecFileSync.mockReturnValue("test\n");
    mod.configGet("test.path");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("should fallback to 'openclaw' when nothing found", async () => {
    const { execSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("not found"); });
    vi.mocked(existsSync).mockReturnValue(false);
    const mod = await loadModule();
    mockExecFileSync.mockReturnValue("test\n");
    mod.configGet("test.path");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "openclaw",
      expect.any(Array),
      expect.any(Object),
    );
  });
});
