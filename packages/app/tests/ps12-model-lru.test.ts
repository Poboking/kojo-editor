/**
 * PS-12 · model 池的冷档与内存观测（editor-model-pool.ts）。
 *
 * 背景：改前 `release()` refs 归零 = 立即 dispose——「误关立刻重开」要付整次读盘 +
 * 重建 model（真壳里还有 Monarch tokenization 全篇首扫）。对标 VSCode 的 model
 * 生命周期，关掉的**干净**件先进有界冷档：tokenization 行缓存保住、重开零读盘。
 *
 * 本文件钉四层判据：
 *  ① **对外语义红线**：`release()` 返回值 / `refCount` / 加载失败回收的既有口径
 *     一行不变（冷档对外完全不可见——调用方照做终局清理）；
 *  ② **保守缺省链**：三注入（modelUnits / modelVersion / writeText）任一缺席 ⇒
 *     冷档禁用，`release` 归零即 dispose（改前行为，旧调用方零回退）；
 *  ③ **安全闸**：只收干净件（脏 / 恢复件立即 dispose）；冷档件被程序性改写
 *     （替换执行器家族命中注册表 model：只改 model 不写盘）⇒ 池补写盘还原
 *     「关着 ⇒ io 读改写」语义，写盘失败 ⇒ 钉住不驱逐；`file.changed` ⇒ 弃档
 *     （重开必读盘 = 改前行为）；
 *  ④ **观测面**：`stats()` 三本账 + 活动正文合计超阈 warn（铁律 4：不静默）。
 *
 * 墙钟与内存读数在 `ps12-model-lru.perf.test.ts`（串行计时池，真 fs 口径）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Kernel } from '@kojo/kernel';
import type * as Monaco from '../src/monaco/entry';
import type { PoolDeps } from '../src/ui/editor-model-pool';
import {
  ACTIVE_POOL_WARN_UNITS,
  COLD_CACHE_BUDGET_UNITS,
  COLD_CACHE_MAX_MODELS,
  COLD_CACHE_MAX_UNITS,
  createEditorModelPool,
} from '../src/ui/editor-model-pool';

type ITextModel = Monaco.editor.ITextModel;
type ChangeListener = { dispose(): void };

/** mock model：版本号语义与 Monaco 同形（getAlternativeVersionId / applyEdits 走版本号） */
class MockModel {
  readonly changeListeners = new Set<() => void>();
  disposed = false;

  constructor(
    readonly path: string,
    public text: string,
    public version = 1, // Monaco alternativeVersionId 从 1 起数（恢复件 baseline=0 永不相等的口径）
  ) {}

  getValue(): string {
    return this.text;
  }

  getValueLength(): number {
    return this.text.length;
  }

  getAlternativeVersionId(): number {
    return this.version;
  }

  onDidChangeContent(cb: () => void): ChangeListener {
    this.changeListeners.add(cb);
    return { dispose: () => this.changeListeners.delete(cb) };
  }

  /** 模拟程序性改写（applyEdits）：换文本 + 版本号前进 + 同步触发监听 */
  edit(next: string): void {
    this.text = next;
    this.version += 1;
    for (const cb of [...this.changeListeners]) cb();
  }

  dispose(): void {
    this.disposed = true;
    this.changeListeners.clear();
  }
}

type FcEv = { kind: 'add' | 'change' | 'unlink'; path: string };

function fakeBus() {
  const subs = new Set<(ev: FcEv) => void>();
  return {
    on: vi.fn((name: string, cb: (ev: FcEv) => void) => {
      if (name !== 'file.changed') return () => {};
      subs.add(cb);
      return () => subs.delete(cb);
    }),
    emit: (ev: FcEv): void => {
      for (const s of [...subs]) s(ev);
    },
  };
}

interface Harness {
  pool: ReturnType<typeof createEditorModelPool>;
  kernel: Kernel;
  disk: Record<string, string>;
  readCalls: string[];
  models: MockModel[];
  writeText: ReturnType<typeof vi.fn>;
  bus: ReturnType<typeof fakeBus>;
  warns: string[];
}

/**
 * PS-12 harness：**全注入**（冷档开启态）。要量「改前行为」就别给三探针——
 * 见「保守缺省链」组里单独手搓的 harness。
 */
