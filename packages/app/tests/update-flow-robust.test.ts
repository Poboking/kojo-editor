// @vitest-environment happy-dom
/**
 * `useUpdateFlow` 的**健壮性接线**（UPD-A · 2026-11-05）在真 React 生命周期里的行为。
 *
 * 为什么单开这一份：`update-check.test.ts` 钉的是四个纯助手（看门狗竞速 / 会话去重判据 /
 * 进度冲刷器 / 病因透传），但"hook 有没有真把它们接上"不挂进真组件就只是文件头上的愿望——
 * 看门狗超时落态、晚到真结果归还资源、卸载清定时器、重挂跳过真查、终态前最终冲刷、
 * 装完归还 Update 资源，全都在 effect / 回调里。这里用 `createRoot + act` 跑起来。
 *
 * 环境口径照 `search-live-typing.test.ts`：happy-dom 挂真 hook，`vi.useFakeTimers` 走
 * 20s 看门狗 / 150ms 冲刷窗 / 5min 去重窗（真时钟等不起）。宿主 API 全部 mock 掉：
 * `check` / `invoke('updater_env_proxy')` / `isTauri`——本文件不碰真 IPC。
 *
 * 模块级状态注意：会话去重的入账记录住在 `update-flow.tsx` 模块级、**跨用例共享**，
 * 只能用时间洗掉 ⇒ 每条用例开头（beforeEach）先越过 2× 去重窗，再谈各自的时间线。
 *
 * UPD-E（2026-11-05）补**定时重查**（4h interval）的行为面：到点过状态闸
 * （`shouldFirePeriodicRecheck`，纯判据的五态穷尽表在 `update-check.test.ts`）再发检查、
 * 不受挂载去重拦、卸载清干净 / StrictMode 双挂双清、纯手动宿主不挂。注意 UPD-E 起
 * 默认挂载的用例会**多挂一枚 4h interval**——数 `vi.getTimerCount()` 的既有断言随之 +1。
 */
import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_CHECK_DEDUP_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TIMEOUT_REASON,
  UPDATE_RECHECK_INTERVAL_MS,
  isUpdateBusy,
} from '../src/ui/update-check';
import { useUpdateFlow, type UpdateFlow, type UseUpdateFlowOptions } from '../src/ui/update-flow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------- 宿主 API 桩 ------------------------- */

const { checkMock, invokeMock } = vi.hoisted(() => ({ checkMock: vi.fn(), invokeMock: vi.fn() }));

vi.mock('@tauri-apps/plugin-updater', () => ({ check: checkMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../src/bridge/invoke', () => ({ isTauri: () => true }));

type DownloadEventLike =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

interface UpdateLike {
  version: string;
  currentVersion: string;
  body?: string;
  close: ReturnType<typeof vi.fn>;
  downloadAndInstall: ReturnType<typeof vi.fn>;
}

/** 一枚「可更新」的假 Update（0.1.0 → 0.2.0 过契约那把尺必是 updatable） */
function makeUpdate(over: Partial<{ version: string; currentVersion: string; body: string }> = {}): UpdateLike {
  return {
    version: over.version ?? '0.2.0',
    currentVersion: over.currentVersion ?? '0.1.0',
    ...(over.body === undefined ? {} : { body: over.body }),
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  };
}

/** 挂起/放行一枚 promise 的柄（黑洞 check、中途暂停的下载都用它） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 永不落定的黑洞 promise（模拟黑洞代理把 check() 挂死） */
function blackHole(): Promise<never> {
  return new Promise<never>(() => {});
}

/* ------------------------- 挂载脚手架 ------------------------- */

const AUTO_DELAY = 5;
const DEDUP_OPTIONS: UseUpdateFlowOptions = { autoCheckDelayMs: AUTO_DELAY };

function Probe(props: { options: UseUpdateFlowOptions; sink: (f: UpdateFlow) => void }): null {
  props.sink(useUpdateFlow(props.options));
  return null;
}

let container: HTMLDivElement;
let root: Root | null = null;
let flow: UpdateFlow;

async function mountFlow(options: UseUpdateFlowOptions = DEDUP_OPTIONS): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe, { options, sink: (f) => { flow = f; } }));
  });
}

