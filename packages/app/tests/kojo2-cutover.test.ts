/**
 * K2-CUTOVER-PRE · 切换前夜的判据闸（状态机 / 路由 / 迁移预览 / 持久化）。
 *
 * 判据口径：
 * 1. **状态机**：`v1-only → dual → 2.0-default` 每一步都能回退，到顶/到底都是 no-op 而不是抛；
 *    订阅只在真变化时触发（no-op 不许通知）。
 * 2. **路由**：override 当家、扩展名先说、阶段定老文件、内容只在 2.0-default 里断 `.kojo`；
 *    判不出来时报 `ambiguous` 并给唯一兜底，**看路径不许猜**。
 * 3. **迁移预览**：对真实 v1 片段给出 core 迁移器的改动计数与阻断台账，且**没有写盘通路**。
 * 4. **持久化**：只经注入的 storage（假 localStorage），坏值一律回缺省；全局 `localStorage`
 *    一次都不读——"注入不污染全局"是断言，不是口头承诺。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import { KOJO2_SOURCE_EXTENSION } from '../src/monaco/kojo2-language';
import {
  KOJO2_ANCHOR_MARKS,
  KOJO2_CUTOVER_DEFAULT_STAGE,
  KOJO2_CUTOVER_STAGES,
  KOJO2_CUTOVER_STORAGE_KEY,
  KOJO2_FILE_EXTENSION,
  KOJO2_STAGE_LABELS,
  KOJO_V1_FILE_EXTENSION,
  createKojo2CutoverController,
  decideKojo2Route,
  extensionOf,
  fingerprintKojo2Source,
  getKojo2CutoverController,
  isKojo2CutoverStage,
  normalizePathKey,
  previewKojo2Migration,
  resetKojo2CutoverController,
  type Kojo2CutoverStage,
  type Kojo2CutoverStorage,
  type Kojo2RouteDecision,
} from '../src/ui/kojo2-cutover';

/* ============================== 假 storage ============================== */

/** 注入式假 localStorage：只实现本模块允许的三格，另记调用账（断言"写了几次 / 删没删"）。 */
class MemoryStorage implements Kojo2CutoverStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  removals = 0;
  reads = 0;
  throwOnWrite = false;

  getItem(key: string): string | null {
    this.reads += 1;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    if (this.throwOnWrite) throw new Error('QuotaExceededError');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removals += 1;
    this.values.delete(key);
  }

  /** 落盘文档（解析失败 = null，供断言坏数据分支） */
  document(): Record<string, unknown> | null {
    const raw = this.values.get(KOJO2_CUTOVER_STORAGE_KEY);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKojo2CutoverController();
});

/* ============================== 夹具 ============================== */

/** 真实 v1 片段：文件头 + 时机块 + 裸台词（迁移器会给台词补说话人） */
const V1_BASIC = '角色: 灵梦\n时机 指令 310：\n    「你好。」\n';
/** 上面那份的 2.0 结果（逐字节；迁移器口径已由 `kojo2-migrate-model.test.ts` 钉住） */
const V1_BASIC_MIGRATED = '# 机 指令 310\n灵梦：「「你好。」」\n';
/** 已是 2.0 写法（幂等） */
const KOJO2_SAMPLE = '# 机 指令 310\n灵梦：「你好。」\n';
/** `分支：` 不可机械迁移：整块原样保留 + `ok=false` */
const V1_BRANCH = '角色: 灵梦\n分支：\n    如果 恋慕 >= 500：\n        「你来了。」\n';
/** `初回 / 询问 / 确认` 2.0 暂无对应 */
const V1_ASK = '角色: 灵梦\n初回：\n    「初次见面。」\n';

const KOJO_FILE = 'C:\\proj\\chara\\M.kojo';
const KOJO2_FILE = 'C:\\proj\\chara\\M.kojo2';