function harness(files: Record<string, string>, opts?: { writeFail?: boolean }): Harness {
  const disk: Record<string, string> = { ...files };
  const readCalls: string[] = [];
  const models: MockModel[] = [];
  const bus = fakeBus();
  const kernel = { bus } as unknown as Kernel;
  const warns: string[] = [];
  const writeText = vi.fn(async (_k: Kernel, path: string, text: string) => {
    if (opts?.writeFail) throw new Error('写域拒绝（测试注入）');
    disk[path] = text;
  });
  const deps: PoolDeps = {
    readText: vi.fn(async (_k: Kernel, path: string) => {
      readCalls.push(path);
      if (!(path in disk)) throw new Error(`ENOENT: ${path}`);
      return { text: disk[path]!, encoding: 'utf-8', eol: 'LF' };
    }),
    createModel: (path: string, text: string) => {
      const m = new MockModel(path, text);
      models.push(m);
      return m as unknown as ITextModel;
    },
    modelUnits: (m) => m.getValueLength(),
    modelVersion: (m) => m.getAlternativeVersionId(),
    writeText,
    warn: (msg) => warns.push(msg),
  };
  return { pool: createEditorModelPool(deps), kernel, disk, readCalls, models, writeText, bus, warns };
}

/** 开文件并落保存点（模拟 EditorPane 首开后 setBaseline(当前版本)——1037 行既有动作） */
async function openClean(h: Harness, path: string) {
  const entry = await h.pool.acquire(h.kernel, path);
  h.pool.setBaseline(path, entry.model.getAlternativeVersionId());
  return entry;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('对外语义红线（冷档对外完全不可见）', () => {
  it('release 返回值随剩余引用递减；归零返回 0 不变（调用方终局清理口径不动）', async () => {
    const h = harness({ 'a.erb': 'A' });
    await h.pool.acquire(h.kernel, 'a.erb');
    await h.pool.acquire(h.kernel, 'a.erb');
    expect(h.pool.release('a.erb')).toBe(1);
    expect(h.pool.release('a.erb')).toBe(0); // 转冷档，但对外返回值一行不变
    expect(h.pool.refCount('a.erb')).toBe(0);
    expect(h.pool.release('a.erb')).toBe(0); // 幂等口径不变
  });

  it('并发 acquire 共担 loading：先 release 的拿到 1（pending 语义不变），最后归零', async () => {
    const h = harness({ 'c.erb': 'C' });
    const [e1, e2] = await Promise.all([
      h.pool.acquire(h.kernel, 'c.erb'),
      h.pool.acquire(h.kernel, 'c.erb'),
    ]);
    expect(e1).toBe(e2); // 共担同一 loading ⇒ 同一 entry（幂等）
    expect(h.pool.release('c.erb')).toBe(1);
    expect(h.pool.release('c.erb')).toBe(0);
  });

  it('读盘失败 ⇒ 记录回收不悬挂；下次 acquire 重来（改前口径）', async () => {
    const h = harness({});
    await expect(h.pool.acquire(h.kernel, 'ghost.erb')).rejects.toThrow('ENOENT');
    expect(h.pool.refCount('ghost.erb')).toBe(0);
    h.disk['ghost.erb'] = '后来有了';
    const entry = await h.pool.acquire(h.kernel, 'ghost.erb');
    expect(entry.model.getValue()).toBe('后来有了');
    expect(h.readCalls).toHaveLength(2); // 失败一次 + 重来一次
  });

  it('baseline / savedBase / setSavedBase 的既有口径零回退（冷档件的基线照常服务三方合并）', async () => {
    const h = harness({ 'b.erb': '盘上原文' });
    await openClean(h, 'b.erb');
    expect(h.pool.savedBase('b.erb')).toBe('盘上原文');
    expect(h.pool.release('b.erb')).toBe(0);
    expect(h.pool.baseline('b.erb')).toBeDefined(); // 转冷档 ⇒ 记录还在，基线不丢
    expect(h.pool.savedBase('b.erb')).toBe('盘上原文'); // 三方合并的 base 照常可用
    h.pool.setSavedBase('b.erb', '新基线');
    expect(h.pool.savedBase('b.erb')).toBe('新基线');
  });
});

describe('保守缺省链（三注入缺一 ⇒ 冷档禁用 = 改前行为）', () => {
  const baseDeps = (h: { models: MockModel[] }): PoolDeps => ({
    readText: async (_k: Kernel, path: string) => ({ text: `盘:${path}`, encoding: 'utf-8', eol: 'LF' }),
    createModel: (path: string, text: string) => {
      const m = new MockModel(path, text);
      h.models.push(m);
      return m as unknown as ITextModel;
    },
  });

  it('不注入任何 PS-12 探针 ⇒ release 归零即 dispose（旧调用方零回退）', async () => {
    const state = { models: [] as MockModel[] };
    const pool = createEditorModelPool(baseDeps(state));
    const kernel = {} as Kernel; // 无 bus（纯逻辑调用方）
    const entry = await pool.acquire(kernel, 'x.erb');
    pool.setBaseline('x.erb', entry.model.getAlternativeVersionId());
    expect(pool.release('x.erb')).toBe(0);
    expect(state.models[0]!.disposed).toBe(true); // 归零即死，不进冷档
    expect(pool.stats().coldModels).toBe(0);
  });

  it('注入了 modelVersion 但缺 writeText（补写盘通道不在）⇒ 仍禁用', async () => {
    const state = { models: [] as MockModel[] };
    const pool = createEditorModelPool({
      ...baseDeps(state),
      modelVersion: (m) => m.getAlternativeVersionId(),
      modelUnits: (m) => m.getValueLength(),
    });
    const kernel = { bus: fakeBus() } as unknown as Kernel;
    const entry = await pool.acquire(kernel, 'x.erb');
    pool.setBaseline('x.erb', entry.model.getAlternativeVersionId());
    pool.release('x.erb');
    expect(state.models[0]!.disposed).toBe(true);
  });

  it('全注入但 kernel 无 bus（盘变不可弃档）⇒ 仍禁用', async () => {
    const state = { models: [] as MockModel[] };
    const pool = createEditorModelPool({
      ...baseDeps(state),
      modelVersion: (m) => m.getAlternativeVersionId(),
      modelUnits: (m) => m.getValueLength(),
      writeText: async () => {},
    });
    const kernel = {} as Kernel; // 没有 bus：file.changed 订阅挂不上
    const entry = await pool.acquire(kernel, 'x.erb');
    pool.setBaseline('x.erb', entry.model.getAlternativeVersionId());
    pool.release('x.erb');
    expect(state.models[0]!.disposed).toBe(true);
  });
});

describe('冷档基本形状', () => {
  it('干净件关标签 ⇒ model 不 dispose、再 acquire 同一实例且零读盘', async () => {
    const h = harness({ 'a.erb': '第一份' });
    const first = await openClean(h, 'a.erb');
    expect(h.pool.release('a.erb')).toBe(0);
    expect((first.model as unknown as MockModel).disposed).toBe(false); // 冷档驻留
    expect(h.pool.stats().coldModels).toBe(1);
    expect(h.readCalls).toHaveLength(1);
    const second = await h.pool.acquire(h.kernel, 'a.erb'); // 冷档复活
    expect(second).toBe(first); // 同一份 model（tokenization 缓存保住的正是它）
    expect(second.model.getAlternativeVersionId()).toBe(first.model.getAlternativeVersionId());
    expect(h.readCalls).toHaveLength(1); // 零读盘
    expect(h.pool.stats()).toMatchObject({ activeModels: 1, coldModels: 0 });
  });

  it('脏件（编辑后未保存）⇒ 照旧立即 dispose——"关掉未保存标签 = 放弃"的预期零变化', async () => {
    const h = harness({ 'd.erb': '原稿' });
    const entry = await openClean(h, 'd.erb');
    (entry.model as unknown as MockModel).edit('未保存的修改');
    expect(h.pool.release('d.erb')).toBe(0);
    expect((entry.model as unknown as MockModel).disposed).toBe(true);
    expect(h.pool.stats().coldModels).toBe(0);
  });

  it('恢复件（baseline 钉 0、版本从 1 起数恒不等）⇒ 永不进冷档', async () => {
    const h = harness({});
    const entry = await h.pool.acquire(h.kernel, 'r.erb', { text: '恢复内容' });
    expect(entry.fromRecovery).toBe(true);
    expect(h.pool.baseline('r.erb')).toBe(0);
    expect(h.pool.release('r.erb')).toBe(0);
    expect((entry.model as unknown as MockModel).disposed).toBe(true);
  });

  it('多引用只认最后一份：refs 2→1 不动，1→0 才转冷档', async () => {
    const h = harness({ 'm.erb': '共享' });
    const e1 = await openClean(h, 'm.erb');
    const e2 = await h.pool.acquire(h.kernel, 'm.erb'); // 第二组
    expect(e2).toBe(e1);
    expect(h.pool.release('m.erb')).toBe(1);
    expect((e1.model as unknown as MockModel).disposed).toBe(false);
    expect(h.pool.stats().coldModels).toBe(0); // 还有一组引用，不进冷档
    expect(h.pool.release('m.erb')).toBe(0);
    expect((e1.model as unknown as MockModel).disposed).toBe(false); // 这下才进冷档
    expect(h.pool.stats().coldModels).toBe(1);
  });

  it('冷档复活后再关 ⇒ 回档且预算不重复记账', async () => {
    const h = harness({ 'l.erb': '轮转' });
    const first = await openClean(h, 'l.erb');
    h.pool.release('l.erb');
    await h.pool.acquire(h.kernel, 'l.erb');
    h.pool.release('l.erb');
    expect((first.model as unknown as MockModel).disposed).toBe(false);
    const s = h.pool.stats();
    expect(s.coldModels).toBe(1);
    expect(s.coldUnits).toBe('轮转'.length); // 不重复记账
  });
});

describe('冷档容量（数量 / 单份 / 全档预算）', () => {
  it(`超 ${COLD_CACHE_MAX_MODELS} 份 ⇒ 最旧冷却端先走，最新那份必在`, async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= COLD_CACHE_MAX_MODELS + 2; i++) files[`f${i}.erb`] = `第${i}份`;
    const h = harness(files);
    for (let i = 1; i <= COLD_CACHE_MAX_MODELS + 2; i++) await openClean(h, `f${i}.erb`);
    for (let i = 1; i <= COLD_CACHE_MAX_MODELS + 2; i++) h.pool.release(`f${i}.erb`);
    const st = h.pool.stats();
    expect(st.coldModels).toBe(COLD_CACHE_MAX_MODELS); // 钉在上限
    expect(st.coldUnits).toBeLessThanOrEqual(COLD_CACHE_BUDGET_UNITS);
    // 冷却序 = 转档序：最早冷却的 f1/f2 被驱逐
    expect((h.models[0] as unknown as MockModel).disposed).toBe(true);
    expect((h.models[1] as unknown as MockModel).disposed).toBe(true);
    expect((h.models[COLD_CACHE_MAX_MODELS + 1] as unknown as MockModel).disposed).toBe(false); // 最新必在
  });

  it(`单份超 ${COLD_CACHE_MAX_UNITS} 码元 ⇒ 不驻留（照 PS-5 单份上限口径）`, async () => {
    const huge = '字'.repeat(COLD_CACHE_MAX_UNITS + 1);
    const h = harness({ 'huge.erb': huge });
    const entry = await openClean(h, 'huge.erb');
    h.pool.release('huge.erb');
    expect((entry.model as unknown as MockModel).disposed).toBe(true);
  });

  it('全档预算超界 ⇒ 驱逐到放得下为止；驱逐件的 savedBase 同批归还', async () => {
    const per = Math.ceil((COLD_CACHE_BUDGET_UNITS + 1) / 3); // 3 份必顶穿 4 M 预算
    const files: Record<string, string> = {};
    for (let i = 1; i <= 4; i++) files[`g${i}.erb`] = '字'.repeat(per);
    const h = harness(files);
    for (let i = 1; i <= 4; i++) await openClean(h, `g${i}.erb`);
    for (let i = 1; i <= 4; i++) h.pool.release(`g${i}.erb`);
    const st = h.pool.stats();
    expect(st.coldUnits).toBeLessThanOrEqual(COLD_CACHE_BUDGET_UNITS);
    expect(st.coldModels).toBe(2); // 稳态：每份 ~1.33 M，两份即逼近 4 M，第 3 份挤掉最旧
    expect((h.models[0] as unknown as MockModel).disposed).toBe(true); // g1 最先进档也最先被挤
    expect((h.models[1] as unknown as MockModel).disposed).toBe(true); // g4 进档时挤掉 g2
    expect((h.models[3] as unknown as MockModel).disposed).toBe(false); // 最新必在
    expect(h.pool.savedBase('g1.erb')).toBeUndefined(); // 驱逐件的基线一并归还
  });
});

