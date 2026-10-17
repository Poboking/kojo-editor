/**
 * PS-5 · 装饰轮的体量闸（marker-pool.ts）。
 *
 * 钉的是**行为**，不只是判据函数：
 *  ① 越界那一轮**一次文本都不取**（`readText` 调用数 = 0）——改前每停笔一次就
 *     `getValue()` 一份 + structured-clone 一份，两份都留在主线程；
 *  ② 一条贡献都不跑、不进缓存（暂停期间不许把"上一轮的结果"当"本轮的结果"发布）；
 *  ③ 跨界**只通知一次**（宿主据此显示/收回提示，铁律 4「不静默」的落点）；
 *  ④ 进入暂停时把这一份文件的旧结果撤一次（面板不能继续宣称"这就是这份文件的真相"）；
 *  ⑤ `dropPath` / `clear` 连带销暂停态（关标签后提示不该粘在别处）；
 *  ⑥ 不接 `sizeOf` 时行为与接闸前逐字一致（additive，零回归面）。
 */
import { describe, expect, it } from 'vitest';
import type { ComputePool, GameProject, LineDecoration } from '@kojo/plugin-api';
import {
  MARKER_VALIDATE_MAX_LINES,
  MARKER_VALIDATE_MAX_UNITS,
  createMarkerRunner,
  markerValidationPaused,
  type MarkerContributor,
} from '../src/ui/marker-pool';

const project = (): GameProject => ({ adapterId: 'x', rootDir: '/game', inputDigest: 'd1' }) as unknown as GameProject;

const OVER = { units: MARKER_VALIDATE_MAX_UNITS + 1, lineCount: 10 };
const UNDER = { units: 1_000, lineCount: 100 };

interface Harness {
  runner: ReturnType<typeof createMarkerRunner>;
  /** 宿主侧 `readText` 被调了几次（= 整篇文本复制付了几遍） */
  reads: number;
  /** 就地/通道两条走法里贡献体被跑了几次 */
  runs: number;
  publishes: LineDecoration[][];
  notices: Array<{ path: string; paused: boolean }>;
  settle: () => Promise<void>;
}

/**
 * @param size 体量读数提供器（不传 = 不接闸，走改前形态）
 * @param version 恒定的 model 版本号（默认 1；缓存判据就按它走）
 */