function route(
  stage: Kojo2CutoverStage,
  filePath: string,
  source?: string,
  override?: 'kojo-v1' | 'kojo2',
): Kojo2RouteDecision {
  return decideKojo2Route({
    stage,
    filePath,
    ...(source === undefined ? {} : { source }),
    ...(override === undefined ? {} : { override }),
  });
}

/* ============================== 状态机 ============================== */

describe('阶段状态机：三档、逐步前进、每步可退', () => {
  it('缺省 v1-only（切不动比切错便宜），序与标签表完整', () => {
    const cutover = createKojo2CutoverController();
    expect(cutover.getStage()).toBe(KOJO2_CUTOVER_DEFAULT_STAGE);
    expect(KOJO2_CUTOVER_DEFAULT_STAGE).toBe('v1-only');
    expect(cutover.getSnapshot()).toMatchObject({
      stage: 'v1-only',
      persisted: false,
      overrides: [],
    });
    expect(KOJO2_CUTOVER_STAGES).toEqual(['v1-only', 'dual', '2.0-default']);
    for (const stage of KOJO2_CUTOVER_STAGES) {
      expect(KOJO2_STAGE_LABELS[stage].length).toBeGreaterThan(0);
      expect(isKojo2CutoverStage(stage)).toBe(true);
    }
    expect(isKojo2CutoverStage('2.0')).toBe(false);
    expect(isKojo2CutoverStage(null)).toBe(false);
    expect(KOJO2_ANCHOR_MARKS).toEqual(['#', '@', '>', '?', '!']);
  });

  it('advance 逐档前进，到顶是 no-op（不抛、不通知）', () => {
    const cutover = createKojo2CutoverController();
    const seen: Kojo2CutoverStage[] = [];
    cutover.subscribe((snapshot) => seen.push(snapshot.stage));

    expect(cutover.canAdvance()).toBe(true);
    expect(cutover.advance()).toBe('dual');
    expect(cutover.advance()).toBe('2.0-default');
    expect(cutover.canAdvance()).toBe(false);
    expect(cutover.advance()).toBe('2.0-default');
    expect(cutover.advance()).toBe('2.0-default');
    expect(seen).toEqual(['dual', '2.0-default']);
  });

  it('rollback 逐档回退，到底也是 no-op；状态机可从任意档退回 v1-only', () => {
    const cutover = createKojo2CutoverController({ stage: '2.0-default' });
    expect(cutover.canRollback()).toBe(true);
    expect(cutover.rollback()).toBe('dual');
    expect(cutover.rollback()).toBe('v1-only');
    expect(cutover.canRollback()).toBe(false);
    expect(cutover.rollback()).toBe('v1-only');

    cutover.advance();
    cutover.advance();
    expect(cutover.rollbackTo('v1-only')).toBe('v1-only');
    // 只回退不前进：目标是"更晚"的档 = 不动
    expect(cutover.rollbackTo('2.0-default')).toBe('v1-only');
  });

  it('setStage 是任意方向的逃生门；未知档位一律不动', () => {
    const cutover = createKojo2CutoverController();
    expect(cutover.setStage('2.0-default')).toBe('2.0-default');
    expect(cutover.setStage('v1-only')).toBe('v1-only');
    expect(cutover.setStage('nope' as Kojo2CutoverStage)).toBe('v1-only');
    expect(cutover.setStage('2.0-default')).toBe('2.0-default');
  });

  it('构造参数里的脏阶段回缺省（运行期不信任外部值）', () => {
    expect(createKojo2CutoverController({ stage: 'nope' as Kojo2CutoverStage }).getStage()).toBe(
      'v1-only',
    );
    expect(createKojo2CutoverController({ stage: 'dual' }).getStage()).toBe('dual');
  });

  it('订阅：真变化才通知；取消订阅后不再收；订阅者拿到快照副本', () => {
    const cutover = createKojo2CutoverController();
    const stages: Kojo2CutoverStage[] = [];
    const persisted: boolean[] = [];
    const off = cutover.subscribe((snapshot) => {
      stages.push(snapshot.stage);
      persisted.push(snapshot.persisted);
    });
    cutover.advance();
    cutover.setStage('dual'); // no-op
    cutover.rollback();
    off();
    cutover.advance();
    expect(stages).toEqual(['dual', 'v1-only']);
    expect(persisted).toEqual([false, false]);
  });
});