async function unmountFlow(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
}

/** 触发自动检查（越过 autoCheckDelayMs 的静默窗；异步变体顺带 flush 掉 performCheck 的微任务链） */
async function fireAutoCheck(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_DELAY);
  });
}

/**
 * 每条用例的假时钟纪元（整体单调前移 24 小时）。模块级去重记录跨用例共享，而假时钟
 * **每条用例都从真实时刻重新起算**：上一条用例入账的 `at` 常常领先下一条的 `now`
 * （差值是负的 ⇒ `now - at < TTL` 反而判成「窗口内」误跳过）。把每条用例钉在自己的
 * 纪元上，上一条留下的任何入账必然已过期——判据是纯时间算术，顺序无关。
 * UPD-E 起单条用例内部会推进最多 12h（4h tick 重查链），纪元步长必须**大于单条用例
 * 的最大推进量**——1 小时的旧步长会让上一条 tick 入账的记录落在下一条时钟的未来，
 * 级联毒化后面所有用例（2026-11-05 实测 6 连挂的病根）。
 */
let testEpochMs = 0;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  window.localStorage.clear();
  vi.useFakeTimers();
  testEpochMs += 86_400_000;
  vi.setSystemTime(testEpochMs);
  checkMock.mockReset();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null); // updater_env_proxy 取不到 = 无参 check
});

afterEach(async () => {
  await unmountFlow();
  container.remove();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('检查看门狗（UPD-A 第 1 件）', () => {
  it('20s 无响应按 checkFailed 落态：病因固定、busy 解除（两颗按钮不再被禁）', async () => {
    checkMock.mockImplementation(() => blackHole());
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toEqual({ kind: 'checking' });
    expect(isUpdateBusy(flow.phase)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    });
    expect(flow.phase).toEqual({ kind: 'failed', stage: 'check', reason: UPDATE_CHECK_TIMEOUT_REASON });
    expect(isUpdateBusy(flow.phase)).toBe(false);
  });

  it('看门狗赢后晚到的真结果：作废并归还资源（close 恰一次），状态机停在失败态', async () => {
    const d = deferred<UpdateLike | null>();
    checkMock.mockImplementation(() => d.promise);
    await mountFlow();
    await fireAutoCheck();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    });
    const failedPhase = flow.phase;
    expect(failedPhase).toEqual({ kind: 'failed', stage: 'check', reason: UPDATE_CHECK_TIMEOUT_REASON });

    // 真 check() 这时才回来，还带着一枚新 Update：seq 守卫的看门狗延伸必须把它关掉
    const late = makeUpdate();
    d.resolve(late);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(flow.phase).toEqual(failedPhase);
  });

  it('卸载清理把还没响的看门狗定时器一并清掉', async () => {
    checkMock.mockImplementation(() => blackHole());
    await mountFlow();
    await fireAutoCheck();
    // UPD-E 起默认挂载还多挂一枚 4h interval：看门狗 + interval = 2
    expect(vi.getTimerCount()).toBe(2);
    await unmountFlow();
    expect(vi.getTimerCount()).toBe(0); // interval 也被卸载清理收走
  });
});