describe('安全闸②：冷档件被程序性改写 ⇒ 池补写盘', () => {
  it('替换执行器语义还原：改 model 不写盘的既有契约下，池代为落盘并推进基线', async () => {
    const h = harness({ 'p.erb': 'CALL A' });
    const entry = await openClean(h, 'p.erb');
    h.pool.release('p.erb'); // 进冷档
    (entry.model as unknown as MockModel).edit('CALL B'); // 模拟 replaceInModel：只改 model
    await flush(); // 补写盘的 then 续体
    expect(h.writeText).toHaveBeenCalledTimes(1);
    expect(h.disk['p.erb']).toBe('CALL B'); // 落盘了（= 改前"关着 ⇒ io 读改写"的净效果）
    expect(h.pool.baseline('p.erb')).toBe(entry.model.getAlternativeVersionId()); // 新版本成为基线
    expect(h.pool.savedBase('p.erb')).toBe('CALL B');
    // 复活后干净（重开不亮假脏标）且拿到替换后内容
    const again = await h.pool.acquire(h.kernel, 'p.erb');
    expect(again).toBe(entry);
    expect(again.model.getAlternativeVersionId()).toBe(h.pool.baseline('p.erb'));
    expect(h.readCalls).toHaveLength(1); // 全程零读盘
  });

  it('写盘失败 ⇒ 钉住不驱逐 + warn 可见 + 复活即脏标（内存是唯一真相，交用户处置）', async () => {
    const h = harness({ 'q.erb': 'Q' }, { writeFail: true });
    const entry = await openClean(h, 'q.erb');
    h.pool.release('q.erb');
    (entry.model as unknown as MockModel).edit('改了但写不进去');
    await flush();
    expect(h.warns.length).toBeGreaterThan(0);
    expect(h.warns[0]).toContain('q.erb'); // 铁律 4：不静默
    // 钉住件的驱逐豁免：把冷档塞满也赶不走它
    const files: Record<string, string> = {};
    for (let i = 1; i <= COLD_CACHE_MAX_MODELS + 4; i++) files[`n${i}.erb`] = `N${i}`;
    Object.assign(h.disk, files);
    for (let i = 1; i <= COLD_CACHE_MAX_MODELS + 4; i++) await openClean(h, `n${i}.erb`);
    for (let i = 1; i <= COLD_CACHE_MAX_MODELS + 4; i++) h.pool.release(`n${i}.erb`);
    expect((entry.model as unknown as MockModel).disposed).toBe(false); // 钉住了
    // 复活 ⇒ baseline 未推进 ⇒ 脏（用户看得见，保存/放弃由他定）
    const again = await h.pool.acquire(h.kernel, 'q.erb');
    expect(again.model.getAlternativeVersionId()).not.toBe(h.pool.baseline('q.erb'));
  });

  it('复活后（refs>0）池不接管：开着的世界归 EditorPane 契约（脏标 + 用户保存）', async () => {
    const h = harness({ 'o.erb': 'O' });
    const entry = await openClean(h, 'o.erb');
    h.pool.release('o.erb');
    await h.pool.acquire(h.kernel, 'o.erb'); // 复活（listener 空转保留）
    (entry.model as unknown as MockModel).edit('开着的编辑');
    await flush();
    expect(h.writeText).not.toHaveBeenCalled(); // 池不越权替用户写盘
    expect(h.disk['o.erb']).toBe('O');
  });
});