/* ============================== 持久化 ============================== */

describe('持久化：注入 storage、坏值回缺省、绝不碰全局', () => {
  it('阶段与 per-file override 都落进注入的 storage（同一个键、同一份文档）', () => {
    const storage = new MemoryStorage();
    const cutover = createKojo2CutoverController({ storage });
    cutover.advance();
    cutover.setOverride(KOJO_FILE, 'kojo2');
    expect(storage.document()).toEqual({
      version: 1,
      stage: 'dual',
      overrides: { 'C:/proj/chara/M.kojo': 'kojo2' },
    });
    expect(cutover.getSnapshot().persisted).toBe(true);

    // "重启"：同一份 storage 造新控制器，盘上为准
    const restarted = createKojo2CutoverController({ storage, stage: 'v1-only' });
    expect(restarted.getStage()).toBe('dual');
    expect(restarted.getOverride('C:/proj/chara/M.kojo')).toBe('kojo2');
  });

  it('坏 JSON / 坏版本 / 坏阶段 / 坏 override 值：一律回缺省，不抛', () => {
    const cases: string[] = [
      'not json',
      JSON.stringify({ version: 2, stage: 'dual', overrides: {} }),
      JSON.stringify({ version: 1, stage: '2.0', overrides: {} }),
      JSON.stringify(null),
    ];
    for (const raw of cases) {
      const storage = new MemoryStorage();
      storage.values.set(KOJO2_CUTOVER_STORAGE_KEY, raw);
      const cutover = createKojo2CutoverController({ storage });
      expect(cutover.getStage(), raw).toBe('v1-only');
      expect(cutover.getSnapshot().overrides, raw).toEqual([]);
    }
    // 坏 override 值只丢那一格，合法阶段保留
    const storage = new MemoryStorage();
    storage.values.set(
      KOJO2_CUTOVER_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        stage: '2.0-default',
        overrides: { 'C:/a.kojo': 'v2', 'C:/b.kojo': 'kojo2' },
      }),
    );
    const cutover = createKojo2CutoverController({ storage });
    expect(cutover.getStage()).toBe('2.0-default');
    expect(cutover.getOverride('C:/a.kojo')).toBeNull();
    expect(cutover.getOverride('C:/b.kojo')).toBe('kojo2');
  });

  it('写失败：内存状态照常生效，快照露出 persisted=false；恢复后自动回到 true', () => {
    const storage = new MemoryStorage();
    const cutover = createKojo2CutoverController({ storage });
    storage.throwOnWrite = true;
    expect(cutover.advance()).toBe('dual');
    expect(cutover.getSnapshot().persisted).toBe(false);
    storage.throwOnWrite = false;
    cutover.advance();
    expect(cutover.getSnapshot().persisted).toBe(true);
    expect(storage.document()).toMatchObject({ stage: '2.0-default' });
  });

  it('attachStorage 采纳盘上计划；盘上没有就把当前状态写下去；detach 后不再落盘', () => {
    const storage = new MemoryStorage();
    const seeded = createKojo2CutoverController({ storage });
    seeded.advance();
    seeded.advance();
    seeded.setOverride(KOJO2_FILE, 'kojo-v1');

    const cutover = createKojo2CutoverController({ stage: 'v1-only' });
    cutover.attachStorage(storage);
    expect(cutover.getStage()).toBe('2.0-default');
    expect(cutover.getOverride(KOJO2_FILE)).toBe('kojo-v1');
    expect(cutover.getSnapshot().persisted).toBe(true);

    const empty = new MemoryStorage();
    const fresh = createKojo2CutoverController({ stage: 'dual' });
    fresh.attachStorage(empty);
    expect(empty.document()).toMatchObject({ stage: 'dual' });

    fresh.detachStorage();
    fresh.advance();
    expect(fresh.getSnapshot().persisted).toBe(false);
    expect(empty.document()).toMatchObject({ stage: 'dual' }); // 没被改写
  });

  it('reset：回缺省 + 清 override + 删存储键（留一个干净盘）', () => {
    const storage = new MemoryStorage();
    const cutover = createKojo2CutoverController({ storage });
    cutover.advance();
    cutover.setOverride(KOJO_FILE, 'kojo2');
    cutover.reset();
    expect(cutover.getStage()).toBe('v1-only');
    expect(cutover.getSnapshot().overrides).toEqual([]);
    expect(storage.removals).toBe(1);
    expect(storage.values.has(KOJO2_CUTOVER_STORAGE_KEY)).toBe(false);
  });

  it('注入 storage 就够：模块一次都不读全局 localStorage', () => {
    const globalTouch = vi.fn(() => {
      throw new Error('本模块不该碰全局 localStorage');
    });
    vi.stubGlobal('localStorage', {
      getItem: globalTouch,
      setItem: globalTouch,
      removeItem: globalTouch,
    });
    const storage = new MemoryStorage();
    const cutover = createKojo2CutoverController({ storage });
    cutover.advance();
    cutover.setOverride(KOJO_FILE, 'kojo2');
    cutover.route({ filePath: KOJO_FILE });
    cutover.reset();
    expect(globalTouch).not.toHaveBeenCalled();
    expect(storage.writes).toBeGreaterThan(0);
  });

  it('进程级单例：get 幂等、reset 后重建（旧实例不再共享）', () => {
    resetKojo2CutoverController();
    const first = getKojo2CutoverController();
    expect(getKojo2CutoverController()).toBe(first);
    first.setStage('dual');
    expect(getKojo2CutoverController().getStage()).toBe('dual');
    resetKojo2CutoverController();
    const second = getKojo2CutoverController();
    expect(second).not.toBe(first);
    expect(second.getStage()).toBe('v1-only');
  });

  it('路径键归一：斜杠统一、折叠重复、UNC 保留、大小写兜底匹配', () => {
    expect(normalizePathKey('C:\\proj\\a.kojo')).toBe('C:/proj/a.kojo');
    expect(normalizePathKey('C://proj///a.kojo')).toBe('C:/proj/a.kojo');
    expect(normalizePathKey('C:/proj/a.kojo/')).toBe('C:/proj/a.kojo');
    expect(normalizePathKey('\\\\server\\share\\a.kojo')).toBe('//server/share/a.kojo');

    const cutover = createKojo2CutoverController();
    cutover.setOverride('C:\\proj\\a.kojo', 'kojo2');
    expect(cutover.getOverride('c:/PROJ/a.kojo')).toBe('kojo2');
    cutover.clearOverride('c:/proj/A.kojo');
    expect(cutover.getOverride('C:/proj/a.kojo')).toBeNull();
  });
});