describe('会话级自动检查去重（UPD-A 第 2 件）', () => {
  it('落 latest 入账：5 分钟内重挂跳过真查；TTL 过后照查', async () => {
    checkMock.mockResolvedValue(null);
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toEqual({ kind: 'latest' });
    await unmountFlow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000); // +1 分钟，窗口内
    });
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1); // 跳过，没打网络
    expect(flow.phase).toEqual({ kind: 'idle' });
    await unmountFlow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_DEDUP_MS); // 越过 TTL（自上次入账起算）
    });
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(flow.phase).toEqual({ kind: 'latest' });
    await unmountFlow();
  });

  it('found 绝不入账：窗口内重挂仍真查（编辑器侧还要举卡）', async () => {
    checkMock.mockResolvedValue(makeUpdate());
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toMatchObject({ kind: 'found', version: '0.2.0' });
    await unmountFlow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    checkMock.mockResolvedValue(makeUpdate());
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(2); // 没被「上次查到过」拦住
    await unmountFlow();
  });

  it('落 failed(check) 也入账：5 分钟内重挂不再把同一堵墙撞第二回（病因照透传）', async () => {
    checkMock.mockRejectedValue(new Error('HTTP 404'));
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toEqual({ kind: 'failed', stage: 'check', reason: 'HTTP 404' });
    await unmountFlow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1); // 跳过
    await unmountFlow();
  });

  it('手动 checkNow 永不跳过、也永不入账：记录 fresh 时手动照查，其结论不带去重', async () => {
    checkMock.mockResolvedValue(null);
    await mountFlow();
    await fireAutoCheck(); // auto → latest，入账（此刻记录 fresh）
    expect(checkMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await flow.checkNow(); // 记录 fresh：手动是明确意图，照查
    });
    expect(checkMock).toHaveBeenCalledTimes(2);

    // 让 auto 那条入账过期，再用一次手动结论单独验证「手动不入账」：
    // 若手动也入账了，下一步窗口内的自动检查就会被它拦住。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_DEDUP_MS + 60_000);
    });
    await act(async () => {
      await flow.checkNow(); // 手动 #3（auto 入账已过期，它照样查；查完不记）
    });
    expect(checkMock).toHaveBeenCalledTimes(3);
    await unmountFlow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000); // 距手动 #3 只有 1 分钟
    });
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(4); // 没被手动的结论拦住 ⇒ 手动确实没入账
    await unmountFlow();
  });
});

describe('失败病因透传（UPD-A 第 4 件）', () => {
  it('检查失败：Error.message 洗净上屏（空白折叠成单空格），不再是哑巴态', async () => {
    checkMock.mockRejectedValue(new Error('HTTP 404\n  endpoint missing'));
    await mountFlow({ enableAutoCheck: false });
    await act(async () => {
      await flow.checkNow();
    });
    expect(flow.phase).toEqual({ kind: 'failed', stage: 'check', reason: 'HTTP 404 endpoint missing' });
  });
});

