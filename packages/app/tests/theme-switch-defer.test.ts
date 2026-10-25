import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMonacoTheme, monacoThemeIdFor, type MonacoThemeSink } from '../src/monaco/theme';

/**
 * 换主题"两段式"的钉子（2026-10-25 性能批 S5）。
 *
 * ## 为什么这么改（读数写在这里，源码 `monaco/theme.ts` 只留一句话——它在开机静态图里，注释也占包体）
 * 一次换主题原本把两件独立的重活压进同一帧：
 * ① `data-theme` 翻 token（`themes/*.css`）⇒ 整页 style recalc + layout；
 * ② `monaco.editor.setTheme` ⇒ 重算 token 色 + 重绘视口 + 缩略图。
 * 调试宿同会话（6003 行 erb、双向各多轮）：单做①最长帧 34.8ms、单做②39.9ms，
 * 合在一帧 **60.8 / 62.9 / 65.9ms、长任务 56 / 57 / 62ms**（每次必有 1 条）。
 * CPU 采样把主因指到 monaco 视口的 `prepareRenderText → onBeforeRender` 里那一次
 * `getBoundingClientRect`（采样内 self 676ms / 7 次）——它替整页 style recalc 付了强制
 * 同步布局的账。两件事都不是慢在自己身上，而是慢在"同一帧里互相逼出对方的布局"，
 * 所以解法是错帧，不是优化其中一件。
 *
 * 改后（页内定时驱动 + `perf` 探针，排除 CDP 求值那一下的干扰）：最长帧 **45.3–49.6ms**、
 * 掉帧 1、**长任务 0**（4 轮全 0）。页内自采样（完全没有 CDP 打扰）看到两段各
 * 33.3 / 33.4ms。剩下那 ~17ms 是 monaco 换主题时重绘整张 minimap：诊断里把缩略图关掉，
 * 同一帧降到 33.5ms 且长任务 0。本仓没有缩略图开关，属 monaco 内部行为，留给后续批。
 *
 * 帧策略也是量出来的：`rAF → setTimeout(0)` 反而更差（68–86ms——多等一帧既不省工作量，
 * 还把空隙拉长成一次重卡）；双 rAF 与单 rAF 打平（41.8–45.5 vs 41.9–43.5），但双 rAF
 * 把"壳新编辑器旧"的中间态翻倍到 2 帧 ⇒ 取单 rAF（中间态最多 1 帧）。
 *
 * ## 本文件钉的两条时序契约
 * ①**同帧合并**：连切多次只落最后一次（快速连切 light→dark→light 不许排队重放）；
 * ②**当帧不动手**：调用当刻一次 `setTheme` 都不许发生——先让 CSS 那段上屏。
 *
 * node 环境没有 rAF，`applyMonacoTheme` 走 `setTimeout` 那条退化路：假定时器即可把
 * "下一帧"推进到"下一个宏任务"，两条契约因此都能在纯逻辑面钉死（每个用例 `vi.resetModules()`
 * 取全新单例，避免模块级队列串味）。
 */

function fakeSink() {
  const calls: string[] = [];
  const sink: MonacoThemeSink = {
    editor: {
      setTheme: (themeName: string) => {
        calls.push(themeName);
      },
    },
  };
  return { sink, calls };
}

/** 取一份全新的模块实例（模块级队列/armed 单例不许跨用例串味） */
async function freshModule() {
  vi.resetModules();
  return import('../src/monaco/theme');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('applyMonacoTheme：当帧只登记，下一帧才落', () => {
  it('调用当刻一次 setTheme 都不发生（先让 CSS 那段上屏）', async () => {
    vi.useFakeTimers();
    const { applyMonacoTheme: apply } = await freshModule();
    const { sink, calls } = fakeSink();

    apply(sink, 'light');
    expect(calls).toEqual([]);

    vi.runAllTimers();
    expect(calls).toEqual(['kojo-light']);
  });

  it('偏好 → 主题 id 走既有映射（三档逐个对拍）', async () => {
    vi.useFakeTimers();
    const { applyMonacoTheme: apply } = await freshModule();
    for (const pref of ['dark', 'light', 'mint-dark'] as const) {
      const { sink, calls } = fakeSink();
      apply(sink, pref);
      vi.runAllTimers();
      expect(calls, pref).toEqual([monacoThemeIdFor(pref)]);
    }
  });
});

describe('applyMonacoTheme：同帧合并', () => {
  it('同一帧连切 3 次只落一次，参数取最后一次（快速连切不重放中间档）', async () => {
    vi.useFakeTimers();
    const { applyMonacoTheme: apply } = await freshModule();
    const { sink, calls } = fakeSink();

    apply(sink, 'light');
    apply(sink, 'dark');
    apply(sink, 'light');
    expect(calls).toEqual([]); // 当帧不动手

    vi.runAllTimers();
    expect(calls).toEqual(['kojo-light']); // 一次，且是最后那档
  });

  it('连续 5 次连切（light→dark→…）只落最后一档，不累积、不重放', async () => {
    vi.useFakeTimers();
    const { applyMonacoTheme: apply } = await freshModule();
    const { sink, calls } = fakeSink();
    for (const pref of ['light', 'dark', 'light', 'dark', 'light'] as const) apply(sink, pref);

    vi.runAllTimers();
    expect(calls).toEqual(['kojo-light']);
  });

  it('落帧之后可以再排：第二帧的切换照常生效（不是一次性闸）', async () => {
    vi.useFakeTimers();
    const { applyMonacoTheme: apply } = await freshModule();
    const { sink, calls } = fakeSink();

    apply(sink, 'light');
    vi.runAllTimers();
    apply(sink, 'mint-dark');
    expect(calls).toEqual(['kojo-light']); // 第二次还没落
    vi.runAllTimers();
    expect(calls).toEqual(['kojo-light', 'kojo-mint-dark']);
  });
});

describe('applyMonacoTheme：多消费方共用一条队列', () => {
  it('主编辑器 + overlay 同帧各调一次（同一枚 monaco 面）只落一次 setTheme', async () => {
    vi.useFakeTimers();
    const { applyMonacoTheme: apply } = await freshModule();
    const { sink, calls } = fakeSink();

    // 真实形态：`entry` 的命名空间单例被所有消费方共享
    apply(sink, 'light');
    apply(sink, 'dark');
    apply(sink, 'mint-dark');
    vi.runAllTimers();
    expect(calls).toEqual(['kojo-mint-dark']);
  });

  it('无 rAF 的环境（node / 老内核）退化为宏任务：请求绝不丢', async () => {
    vi.useFakeTimers();
    const { applyMonacoTheme: apply } = await freshModule();
    expect(typeof requestAnimationFrame).toBe('undefined');

    const { sink, calls } = fakeSink();
    apply(sink, 'dark');
    expect(calls).toEqual([]);
    vi.runAllTimers();
    expect(calls).toEqual(['kojo-dark']);
  });
});
