/**
 * 会话初始化冲突的兜底重试。
 *
 * OpenClaw core 在 `commitReplySessionInitialization` 用 session entry 的 revision 做乐观锁 CAS
 * (`get-reply.js`)。当同一 session(同群)两条消息紧挨着来,turn N 的异步 session 收尾写与
 * turn N+1 的 init 提交竞态,CAS 连续两次读到脏 revision → 抛 `reply session initialization
 * conflicted for <sessionKey>`,该条入站被静默丢弃(用户端"没反应")。
 *
 * 这是瞬态冲突:重试前一条的收尾写很快完成。故对**且仅对**该错误做短退避重试,把"丢消息"
 * 变成"稍晚回复"。冲突发生在 init 阶段(进模型前、任何投递前,实测 duration≈11ms),因此重试
 * 不会造成重复回复。其它错误(超时/网络/业务)一律立即抛,不重试。
 */

/** 是否为 core 的会话初始化冲突错误。 */
export function isSessionInitConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /reply session initialization conflicted/i.test(msg);
}

interface RetryOpts {
  /** 冲突时最多重试几次(不含首次)。 */
  retries: number;
  /** 退避基数(ms),第 n 次退避 = backoffMs * n(线性)。 */
  backoffMs: number;
  /** 可注入的 sleep(测试用);缺省真实 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  log?: { warn?: (msg: string) => void };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 跑 task;仅当抛出「会话初始化冲突」且未超重试上限时,线性退避后重试。其它错误立即抛。
 */
export async function runWithSessionInitRetry(task: () => Promise<void>, opts: RetryOpts): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      await task();
      return;
    } catch (err) {
      if (isSessionInitConflict(err) && attempt < opts.retries) {
        attempt++;
        opts.log?.warn?.(
          `octo: session init conflict, retrying (${attempt}/${opts.retries}) after ${opts.backoffMs * attempt}ms`,
        );
        await sleep(opts.backoffMs * attempt);
        continue;
      }
      throw err;
    }
  }
}
