import { describe, it, expect, vi, beforeEach } from "vitest";
import { inheritParentMdToChildThread } from "./fork-inherit-md.js";
import * as api from "../api-fetch.js";

// Mock only the network calls; keep the real `httpStatusFromApiFetchError`
// (a pure parser) so status extraction is exercised end-to-end, not re-stubbed.
vi.mock("../api-fetch.js", async (importActual) => ({
  ...(await importActual<typeof import("../api-fetch.js")>()),
  getGroupMd: vi.fn(),
  getThreadMd: vi.fn(),
  updateThreadMd: vi.fn(),
}));

// Mock only the disk-cache broadcast; keep the real path-parsing helpers
// (extractParentGroupNo / extractThreadShortId) that inherit-md also uses.
vi.mock("../group-md.js", async (importActual) => ({
  ...(await importActual<typeof import("../group-md.js")>()),
  broadcastThreadMdUpdate: vi.fn(),
}));
import * as groupMd from "../group-md.js";

const getGroupMd = vi.mocked(api.getGroupMd);
const getThreadMd = vi.mocked(api.getThreadMd);
const updateThreadMd = vi.mocked(api.updateThreadMd);
const broadcastThreadMdUpdate = vi.mocked(groupMd.broadcastThreadMdUpdate);

const mdResp = (content: string) => ({ content, version: 1, updated_at: null, updated_by: "tester" });
const httpErr = (who: string, status: number) => new Error(`${who} failed (${status}): nope`);

const base = { apiUrl: "http://octo.test", botToken: "bf_token", accountId: "acct1" };
// Parent is a plain group.
const groupParent = { ...base, parentChannelId: "G1", childGroupNo: "G1", childShortId: "C1" };
// Parent is itself a thread (G1____P1).
const threadParent = { ...base, parentChannelId: "G1____P1", childGroupNo: "G1", childShortId: "C1" };

describe("inheritParentMdToChildThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateThreadMd.mockResolvedValue({ version: 1 });
  });

  it("1. parent group + non-empty GROUP.md → ok, writes once", async () => {
    getGroupMd.mockResolvedValue(mdResp("group rules"));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("ok");
    expect(getGroupMd).toHaveBeenCalledTimes(1);
    expect(updateThreadMd).toHaveBeenCalledTimes(1);
    expect(updateThreadMd).toHaveBeenCalledWith(
      expect.objectContaining({ groupNo: "G1", shortId: "C1", content: "group rules" }),
    );
  });

  it("2. parent group + empty GROUP.md → skipped_empty, no write", async () => {
    getGroupMd.mockResolvedValue(mdResp(""));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("skipped_empty");
    expect(updateThreadMd).not.toHaveBeenCalled();
  });

  it("3. parent group + GROUP.md 404 → skipped_empty", async () => {
    getGroupMd.mockRejectedValue(httpErr("getGroupMd", 404));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("skipped_empty");
    expect(updateThreadMd).not.toHaveBeenCalled();
  });

  it("4. parent group + whitespace-only GROUP.md → skipped_empty", async () => {
    getGroupMd.mockResolvedValue(mdResp("   \n\t "));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("skipped_empty");
    expect(updateThreadMd).not.toHaveBeenCalled();
  });

  it("5. parent thread + non-empty THREAD.md → ok, uses thread.md content", async () => {
    getThreadMd.mockResolvedValue(mdResp("from-thread"));
    const status = await inheritParentMdToChildThread(threadParent);
    expect(status).toBe("ok");
    expect(getThreadMd).toHaveBeenCalledWith(
      expect.objectContaining({ groupNo: "G1", shortId: "P1" }),
    );
    expect(getGroupMd).not.toHaveBeenCalled(); // decision (a): no group.md fallback
    expect(updateThreadMd).toHaveBeenCalledWith(
      expect.objectContaining({ groupNo: "G1", shortId: "C1", content: "from-thread" }),
    );
  });

  it("6. (a) invariant: parent thread + empty THREAD.md → skipped_empty, NO group.md fallback", async () => {
    getThreadMd.mockResolvedValue(mdResp(""));
    const status = await inheritParentMdToChildThread(threadParent);
    expect(status).toBe("skipped_empty");
    expect(getGroupMd).not.toHaveBeenCalled();
    expect(updateThreadMd).not.toHaveBeenCalled();
  });

  it("7. (a) invariant: parent thread + THREAD.md 404 → skipped_empty, NO group.md fallback", async () => {
    getThreadMd.mockRejectedValue(httpErr("getThreadMd", 404));
    const status = await inheritParentMdToChildThread(threadParent);
    expect(status).toBe("skipped_empty");
    expect(getGroupMd).not.toHaveBeenCalled();
    expect(updateThreadMd).not.toHaveBeenCalled();
  });

  it("8. content exactly 10240 bytes → ok", async () => {
    getGroupMd.mockResolvedValue(mdResp("a".repeat(10240)));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("ok");
    expect(updateThreadMd).toHaveBeenCalledTimes(1);
  });

  it("9. content 10241 bytes → skipped_too_large, no write", async () => {
    getGroupMd.mockResolvedValue(mdResp("a".repeat(10241)));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("skipped_too_large");
    expect(updateThreadMd).not.toHaveBeenCalled();
  });

  it("10. updateThreadMd throws 403 → no_permission (no escaping exception)", async () => {
    getGroupMd.mockResolvedValue(mdResp("rules"));
    updateThreadMd.mockRejectedValue(httpErr("updateThreadMd", 403));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("no_permission");
  });

  it("11. updateThreadMd throws non-403 → update_failed", async () => {
    getGroupMd.mockResolvedValue(mdResp("rules"));
    updateThreadMd.mockRejectedValue(httpErr("updateThreadMd", 500));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("update_failed");
  });

  it("12. getGroupMd network error (no HTTP status) → fetch_failed", async () => {
    getGroupMd.mockRejectedValue(new Error("network timeout"));
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("fetch_failed");
    expect(updateThreadMd).not.toHaveBeenCalled();
  });

  it("13. ok write → mirrors content into local disk cache via broadcastThreadMdUpdate", async () => {
    getGroupMd.mockResolvedValue(mdResp("group rules"));
    updateThreadMd.mockResolvedValue({ version: 7 });
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("ok");
    expect(broadcastThreadMdUpdate).toHaveBeenCalledWith({
      accountId: "acct1",
      groupNo: "G1",
      shortId: "C1",
      content: "group rules",
      version: 7,
    });
  });

  it("14. server write ok but local cache broadcast throws → still ok (server is SSOT)", async () => {
    getGroupMd.mockResolvedValue(mdResp("group rules"));
    updateThreadMd.mockResolvedValue({ version: 1 });
    broadcastThreadMdUpdate.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("ok");
  });

  it("15. skipped/failed paths do NOT touch the local cache", async () => {
    getGroupMd.mockResolvedValue(mdResp("")); // empty → skipped_empty, no write
    const status = await inheritParentMdToChildThread(groupParent);
    expect(status).toBe("skipped_empty");
    expect(broadcastThreadMdUpdate).not.toHaveBeenCalled();
  });
});