describe('安全闸③：file.changed ⇒ 冷档同路文件立即弃档', () => {
  it('盘面真相变了 ⇒ 弃档（model dispose + 基线销账），重开必读盘 = 改前行为', async () => {
    const h = harness({ 'w.erb': '旧盘面' });
    const entry = await openClean(h, 'w.erb');
    h.pool.release('w.erb');
    expect(h.pool.stats().coldModels).toBe(1);
    h.bus.emit({ kind: 'change', path: 'w.erb' });
    expect((entry.model as unknown as MockModel).disposed).toBe(true);
    expect(h.pool.savedBase('w.erb')).toBeUndefined(); // 销账
    expect(h.pool.stats().coldModels).toBe(0);
    h.disk['w.erb'] = '新盘面';
    const again = await h.pool.acquire(h.kernel, 'w.erb');
    expect(again).not.toBe(entry); // 弃档后重开 = 全新读盘
    expect(again.model.getValue()).toBe('新盘面');
    expect(h.readCalls).toHaveLength(2);
  });

  it('路径判等走 pathKey（file.changed 原样透传，别因写法差异漏弃）', async () => {
    const h = harness({});
    const path = 'C:/Game/ERB/x.ERB';
    h.disk[path] = 'X';
    const entry = await openClean(h, path);
    h.pool.release(path);
    expect(h.pool.stats().coldModels).toBe(1);
    // watcher 原样透传的可能是另一种写法（大小写 / 分隔符）
    h.bus.emit({ kind: 'unlink', path: 'c:\\game\\erb\\X.erb' });
    expect(h.pool.stats().coldModels).toBe(0);
    expect((entry.model as unknown as MockModel).disposed).toBe(true);
  });

  it('事件只打冷档面：开着的 / 已 dispose 的记录不受影响', async () => {
    const h = harness({ 'a.erb': 'A', 'b.erb': 'B' });
    await openClean(h, 'a.erb'); // 一直开着
    const b = await openClean(h, 'b.erb');
    h.pool.release('b.erb'); // b 进冷档
    h.bus.emit({ kind: 'change', path: 'b.erb' });
    expect(h.pool.refCount('a.erb')).toBe(1); // 开着的不动
    expect((b.model as unknown as MockModel).disposed).toBe(true); // 只有 b 弃档
  });
});