/* ============================== 路由 ============================== */

describe('文件路由：override 当家，扩展名先说，阶段定老文件', () => {
  it('v1-only：`.kojo` 按 v1；`.kojo2` 显式 blocked（2.0 面还没挂，绝不拿 v1 词法硬啃）', () => {
    expect(route('v1-only', KOJO_FILE, KOJO2_SAMPLE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'stage-v1-only',
      fingerprint: null,
    });
    const blocked = route('v1-only', KOJO2_FILE);
    expect(blocked).toMatchObject({ kind: 'blocked', reason: 'stage-disables-kojo2' });
    expect(blocked.kind === 'blocked' ? blocked.hint : '').toContain('v1-only');
  });

  it('dual：老文件仍按 v1（内容像 2.0 也不动它），新文件按 2.0', () => {
    expect(route('dual', KOJO_FILE, KOJO2_SAMPLE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'stage-dual',
    });
    expect(route('dual', KOJO2_FILE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'extension-kojo2',
    });
  });

  it('2.0-default：`.kojo2` 恒 2.0；`.kojo` 只在有正文时才判', () => {
    expect(route('2.0-default', KOJO2_FILE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'extension-kojo2',
    });
    expect(route('2.0-default', KOJO_FILE)).toMatchObject({
      kind: 'needs-content',
      reason: 'content-required',
    });
    expect(route('2.0-default', KOJO_FILE, KOJO2_SAMPLE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'content-kojo2',
    });
    expect(route('2.0-default', KOJO_FILE, V1_BASIC)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'content-v1',
    });
    expect(route('2.0-default', KOJO_FILE, '')).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'content-empty',
    });
  });

  it('内容判不出来 = ambiguous + 唯一兜底 kojo-v1（不静默猜）', () => {
    const dialogueOnly = route('2.0-default', KOJO_FILE, '灵梦：「你好。」\n');
    expect(dialogueOnly).toMatchObject({
      kind: 'ambiguous',
      fallback: 'kojo-v1',
      fingerprint: { lineCount: 1, anchorLines: 0, kojo2Lines: 1, v1Lines: 0, flavor: 'ambiguous' },
    });
    expect(dialogueOnly.kind === 'ambiguous' ? dialogueOnly.hint : '').toContain('override');

    const mixed = route(
      '2.0-default',
      KOJO_FILE,
      '# 机 指令 310\n灵梦：「你好。」\n角色: 灵梦\n? 恋慕 >= 500\n    如果 恋慕：\n',
    );
    expect(mixed).toMatchObject({ kind: 'ambiguous', fallback: 'kojo-v1' });
  });

  it('扩展名常量与语言层 / 契约层的单一真源逐字相等（本模块不另造口径）', () => {
    // 本模块不 import monaco 语言面（零 Monaco 依赖），字面量因此有一份，但由这条断言钉住：
    // 谁改 `.kojo2` / `.kojo`，这里先红。
    expect(KOJO2_FILE_EXTENSION).toBe(KOJO2_SOURCE_EXTENSION);
    expect(KOJO_V1_FILE_EXTENSION).toBe(KOJO_SOURCE_EXTENSION);
  });

  it('扩展名：大小写不敏感；`.kojo.bak` / `.txt` / 无扩展名一律 not-kojo', () => {    expect(route('dual', 'C:/p/A.KOJO2')).toMatchObject({ kind: 'resolved', parser: 'kojo2' });
    expect(route('v1-only', 'C:/p/A.KOJO')).toMatchObject({ kind: 'resolved', parser: 'kojo-v1' });
    for (const path of ['C:/p/a.kojo.bak', 'C:/p/readme.txt', 'C:/p/noext', 'C:/p/']) {
      const decision = route('dual', path);
      expect(decision.kind, path).toBe('not-kojo');
      if (decision.kind === 'not-kojo') {
        expect(decision.extension, path).not.toBe('.kojo');
        expect(decision.extension, path).not.toBe('.kojo2');
      }
    }
    const bak = route('dual', 'C:/p/a.kojo.bak');
    expect(bak.kind === 'not-kojo' ? bak.extension : '').toBe('.bak');
    expect(extensionOf('C:\\p\\x.KOJO2')).toBe('.kojo2');
    expect(extensionOf('C:/p/.kojo')).toBe('');
  });

  it('per-file override 破例：`.kojo` 可钉 2.0，`.kojo2` 可钉回 v1；v1-only 下 2.0 钉不住', () => {
    expect(route('dual', KOJO_FILE, undefined, 'kojo2')).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'override',
    });
    expect(route('2.0-default', KOJO2_FILE, undefined, 'kojo-v1')).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'override',
    });
    expect(route('v1-only', KOJO2_FILE, undefined, 'kojo2')).toMatchObject({
      kind: 'blocked',
      reason: 'stage-disables-kojo2',
    });
  });

  it('controller 路由：存好的 override 参与，一次性 override 更优先，clear 后复原', () => {
    const cutover = createKojo2CutoverController({ stage: 'dual' });
    expect(cutover.route({ filePath: KOJO_FILE, source: KOJO2_SAMPLE })).toMatchObject({
      parser: 'kojo-v1',
      reason: 'stage-dual',
    });
    cutover.setOverride(KOJO_FILE, 'kojo2');
    expect(cutover.route({ filePath: KOJO_FILE })).toMatchObject({
      parser: 'kojo2',
      reason: 'override',
    });
    expect(cutover.route({ filePath: KOJO_FILE, override: 'kojo-v1' })).toMatchObject({
      parser: 'kojo-v1',
      reason: 'override',
    });
    expect(cutover.route({ filePath: KOJO_FILE, override: null })).toMatchObject({
      parser: 'kojo2',
      reason: 'override',
    });
    cutover.clearOverride(KOJO_FILE);
    expect(cutover.route({ filePath: KOJO_FILE })).toMatchObject({ reason: 'stage-dual' });
  });

  it('controller 路由随阶段走：同一份 `.kojo` 在三个档里给出三种结论', () => {
    const cutover = createKojo2CutoverController();
    expect(cutover.route({ filePath: KOJO_FILE })).toMatchObject({ parser: 'kojo-v1' });
    cutover.setStage('dual');
    expect(cutover.route({ filePath: KOJO_FILE })).toMatchObject({ parser: 'kojo-v1' });
    cutover.setStage('2.0-default');
    expect(cutover.route({ filePath: KOJO_FILE })).toMatchObject({ kind: 'needs-content' });
    expect(cutover.route({ filePath: KOJO_FILE, source: KOJO2_SAMPLE })).toMatchObject({
      parser: 'kojo2',
    });
  });
});