describe('下载进度节流与终态冲刷（UPD-A 第 3 件）+ 装完还资源（第 5 件）', () => {
  /** 手动查出一枚 Update 并落到 found 态（安装链的前置） */
  async function landFound(update: UpdateLike): Promise<void> {
    checkMock.mockResolvedValue(update);
    await mountFlow({ enableAutoCheck: false });
    await act(async () => {
      await flow.checkNow();
    });
    expect(flow.phase).toMatchObject({ kind: 'found', version: update.version });
  }

  it('Progress 分片窗口内不逐枚上屏，150ms 后一次冲到全量（0 → 900 一步）', async () => {
    const update = makeUpdate();
    const d = deferred<void>();
    update.downloadAndInstall = vi.fn((onEvent: (e: DownloadEventLike) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 1000 } });
      onEvent({ event: 'Progress', data: { chunkLength: 300 } });
      onEvent({ event: 'Progress', data: { chunkLength: 300 } });
      onEvent({ event: 'Progress', data: { chunkLength: 300 } });
      return d.promise;
    });
    await landFound(update);

    let installPromise: Promise<void> | undefined;
    act(() => {
      installPromise = flow.install();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // Started 已上屏；分片只累计
    });
    expect(flow.phase).toMatchObject({ kind: 'downloading', received: 0, total: 1000 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150); // 冲刷窗到期
    });
    expect(flow.phase).toMatchObject({ kind: 'downloading', received: 900, total: 1000 });

    d.resolve(undefined);
    await act(async () => {
      await installPromise;
    });
    expect(flow.phase).toMatchObject({ kind: 'done', version: '0.2.0' });
    expect(update.close).toHaveBeenCalledTimes(1); // 装完也归还资源（UPD-A 第 5 件）
  });

  it('终态前最终冲刷：Finished 缺席、正常返回时欠账冲掉（定时器被收走），received 不缺最后一截', async () => {
    const update = makeUpdate();
    update.downloadAndInstall = vi.fn((onEvent: (e: DownloadEventLike) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 1000 } });
      onEvent({ event: 'Progress', data: { chunkLength: 400 } });
      return Promise.resolve(); // 立即返回：150ms 冲刷窗没到
    });
    await landFound(update);
    await act(async () => {
      await flow.install();
    });
    expect(flow.phase).toMatchObject({ kind: 'done' });
    expect(vi.getTimerCount()).toBe(0); // 只有最终冲刷能收走这枚定时器
    expect(update.close).toHaveBeenCalledTimes(1);
  });

  it('Finished 事件的最终冲刷：分片后同步 Finished + 返回，定时器照样被收走', async () => {
    const update = makeUpdate();
    update.downloadAndInstall = vi.fn((onEvent: (e: DownloadEventLike) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 1000 } });
      onEvent({ event: 'Progress', data: { chunkLength: 400 } });
      onEvent({ event: 'Finished' });
      return Promise.resolve();
    });
    await landFound(update);
    await act(async () => {
      await flow.install();
    });
    expect(flow.phase).toMatchObject({ kind: 'done' });
    expect(vi.getTimerCount()).toBe(0);
    expect(update.close).toHaveBeenCalledTimes(1);
  });

  it('安装失败的病因透传 + 资源保留：failed(install) 带洗净病因，close 不调（重试复用）', async () => {
    const update = makeUpdate();
    update.downloadAndInstall = vi.fn(() => Promise.reject(new Error('下载中断：\n  连接被重置')));
    await landFound(update);
    await act(async () => {
      await flow.install();
    });
    expect(flow.phase).toEqual({
      kind: 'failed',
      stage: 'install',
      reason: '下载中断： 连接被重置',
      release: { version: '0.2.0', currentVersion: '0.1.0' },
    });
    expect(update.close).not.toHaveBeenCalled();
  });

  it('重试路径干净：失败后重试是新的一枚冲刷器，定时器不残留、received 从零重计', async () => {
    const update = makeUpdate();
    let attempt = 0;
    update.downloadAndInstall = vi.fn((onEvent: (e: DownloadEventLike) => void) => {
      attempt += 1;
      onEvent({ event: 'Started', data: { contentLength: 1000 } });
      onEvent({ event: 'Progress', data: { chunkLength: 400 } });
      return attempt === 1 ? Promise.reject(new Error('断')) : Promise.resolve();
    });
    await landFound(update);
    await act(async () => {
      await flow.install();
    });
    expect(flow.phase).toEqual({
      kind: 'failed',
      stage: 'install',
      reason: '断',
      release: { version: '0.2.0', currentVersion: '0.1.0' },
    });
    expect(vi.getTimerCount()).toBe(0); // 失败终态的最终冲刷把上一枚的定时器收走了

    await act(async () => {
      await flow.install(); // 重试
    });
    expect(attempt).toBe(2);
    expect(flow.phase).toMatchObject({ kind: 'done' });
    expect(vi.getTimerCount()).toBe(0);
    expect(update.close).toHaveBeenCalledTimes(1); // 第二次成功：归还资源
  });
});