describe('观测面（stats / 超阈告警）', () => {
  it('三本账各态：空池全零；活动 / 冷档 / 基线互不串账', async () => {
    const h = harness({ 'a.erb': '一二三', 'b.erb': '四五六七' });
    expect(h.pool.stats()).toMatchObject({ activeModels: 0, activeUnits: 0, coldModels: 0, coldUnits: 0, savedBaseUnits: 0 });
    await openClean(h, 'a.erb');
    await openClean(h, 'b.erb');
    expect(h.pool.stats()).toMatchObject({
      activeModels: 2,
      activeUnits: 7, // '一二三'(3) + '四五六七'(4) 码元
      coldModels: 0,
      savedBaseUnits: 7, // PS-5 基线账（'一二三' + '四五六七'）
    });
    h.pool.release('a.erb');
    expect(h.pool.stats()).toMatchObject({
      activeModels: 1,
      activeUnits: 4,
      coldModels: 1,
      coldUnits: 3,
      savedBaseUnits: 7, // 冷档件的基线仍占着（三方合并的 base 随记录存续）
    });
  });

  it(`活动正文合计跨 ${ACTIVE_POOL_WARN_UNITS} 码元 ⇒ warn 一次；回落静默复位，再上行再报`, async () => {
    const big = 'x'.repeat(Math.ceil(ACTIVE_POOL_WARN_UNITS / 2) + 1); // 两份必破阈
    const h = harness({ 'a.erb': big, 'b.erb': big });
    expect(h.warns).toHaveLength(0);
    await openClean(h, 'a.erb');
    expect(h.warns).toHaveLength(0); // 未破阈不报
    await openClean(h, 'b.erb');
    expect(h.warns).toHaveLength(1); // 破阈上行：一次
    expect(h.warns[0]).toContain('码元');
    h.pool.release('b.erb'); // 回落（转冷档不占活动账）
    expect(h.warns).toHaveLength(1); // 回落静默
    await h.pool.acquire(h.kernel, 'b.erb');
    expect(h.warns).toHaveLength(2); // 再上行再报（去抖复位）
  });
});
/* ============================== PS-12-C：liveModel 只答活面 ============================== */