/* ============================== 内容指纹 ============================== */

describe('内容指纹：锚点是骨架证据，2.0 词法才是判据', () => {
  it('2.0 样本：全过词法 + 有锚点 = kojo2', () => {
    expect(fingerprintKojo2Source(KOJO2_SAMPLE)).toEqual({
      lineCount: 2,
      anchorLines: 1,
      kojo2Lines: 2,
      v1Lines: 0,
      v1Samples: [],
      flavor: 'kojo2',
    });
  });

  it('v1 样本：反例带 1 基行号（作者面直接引用）', () => {
    const fp = fingerprintKojo2Source(V1_BASIC);
    expect(fp).toMatchObject({ lineCount: 3, anchorLines: 0, kojo2Lines: 0, v1Lines: 3, flavor: 'v1' });
    expect(fp.v1Samples).toEqual([
      { line: 1, text: '角色: 灵梦' },
      { line: 2, text: '时机 指令 310：' },
      { line: 3, text: '「你好。」' },
    ]);
  });

  it('`#DIM X` 有 `#` 但过不了 2.0 词法：锚点计数不算数，仍判 v1', () => {
    const fp = fingerprintKojo2Source('#DIM X, 1\n@HOME\n');
    expect(fp).toMatchObject({ anchorLines: 2, kojo2Lines: 0, v1Lines: 2, flavor: 'v1' });
  });

  it('混排：2.0 占多数 = ambiguous；v1 占多数 = v1', () => {
    const kojo2Majority = fingerprintKojo2Source(
      '# 机 指令 310\n灵梦：「你好。」\n? 恋慕 >= 500\n角色: 灵梦\n    如果 恋慕：\n',
    );
    expect(kojo2Majority).toMatchObject({ anchorLines: 2, kojo2Lines: 3, v1Lines: 2, flavor: 'ambiguous' });
    const v1Majority = fingerprintKojo2Source('# 机 指令 310\n角色: 灵梦\n时机 指令 310：\n');
    expect(v1Majority).toMatchObject({ anchorLines: 1, kojo2Lines: 1, v1Lines: 2, flavor: 'v1' });
  });

  it('空文件 / 纯注释 / CRLF 与缩进：口径与迁移引擎同（空行不计、行首空白剥掉）', () => {
    expect(fingerprintKojo2Source('').flavor).toBe('empty');
    expect(fingerprintKojo2Source('   \n\t\n').flavor).toBe('empty');
    expect(fingerprintKojo2Source('// 注\n').flavor).toBe('ambiguous');
    const crlf = fingerprintKojo2Source('# 机 指令 310\r\n    灵梦：「你好。」\r\n');
    expect(crlf).toMatchObject({ lineCount: 2, anchorLines: 1, kojo2Lines: 2, flavor: 'kojo2' });
  });
});