describe('定时重查（UPD-E）：4h interval 的接线行为', () => {
  it('4h 到点且 latest 态 ⇒ 真的发起检查（挂载去重的 5 分钟 TTL 早已过期，两条判据无互相干扰）', async () => {
    checkMock.mockResolvedValue(null);
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toEqual({ kind: 'latest' }); // auto → latest，此刻入账（at=T0+5s）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    // tick 到点：入账记录已 4 小时陈旧（5 分钟 TTL 必然过期）——真发起，不被任何判据拦
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(flow.phase).toEqual({ kind: 'latest' });
  });

  it('tick 前 1 分钟刚入账的 fresh 记录也拦不住重查（不受挂载去重拦的直接钉子）', async () => {
    checkMock.mockResolvedValue(null);
    // 静默窗特意压到 tick 前 1 分钟：auto 检查恰在 tick 前 60s 落 latest 并入账（fresh）。
    // 若重查也走挂载去重（5 分钟 TTL），这一查必被拦——现在必须照查，才钉得住
    // 「4 小时的到点是新的决策点，shouldSkipAutoCheck 根本不在这条线上」。
    await mountFlow({ autoCheckDelayMs: UPDATE_RECHECK_INTERVAL_MS - 60_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS - 60_000);
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toEqual({ kind: 'latest' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000); // tick 到点：记录仅 1 分钟新
    });
    expect(checkMock).toHaveBeenCalledTimes(2); // fresh 记录没拦住 ⇒ 重查不走挂载去重
    expect(flow.phase).toEqual({ kind: 'latest' });
  });

  it('found 态到点不发起：close 未被调、状态机原地（重查会作废眼前的更新）', async () => {
    const update = makeUpdate();
    checkMock.mockResolvedValue(update);
    await mountFlow();
    await fireAutoCheck();
    expect(flow.phase).toMatchObject({ kind: 'found', version: '0.2.0' });
    expect(checkMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).toHaveBeenCalledTimes(1); // 没打网络
    expect(flow.phase).toMatchObject({ kind: 'found', version: '0.2.0' }); // 状态机原地
    expect(update.close).not.toHaveBeenCalled(); // 重查若发起会先 releaseFound() 关掉这条资源
  });

  it('downloading 态到点不发起：下载不被打断（重查会把在装的 Update 资源关掉）', async () => {
    const update = makeUpdate();
    const d = deferred<void>();
    update.downloadAndInstall = vi.fn(() => d.promise);
    checkMock.mockResolvedValue(update);
    await mountFlow();
    await fireAutoCheck();
    expect(flow.phase).toMatchObject({ kind: 'found' });
    let installPromise: Promise<void> | undefined;
    act(() => {
      installPromise = flow.install();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(flow.phase).toMatchObject({ kind: 'downloading' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).toHaveBeenCalledTimes(1); // 没打网络
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1); // 下载没被重查打断
    d.resolve(undefined);
    await act(async () => {
      await installPromise;
    });
    expect(flow.phase).toMatchObject({ kind: 'done' });
  });

  it('checking 态到点不发起：在途检查不被作废重打（tick 落在 20s 看门狗窗内）', async () => {
    checkMock.mockImplementation(() => blackHole());
    // 静默窗压到 tick 前 10s：tick 到点时检查在途（看门狗还有 10s 才响）。
    // 推进拆三段：act 在段间冲刷渲染，phaseRef 才跟得上 'checking'（单次 advance 里
    // 两个定时器回调之间 React 不重渲，闸会读到旧态——生产里触发点相隔数秒，无此窗）。
    await mountFlow({ autoCheckDelayMs: UPDATE_RECHECK_INTERVAL_MS - 10_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS - 5_000); // 静默检查发起
    });
    expect(flow.phase).toEqual({ kind: 'checking' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // 跨过 tick（4h），看门狗（4h+10s）还没响
    });
    expect(checkMock).toHaveBeenCalledTimes(1); // tick 被状态闸拦下，没有重入
    expect(flow.phase).toEqual({ kind: 'checking' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // 看门狗到点
    });
    expect(flow.phase).toEqual({ kind: 'failed', stage: 'check', reason: UPDATE_CHECK_TIMEOUT_REASON });
  });

  it('done 态到点不发起：装完了不再空转打网络', async () => {
    const update = makeUpdate();
    checkMock.mockResolvedValue(update);
    await mountFlow();
    await fireAutoCheck();
    await act(async () => {
      await flow.install();
    });
    expect(flow.phase).toMatchObject({ kind: 'done' });
    expect(checkMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toMatchObject({ kind: 'done' });
  });

  it('failed(install) 态到点不发起：失败态挂着 release 供重试，重查不顶掉它', async () => {
    const update = makeUpdate();
    update.downloadAndInstall = vi.fn(() => Promise.reject(new Error('断')));
    checkMock.mockResolvedValue(update);
    await mountFlow();
    await fireAutoCheck();
    await act(async () => {
      await flow.install();
    });
    expect(flow.phase).toEqual({
      kind: 'failed',
      stage: 'install',
      reason: '断',
      release: { version: '0.2.0', currentVersion: '0.1.0' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(flow.phase).toMatchObject({ kind: 'failed', stage: 'install' }); // 原地，可重试
  });

  it('failed(check) 态到点放行：上一轮失败的到点默默重试（私仓 404 是常态，照旧不弹窗）', async () => {
    checkMock.mockRejectedValueOnce(new Error('HTTP 404')).mockResolvedValueOnce(null);
    await mountFlow();
    await fireAutoCheck();
    expect(flow.phase).toEqual({ kind: 'failed', stage: 'check', reason: 'HTTP 404' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).toHaveBeenCalledTimes(2); // 重查真发起了
    expect(flow.phase).toEqual({ kind: 'latest' }); // 这次通了，落回 latest
  });

  it('卸载后 interval 清干净：绝不发起、无残留定时器；重挂是新周期不双发', async () => {
    checkMock.mockResolvedValue(null);
    await mountFlow();
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1);
    await unmountFlow();
    expect(vi.getTimerCount()).toBe(0); // interval 被卸载清理收走，不是只清静默窗定时器
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS * 2);
    });
    expect(checkMock).toHaveBeenCalledTimes(1); // 卸载后到点也绝不发起
    await mountFlow();
    await fireAutoCheck(); // 首轮入账早已过期（8 小时前），照查
    expect(checkMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    // 新实例的 4h 周期恰一查。若旧 interval 泄漏（8h 推进时就会多打一轮），这里会是 4
    expect(checkMock).toHaveBeenCalledTimes(3);
  });

  it('StrictMode 双挂双清：effect 跑两遍只挂一枚 interval，到点恰一查、卸载全收', async () => {
    checkMock.mockResolvedValue(null);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(StrictMode, null, createElement(Probe, { options: DEDUP_OPTIONS, sink: (f) => { flow = f; } })),
      );
    });
    await fireAutoCheck();
    expect(checkMock).toHaveBeenCalledTimes(1); // autoFiredRef + cleanup 重排：静默检查恰一次
    expect(vi.getTimerCount()).toBe(1); // 双挂后只剩 interval：静默窗定时器已响、看门狗已随结果拆掉
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).toHaveBeenCalledTimes(2); // 到点恰一查——若 interval 挂了两枚这里会是 3
    expect(flow.phase).toEqual({ kind: 'latest' });
    await unmountFlow();
    expect(vi.getTimerCount()).toBe(0); // 双清干净
  });

  it('纯手动宿主不挂 interval：autoCheckDelayMs<=0 与 enableAutoCheck=false 到点零动作', async () => {
    checkMock.mockResolvedValue(null);
    await mountFlow({ autoCheckDelayMs: 0 });
    expect(vi.getTimerCount()).toBe(0); // 静默检查与 interval 都不挂
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).not.toHaveBeenCalled();
    await unmountFlow();

    await mountFlow({ enableAutoCheck: false });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('手动 checkNow 不受 interval 存在影响：任何时刻照常立即查', async () => {
    checkMock.mockResolvedValue(null);
    // 静默窗压到 tick 之后：这段推进里没有自动检查，checkNow 的这一次是真·手动
    await mountFlow({ autoCheckDelayMs: UPDATE_RECHECK_INTERVAL_MS + 60_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 挂到 2h，interval 未到点
      await flow.checkNow();
    });
    expect(checkMock).toHaveBeenCalledTimes(1); // 手动立即查，不等 interval
    expect(flow.phase).toEqual({ kind: 'latest' });
  });
});