describe('liveModel（替换执行器的活面判定；不问 Monaco 注册表）', () => {
  it('refs>0 答那份 model；关掉转冷档 ⇒ undefined（冷档不是活面）；重开复活 ⇒ 又答得出', async () => {
    const h = harness({ 'a.erb': 'A' });
    const e = await openClean(h, 'a.erb');
    expect(h.pool.liveModel('a.erb')).toBe(e.model); // 活面：开着的标签
    h.pool.release('a.erb');
    expect(h.pool.liveModel('a.erb')).toBeUndefined(); // 冷档：refs=0 ⇒ 不是活面（PS-12-C 的全部意义）
    const revived = await h.pool.acquire(h.kernel, 'a.erb');
    expect(h.pool.liveModel('a.erb')).toBe(revived.model); // 冷档复活成活面，又答得出
    expect(revived.model).toBe(e.model); // 复活的是同一份（冷档保 tokenization 的成果）
    h.pool.release('a.erb');
  });

  it('不在池 ⇒ undefined；pathKey 口径：另一种盘符写法也命中活面', async () => {
    const h = harness({ 'C:/p/ERB/a.ERB': 'A', 'b.erb': 'B' });
    expect(h.pool.liveModel('nope.erb')).toBeUndefined();
    const e = await openClean(h, 'C:/p/ERB/a.ERB');
    // 与替换执行器 pickModelByPathKey 同一条 pathKey：大小写 / 分隔符不同写法是同一份正文
    expect(h.pool.liveModel('c:\\p\\erb\\a.erb')).toBe(e.model);
    h.pool.release('C:/p/ERB/a.ERB');
    expect(h.pool.liveModel('c:\\p\\erb\\a.erb')).toBeUndefined();
  });
});