/* ============================== 迁移预览 ============================== */

describe('迁移预览：core 分类 + 改写 + diff 摘要，且没有写盘通路', () => {
  it('正例：改动行数 / 增删行 / 结果文本 / diff 头全部可对上', () => {
    const preview = previewKojo2Migration({ filePath: KOJO_FILE, source: V1_BASIC });
    expect(preview).toMatchObject({
      filePath: KOJO_FILE,
      ok: true,
      changed: true,
      changedLineCount: 3,
      addedLineCount: 2,
      removedLineCount: 3,
      newLineCount: 2,
      warningCount: 0,
      errorCount: 0,
      firstBlockedLine: null,
      blockers: [],
    });
    expect(preview.code).toBe(V1_BASIC_MIGRATED);
    expect(preview.diffText).toContain(`--- a/${KOJO_FILE}`);
    expect(preview.diffText).toContain(`+++ b/${KOJO_FILE}`);
    expect(preview.diffText).toContain('+# 机 指令 310');
    expect(preview.diffText).toContain('+灵梦：「「你好。」」');
    expect(preview.diffText).toContain('-角色: 灵梦');
    // diff 摘要与计数同源：removed 条数 = 被改写的旧行数
    expect(preview.diff.filter((line) => line.kind === 'removed')).toHaveLength(3);
    expect(preview.diff.filter((line) => line.kind === 'added')).toHaveLength(2);
  });

  it('已是 2.0：幂等（changed=false、零改动、无阻断）', () => {
    const preview = previewKojo2Migration({ filePath: KOJO2_FILE, source: KOJO2_SAMPLE });
    expect(preview).toMatchObject({
      ok: true,
      changed: false,
      changedLineCount: 0,
      addedLineCount: 0,
      removedLineCount: 0,
      newLineCount: 2,
      blockers: [],
    });
    expect(preview.code).toBe(KOJO2_SAMPLE);
  });

  it('不可迁移：`分支：` 整块原样保留、ok=false、台账带行号与目标提示', () => {
    const preview = previewKojo2Migration({ filePath: KOJO_FILE, source: V1_BRANCH });
    expect(preview.ok).toBe(false);
    expect(preview.changed).toBe(true);
    expect(preview.firstBlockedLine).toBe(2);
    expect(preview.blockers).toHaveLength(1);
    expect(preview.blockers[0]).toMatchObject({
      line: 2,
      code: 'core/migration/branch',
      sourceLine: '分支：',
    });
    expect(preview.blockers[0]?.targetHint).toContain('?');
    // 不可迁移块逐字节留在结果里（不是半成品）
    expect(preview.code).toContain('分支：\n    如果 恋慕 >= 500：\n        「你来了。」\n');
    expect(preview.changedLineCount).toBe(1); // 只丢了文件头那一行
  });

  it('`初回：` 报 ask 阻断；裸台词缺说话人报 bare-quote，给 speaker 就通了', () => {
    const ask = previewKojo2Migration({ filePath: KOJO_FILE, source: V1_ASK });
    expect(ask.ok).toBe(false);
    expect(ask.blockers[0]).toMatchObject({ line: 2, code: 'core/migration/ask', sourceLine: '初回：' });

    const bare = previewKojo2Migration({ filePath: KOJO_FILE, source: '「你好。」\n' });
    expect(bare.ok).toBe(false);
    expect(bare.blockers[0]).toMatchObject({
      line: 1,
      code: 'core/narrative/bare-quote',
      sourceLine: '「你好。」',
    });

    const withSpeaker = previewKojo2Migration({
      filePath: KOJO_FILE,
      source: '「你好。」\n',
      speaker: '灵梦',
    });
    expect(withSpeaker.ok).toBe(true);
    expect(withSpeaker.code).toBe('灵梦：「「你好。」」\n');
    expect(withSpeaker.changedLineCount).toBe(1);
  });

  it('EOL 保留：CRLF 文件迁移后仍是 CRLF（预览不改写源事实）', () => {
    const crlf = V1_BASIC.replace(/\n/g, '\r\n');
    const preview = previewKojo2Migration({ filePath: KOJO_FILE, source: crlf });
    expect(preview.ok).toBe(true);
    expect(preview.code).toBe(V1_BASIC_MIGRATED.replace(/\n/g, '\r\n'));
  });

  it('警告与文件头元数据：可迁移但需复核的、会搬离脚本的，都在预览里', () => {
    const versioned = previewKojo2Migration({
      filePath: KOJO_FILE,
      source: '角色: 灵梦\n# 版本 1.0\n时机 指令 310：\n    「你好。」\n',
    });
    expect(versioned.ok).toBe(true);
    expect(versioned.warningCount).toBe(1);
    expect(versioned.warnings[0]).toMatchObject({ code: 'core/migration/version', line: 2 });

    const basic = previewKojo2Migration({ filePath: KOJO_FILE, source: V1_BASIC });
    expect(basic.metadata.chara).toBe('灵梦');
    // `角色:` 同时进 headLines 台账（哪些行会离开脚本，作者一眼看全）
    expect(basic.metadata.headLines).toEqual([{ word: '角色', value: '灵梦', line: 1, body: [] }]);
    expect(basic.warnings).toEqual([]);
  });

  it('纯函数：同参两次逐字段相等，且不做任何写盘副作用', async () => {
    const first = previewKojo2Migration({ filePath: KOJO_FILE, source: V1_BASIC });
    const second = previewKojo2Migration({ filePath: KOJO_FILE, source: V1_BASIC });
    expect(second).toEqual(first);
    // 没有第二套 IO：本模块不 import kernel / tauri 的写盘面，预览对象里也没有写盘口子
    const keys = Object.keys(first).sort();
    expect(keys).toEqual([
      'addedLineCount',
      'blockers',
      'changed',
      'changedLineCount',
      'code',
      'diff',
      'diffText',
      'errorCount',
      'filePath',
      'firstBlockedLine',
      'metadata',
      'newLineCount',
      'ok',
      'removedLineCount',
      'warningCount',
      'warnings',
    ]);
    // 迁移模型的 dry-run 端口在这里根本不存在（签名只收字符串）
    const module = await import('../src/ui/kojo2-cutover');
    expect(typeof module.previewKojo2Migration).toBe('function');
    expect(module.previewKojo2Migration.length).toBe(1);
  });

  it('controller 的预览入口与纯函数同口径', () => {
    const cutover = createKojo2CutoverController({ stage: 'v1-only' });
    const preview = cutover.previewMigration({ filePath: KOJO_FILE, source: V1_BASIC });
    expect(preview).toEqual(previewKojo2Migration({ filePath: KOJO_FILE, source: V1_BASIC }));
  });
});