function harness(size?: (path: string) => { units: number; lineCount: number } | undefined, version = 1): Harness {
  const h: Harness = { runner: undefined as never, reads: 0, runs: 0, publishes: [], notices: [], settle: async () => {} };
  const compute = {
    offload: async <T,>(): Promise<T> => [] as unknown as T,
    runLatest: async <T,>(_key: string, _opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    yieldToMain: async () => {},
  } as unknown as Pick<ComputePool, 'offload' | 'runLatest' | 'yieldToMain'>;
  const light: MarkerContributor = {
    id: 'light',
    decorate: () => {
      h.runs++;
      return [{ line: 1, severity: 'info', message: '轻装饰' }];
    },
  };
  const heavy: MarkerContributor = {
    id: 'heavy',
    offloadKind: 'x.heavy',
    decorate: () => {
      h.runs++;
      return [{ line: 2, severity: 'warning', message: '重装饰' }];
    },
  };
  h.runner = createMarkerRunner({
    compute,
    // 两条重装饰都判成"worker 里没有" ⇒ 走异步就地那档，`decorate` 真被调用，
    // `h.runs` 才数得到"这一轮到底跑了几条贡献"（本文件测的是暂停闸，不是通道选择）
    workerHasTask: () => false,
    contributors: () => [light, heavy],
    project,
    versionOf: () => version,
    publish: (_path, decorations) => h.publishes.push(decorations),
    ...(size ? { sizeOf: size } : {}),
    pauseChanged: (path, paused) => h.notices.push({ path, paused }),
  });
  h.settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return h;
}

/** 计数版取文本桩（`harness().reads` 由它累加） */
function counted(h: Harness): () => string {
  return () => {
    h.reads++;
    return '行一\n行二\n';
  };
}

describe('markerValidationPaused（纯判据）', () => {
  it('两条判据各自独立越界即停；阈值以下一律放行', () => {
    expect(markerValidationPaused({ units: 0, lineCount: 0 })).toBe(false);
    expect(markerValidationPaused({ units: MARKER_VALIDATE_MAX_UNITS, lineCount: MARKER_VALIDATE_MAX_LINES })).toBe(
      false,
    );
    expect(markerValidationPaused({ units: MARKER_VALIDATE_MAX_UNITS + 1, lineCount: 0 })).toBe(true);
    expect(markerValidationPaused({ units: 0, lineCount: MARKER_VALIDATE_MAX_LINES + 1 })).toBe(true);
  });

  it('阈值必须把**真实语料最大那份文件**留在闸内（52,601 行 / 2.35 MB UTF-8）', () => {
    // CJK 密度高的形态（一汉字 = 3 字节 / 1 码元）
    expect(markerValidationPaused({ units: 1_300_000, lineCount: 52_601 })).toBe(false);
    // 极端反证：整份全是 ASCII ⇒ 码元数就等于字节数 2.35 M —— 这一档也必须不拦，
    // 否则"编码密度"会变成一份真实文件突然没波浪线的偶然因素
    expect(markerValidationPaused({ units: 2_350_000, lineCount: 52_601 })).toBe(false);
    // 闸挡住的是"比最大真实文件再大一截"那种盘（实测那一轮 ≈2.8 s：structure 268ms + expr 2,508ms）
    expect(markerValidationPaused({ units: 20_000_000, lineCount: 990_000 })).toBe(true);
    expect(markerValidationPaused({ units: 3_600_000, lineCount: 200_001 })).toBe(true);
  });
});

describe('装饰轮的暂停语义（行为面）', () => {
  it('越界：一次文本都不取、一条贡献都不跑、除"撤旧结果"外一次都不发布', async () => {
    const h = harness(() => OVER);
    h.runner.refresh('/big.erb', counted(h));
    await h.settle();
    expect(h.reads).toBe(0);
    expect(h.runs).toBe(0);
    expect(h.runner.stats().paused).toBe(1);
    expect(h.runner.stats().misses).toBe(0);
    expect(h.runner.stats().dispatched).toBe(0);
    expect(h.publishes).toEqual([[]]); // 只有"进入暂停时撤一次"这一发，且撤的是空档
    expect(h.notices).toEqual([{ path: '/big.erb', paused: true }]);
  });

  it('跨界只通知一次：连续三轮停着 ⇒ notices 仍一条，暂停计数逐轮累加', async () => {
    const h = harness(() => OVER);
    for (let i = 0; i < 3; i++) h.runner.refresh('/big.erb', counted(h));
    await h.settle();
    expect(h.notices).toHaveLength(1);
    expect(h.runner.stats().paused).toBe(3);
    expect(h.publishes).toHaveLength(1);
  });

  it('闸内：正常两拍发布；同版本第二轮命中缓存 ⇒ 连文本都不再取', async () => {
    const h = harness(() => UNDER);
    h.runner.refresh('/a.erb', counted(h));
    await h.settle();
    expect(h.runs).toBe(2);
    expect(h.publishes.length).toBe(2); // 半档（轻的先上屏）+ 整档（重的回来）
    const readsAfterFirst = h.reads;
    h.runner.refresh('/a.erb', counted(h));
    await h.settle();
    expect(h.reads).toBe(readsAfterFirst); // 命中缓存：零复制（这条改前就有，不许被闸带歪）
    expect(h.notices).toEqual([]); // 从未跨界 ⇒ 一次都不该通知
  });

  it('退出暂停：改小之后下一轮照常算（不靠特判，版本号判据自洽）', async () => {
    let big = true;
    const h = harness(() => (big ? OVER : UNDER));
    h.runner.refresh('/a.erb', counted(h));
    await h.settle();
    expect(h.runs).toBe(0);
    big = false;
    h.runner.refresh('/a.erb', counted(h));
    await h.settle();
    expect(h.runs).toBe(2);
    expect(h.notices.map((n) => n.paused)).toEqual([true, false]);
  });

  it('dropPath / clear 都销暂停态并通知收回（关标签后提示不许粘着）', () => {
    const h = harness(() => OVER);
    h.runner.refresh('/a.erb', counted(h));
    expect(h.notices).toEqual([{ path: '/a.erb', paused: true }]);
    h.runner.dropPath('/a.erb');
    expect(h.notices).toEqual([
      { path: '/a.erb', paused: true },
      { path: '/a.erb', paused: false },
    ]);
    h.runner.refresh('/a.erb', counted(h)); // 重新进暂停（同一轮判据仍越界）
    h.runner.clear();
    expect(h.notices.filter((n) => n.paused === false)).toHaveLength(2); // dropPath + clear 各一次收回
  });

  it('不接 sizeOf（改前形态）：判据完全不介入，一轮照跑两拍发布', async () => {
    const h = harness();
    h.runner.refresh('/a.erb', counted(h));
    await h.settle();
    expect(h.runs).toBe(2);
    expect(h.runner.stats().paused).toBe(0);
    expect(h.notices).toEqual([]);
    expect(h.publishes.length).toBe(2);
  });

  it('model 已关（versionOf 给 undefined）时体量闸不许抢先做一次发布', () => {
    let published = 0;
    const runner = createMarkerRunner({
      compute: {
        offload: async <T,>(): Promise<T> => [] as unknown as T,
        runLatest: async <T,>(_k: string, _o: unknown, fn: () => Promise<T>): Promise<T> => fn(),
        yieldToMain: async () => {},
      } as unknown as Pick<ComputePool, 'offload' | 'runLatest' | 'yieldToMain'>,
      workerHasTask: () => true,
      contributors: () => [],
      project,
      versionOf: () => undefined,
      publish: () => published++,
      sizeOf: () => ({ units: 9_000_000, lineCount: 300_000 }),
    });
    runner.refresh('/gone.erb', () => 'x');
    expect(published).toBe(0);
  });
});
