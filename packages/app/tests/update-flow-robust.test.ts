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
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_CHECK_DEDUP_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TIMEOUT_REASON,
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
 * 每条用例的假时钟纪元（整体单调前移 1 小时）。模块级去重记录跨用例共享，而假时钟
 * **每条用例都从真实时刻重新起算**：上一条用例入账的 `at` 常常领先下一条的 `now`
 * （差值是负的 ⇒ `now - at < TTL` 反而判成「窗口内」误跳过）。把每条用例钉在自己的
 * 纪元上，上一条留下的任何入账必然已过期——判据是纯时间算术，顺序无关。
 */
let testEpochMs = 0;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  window.localStorage.clear();
  vi.useFakeTimers();
  testEpochMs += 3_600_000;
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
    expect(vi.getTimerCount()).toBe(1); // 只剩看门狗（静默窗定时器已响）
    await unmountFlow();
    expect(vi.getTimerCount()).toBe(0);
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
