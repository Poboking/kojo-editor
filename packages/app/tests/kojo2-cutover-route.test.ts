/**
 * K2-CUTOVER-ROUTE 的判据闸：**诊断/问题归属按路由，不按扩展名**。
 *
 * 钉六件事：
 * 1. **单入口**：`path+source → route` 只有 `kojo2RouteFor` / `kojo2RouteForText` /
 *    `kojo2RouteForPath` 三格（分别对应 model / 正文 / 只有路径），结论与
 *    `decideKojo2Route` 逐字一致；
 * 2. **`.kojo2` 各阶段**：`v1-only` 恒不归（blocked）、`dual` / `2.0-default` 恒归；
 * 3. **`2.0-default` 的 `.kojo`**：内容 2.0 归 2.0、v1 / 空 / 歧义不归（歧义只给唯一兜底
 *    v1）；override 仍当家；`dual` 下内容再 2.0 也不归（阶段说了算）；
 * 4. **只有路径的那一腿**（`EditorPane.refreshMarkers`）：带正文的结论进有界备忘 ⇒
 *    同一个文件路径也判归 2.0；没有结论 / `needs-content` ⇒ 不接管（失败方向 = 不抢
 *    v1 的活）；阶段 / override 一变立即失效；
 * 5. **诊断接线**：活动 model 判定改用路由——`2.0-default` 下内容已是 2.0 的 `.kojo`
 *    接管（跑诊断、上 markers）、v1 内容让路；读不到正文 ⇒ 不接管且**不静默**（info 通知
 *    一次）；内容从 v1 改成 2.0 后击键即接管；
 * 6. **flag 关 / `v1-only` 逐字不变**：一个监听都不挂、一次诊断都不跑、一次存储之外的
 *    东西都不碰，归属恒 `false`。
 *
 * 环境是 node：开关用假 `window.localStorage`（计划文档 + 旧布尔键），诊断入口注入假体。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import type { Kernel } from '@kojo/kernel';
import {
  KOJO2_CUTOVER_STORAGE_KEY,
  KOJO2_LEGACY_FLAG_KEY,
  getKojo2CutoverController,
  resetKojo2CutoverController,
  type Kojo2CutoverStage,
  type Kojo2CutoverStorage,
  type Kojo2Parser,
} from '../src/ui/kojo2-cutover';
import {
  clearKojo2RouteMemo,
  isKojo2RouteablePath,
  kojo2DiagnosticsEnabled,
  kojo2OwnsDiagnostics,
  kojo2OwnsRoute,
  kojo2RouteFor,
  kojo2RouteForPath,
  kojo2RouteForText,
} from '../src/ui/kojo2-diagnostics-gate';
import { installKojo2ProblemWiring } from '../src/ui/kojo2-problem-wiring';
import type { Kojo2DiagnoseFn } from '../src/ui/kojo2-problem-sync';
import type { EditorProblem } from '../src/ui/problem-store';

/* ============================== 夹具 ============================== */

/** 已是 2.0 写法（全过 2.0 词法 + 有锚点 ⇒ 内容指纹判 kojo2） */
const KOJO2_SAMPLE = '# 机 指令 310\n灵梦：「你好。」\n';
/** 真实 v1 片段（3 行反例 ⇒ 指纹判 v1） */
const V1_SAMPLE = '角色: 灵梦\n时机 指令 310：\n「你好。」\n';
/** 纯台词：两套解析器都说得通 ⇒ ambiguous（唯一兜底 v1） */
const AMBIGUOUS_SAMPLE = '灵梦：「你好。」\n';

const KOJO_PATH = 'C:/proj/chara/M_KOJO_K12_指令.kojo';
const KOJO2_PATH = 'C:/proj/chara/M_KOJO_K12_指令.kojo2';

class MemoryStorage implements Kojo2CutoverStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** 装假 `window.localStorage`（不挂控制器：只有开关的派生路径看它） */
function stubWindow(storage: MemoryStorage = new MemoryStorage()): MemoryStorage {
  vi.stubGlobal('window', { localStorage: storage });
  return storage;
}

/**
 * 开机：盘上计划 + 控制器 `attachStorage`（真宿主的同一拍）。
 * 不挂存储时 `resolveKojo2CutoverStage()` 与控制器阶段就会分叉——本文件不制造那种分叉。
 */
function boot(
  stage: Kojo2CutoverStage,
  overrides: Readonly<Record<string, Kojo2Parser>> = {},
): MemoryStorage {
  const storage = new MemoryStorage();
  storage.values.set(
    KOJO2_CUTOVER_STORAGE_KEY,
    JSON.stringify({ version: 1, stage, overrides }),
  );
  stubWindow(storage);
  getKojo2CutoverController().attachStorage(storage);
  return storage;
}

/** 改盘上的计划（模拟设置页改档）：生效阶段立刻跟着变 */
function commitPlan(storage: MemoryStorage, stage: Kojo2CutoverStage): void {
  storage.values.set(
    KOJO2_CUTOVER_STORAGE_KEY,
    JSON.stringify({ version: 1, stage, overrides: {} }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKojo2CutoverController();
  clearKojo2RouteMemo();
  vi.restoreAllMocks();
});

/* ============================== ① 单入口 ============================== */

describe('① 单入口：path+source → route 只有一处', () => {
  it('flag 关（没有计划、没有旧键）⇒ `.kojo2` 照归 2.0、`.kojo` 按 v1', () => {
    stubWindow();
    getKojo2CutoverController(); // 惰性单例 = v1-only
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    const kojo2 = kojo2RouteForPath(KOJO2_PATH);
    expect(kojo2).toMatchObject({ kind: 'resolved', parser: 'kojo2', reason: 'extension-kojo2' });
    expect(kojo2RouteForPath(KOJO_PATH)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'stage-v1-only',
    });
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(false);
  });

  it('`kojo2RouteFor(model)`：URI 路径优先 + 正文取自 model（`.kojo` 内容 2.0 归 2.0）', () => {
    boot('2.0-default');
    const model = {
      uri: { fsPath: KOJO_PATH },
      getValue: () => KOJO2_SAMPLE,
    };
    const route = kojo2RouteFor(model);
    expect(route).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'content-kojo2',
      filePath: KOJO_PATH,
    });
    expect(kojo2OwnsRoute(route)).toBe(true);
    expect(route.kind === 'resolved' ? route.fingerprint?.flavor : null).toBe('kojo2');
  });

  it('`kojo2RouteFor(model)`：没有 URI 时回落 `options.filePath`（切标签那一拍的口径）', () => {
    boot('2.0-default');
    const route = kojo2RouteFor(
      { getValue: () => V1_SAMPLE },
      { filePath: KOJO_PATH },
    );
    expect(route).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'content-v1',
      filePath: KOJO_PATH,
    });
    expect(kojo2OwnsRoute(route)).toBe(false);
  });

  it('`kojo2RouteFor` 与 `kojo2RouteForText` 同源：同一路径 / 正文给同一份结论', () => {
    boot('2.0-default');
    const fromModel = kojo2RouteFor({ uri: { fsPath: KOJO_PATH }, getValue: () => KOJO2_SAMPLE });
    const fromText = kojo2RouteForText(KOJO_PATH, KOJO2_SAMPLE);
    expect(fromModel.kind).toBe(fromText.kind);
    expect(fromModel.kind === 'resolved' ? fromModel.parser : null).toBe(
      fromText.kind === 'resolved' ? fromText.parser : null,
    );
    expect(fromModel.kind === 'resolved' ? fromModel.reason : null).toBe(
      fromText.kind === 'resolved' ? fromText.reason : null,
    );
  });

  it('`kojo2RouteForText(path, undefined)` = 只有路径：`2.0-default` 的 `.kojo` 是 needs-content', () => {
    boot('2.0-default');
    const route = kojo2RouteForText(KOJO_PATH, undefined);
    expect(route).toMatchObject({ kind: 'needs-content', reason: 'content-required' });
    expect(kojo2OwnsRoute(route)).toBe(false);
  });
});

/* ============================== ② `.kojo2` 各阶段 ============================== */

describe('② `.kojo2` 各阶段：恒归（语言面无条件），阶段只管 `.kojo`', () => {
  it('v1-only：`.kojo2` 照归（语言面无条件）', () => {
    boot('v1-only');
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: KOJO2_PATH, source: KOJO2_SAMPLE })).toBe(true);
  });

  it('dual：`.kojo2` 恒归（扩展名先说话，正文不参与）', () => {
    boot('dual');
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: KOJO2_PATH, source: V1_SAMPLE })).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: KOJO2_PATH, source: AMBIGUOUS_SAMPLE })).toBe(true);
  });

  it('2.0-default：`.kojo2` 恒归（大小写不敏感）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_PATH.toUpperCase())).toBe(true);
  });

  it('`.kojo2` 被 override 钉回 v1 ⇒ 不归（显式破例最高优先级）', () => {
    boot('2.0-default', { [KOJO2_PATH]: 'kojo-v1' });
    expect(kojo2RouteForPath(KOJO2_PATH)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'override',
    });
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(false);
    expect(kojo2OwnsDiagnostics({ path: KOJO2_PATH, source: KOJO2_SAMPLE })).toBe(false);
  });

  it('`.kojo` 被 override 钉成 2.0（dual）⇒ 归 2.0；v1-only 下钉不住（blocked）', () => {
    boot('dual', { [KOJO_PATH]: 'kojo2' });
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);

    boot('v1-only', { [KOJO_PATH]: 'kojo2' });
    expect(kojo2RouteForPath(KOJO_PATH)).toMatchObject({
      kind: 'blocked',
      reason: 'stage-disables-kojo2',
    });
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
  });

  it('非 kojo 文件（`.erb` / `.txt` / `.kojo.bak`）在所有阶段都不归', () => {
    for (const stage of ['v1-only', 'dual', '2.0-default'] as const) {
      boot(stage);
      for (const path of ['C:/p/a.erb', 'C:/p/readme.txt', 'C:/p/a.kojo.bak']) {
        expect(kojo2OwnsDiagnostics(path), `${stage} ${path}`).toBe(false);
        expect(kojo2OwnsDiagnostics({ path, source: KOJO2_SAMPLE }), `${stage} ${path}`).toBe(
          false,
        );
        expect(isKojo2RouteablePath(path), path).toBe(false);
      }
      expect(isKojo2RouteablePath(KOJO_PATH), stage).toBe(true);
      expect(isKojo2RouteablePath(KOJO2_PATH), stage).toBe(true);
    }
  });

  it('非 kojo 文件被 override 钉成 2.0 ⇒ 仍按路由归 2.0（override 当家，预筛不挡破例）', () => {
    boot('2.0-default', { 'C:/p/a.erb': 'kojo2' });
    expect(isKojo2RouteablePath('C:/p/a.erb')).toBe(true);
    expect(kojo2OwnsDiagnostics('C:/p/a.erb')).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: 'C:/p/a.erb', source: '# 机 指令 310\n' })).toBe(true);
    // 同一目录下没有破例的 `.erb` 仍不归
    expect(kojo2OwnsDiagnostics('C:/p/b.erb')).toBe(false);
  });

  it('空路径 / 非字符串路径不猜（恒 false，不抛）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics('')).toBe(false);
    expect(
      kojo2OwnsDiagnostics({ path: '   ' } as unknown as { path: string }),
    ).toBe(false);
  });
});

/* ============================== ③ 2.0-default 的 `.kojo` 内容判据 ============================== */

describe('③ 2.0-default 的 `.kojo`：只有内容能说话', () => {
  it('内容已是 2.0 ⇒ 归 2.0（这正是旧扩展名判据漏掉的那一格）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(true);
    expect(kojo2RouteForText(KOJO_PATH, KOJO2_SAMPLE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo2',
      reason: 'content-kojo2',
    });
  });

  it('内容仍是 v1 ⇒ 不归（v1 诊断照常跑）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: V1_SAMPLE })).toBe(false);
    expect(kojo2RouteForText(KOJO_PATH, V1_SAMPLE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'content-v1',
    });
  });

  it('空文件 ⇒ 两套等价，按 v1 开（content-empty，不归 2.0）', () => {
    boot('2.0-default');
    expect(kojo2RouteForText(KOJO_PATH, '   \n\t\n')).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'content-empty',
    });
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: '' })).toBe(false);
  });

  it('歧义（纯台词 / 混排）⇒ 不接管，只给唯一兜底 v1', () => {
    boot('2.0-default');
    const pure = kojo2RouteForText(KOJO_PATH, AMBIGUOUS_SAMPLE);
    expect(pure).toMatchObject({ kind: 'ambiguous', fallback: 'kojo-v1' });
    expect(kojo2OwnsRoute(pure)).toBe(false);
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: AMBIGUOUS_SAMPLE })).toBe(false);

    const mixed = kojo2RouteForText(
      KOJO_PATH,
      '# 机 指令 310\n灵梦：「你好。」\n? 恋慕 >= 500\n角色: 灵梦\n    如果 恋慕：\n',
    );
    expect(mixed.kind).toBe('ambiguous');
    expect(kojo2OwnsRoute(mixed)).toBe(false);
  });

  it('override 压过内容：2.0 正文 + v1 破例 ⇒ 不归；v1 正文 + 2.0 破例 ⇒ 归', () => {
    boot('2.0-default');
    const controller = getKojo2CutoverController();

    controller.setOverride(KOJO_PATH, 'kojo-v1');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(false);
    controller.clearOverride(KOJO_PATH);

    controller.setOverride(KOJO_PATH, 'kojo2');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: V1_SAMPLE })).toBe(true);
  });

  it('一次性 override 只作用于这一问（不写进"只有路径"的备忘）', () => {
    boot('2.0-default');
    const oneShot = kojo2RouteForText(KOJO_PATH, KOJO2_SAMPLE, { override: 'kojo-v1' });
    expect(oneShot).toMatchObject({ kind: 'resolved', parser: 'kojo-v1', reason: 'override' });
    // 备忘没被这次一次性破例污染：同一路径按正文仍判 2.0
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(true);
  });

  it('dual 下内容再像 2.0 也不归（阶段定老文件，内容只在 2.0-default 里断）', () => {
    boot('dual');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(false);
    expect(kojo2RouteForText(KOJO_PATH, KOJO2_SAMPLE)).toMatchObject({
      kind: 'resolved',
      parser: 'kojo-v1',
      reason: 'stage-dual',
    });
  });
});

/* ============================== ④ 只有路径那一腿 ============================== */

describe('④ 只有路径（EditorPane）：带正文的结论进备忘，needs-content 不接管', () => {
  it('没有正文结论 ⇒ `2.0-default` 的 `.kojo` 是 needs-content，归属 false（不抢 v1 的活）', () => {
    boot('2.0-default');
    expect(kojo2RouteForPath(KOJO_PATH)).toMatchObject({ kind: 'needs-content' });
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
  });

  it('带正文判过 2.0 ⇒ 只有路径也归 2.0（v1 装饰轮让路与诊断同源）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(true);
    // EditorPane.refreshMarkers 的真实调用形态：只有一个 path
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    // 路径写法差异（反斜杠 / 大小写）也必须命中同一份备忘
    expect(kojo2OwnsDiagnostics('C:\\proj\\chara\\M_KOJO_K12_指令.KOJO')).toBe(true);
  });

  it('带正文判过 v1 ⇒ 只有路径也 false（v1 装饰轮照常发布）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: V1_SAMPLE })).toBe(false);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
  });

  it('内容翻转：2.0 → v1 ⇒ 备忘跟着翻，只有路径也回到不归', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: V1_SAMPLE })).toBe(false);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
  });

  it('改档即失效：2.0-default 的结论不许在 dual 里续命', () => {
    const storage = boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);

    commitPlan(storage, 'dual');
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(false);
  });

  it('改 override 即失效：2.0 的结论不许在"钉回 v1"之后续命', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);

    getKojo2CutoverController().setOverride(KOJO_PATH, 'kojo-v1');
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
  });

  it('控制器重置回 v1-only ⇒ `.kojo` 的 2.0 归属回落（`.kojo2` 不受影响）', () => {
    boot('2.0-default');
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(true);
    // 摘掉存储 + 重置控制器 = 阶段回到 v1-only
    vi.unstubAllGlobals();
    resetKojo2CutoverController();
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(false);
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(false);
  });

  it('旧布尔键 `on` ⇒ dual（迁移规则不变）：`.kojo` 仍按 v1，只有 `.kojo2` 归 2.0', () => {
    const storage = stubWindow();
    storage.values.set(KOJO2_LEGACY_FLAG_KEY, 'on');
    getKojo2CutoverController();
    expect(kojo2DiagnosticsEnabled()).toBe(true);
    expect(kojo2OwnsDiagnostics({ path: KOJO_PATH, source: KOJO2_SAMPLE })).toBe(false);
    expect(kojo2OwnsDiagnostics(KOJO2_PATH)).toBe(true);
  });
});

/* ============================== ⑤ 诊断接线 ============================== */

const SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
const SEVERITY_SOURCE = { MarkerSeverity: SEVERITY } as unknown as Parameters<
  typeof installKojo2ProblemWiring
>[0]['severitySource'];

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly path: string;
  setText(text: string, version?: number): void;
}

function fakeModel(path: string, initialText: string, initialVersion = 1): FakeModel {
  let text = initialText;
  let version = initialVersion;
  const model = {
    getValue: () => text,
    getVersionId: () => version,
    isDisposed: () => false,
    getLineCount: () => text.split('\n').length,
    getLineMaxColumn: (line: number) => (text.split('\n')[line - 1] ?? '').length + 1,
    uri: { fsPath: path },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    path,
    setText(next, nextVersion) {
      text = next;
      version = nextVersion ?? version + 1;
    },
  };
}

/** 正文取不到（model 已在销毁途中）：`isDisposed` 仍是 false，`getValue` 抛 */
function unreadableModel(path: string): Monaco.editor.ITextModel {
  return {
    getValue: () => {
      throw new Error('取值失败');
    },
    getVersionId: () => 1,
    isDisposed: () => false,
    getLineCount: () => 1,
    getLineMaxColumn: () => 1,
    uri: { fsPath: path },
  } as unknown as Monaco.editor.ITextModel;
}

interface FakeEditor {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  setModel(model: Monaco.editor.ITextModel): void;
  fireContent(): void;
  readonly contentListeners: () => number;
  readonly modelListeners: () => number;
}

function fakeEditor(initial: Monaco.editor.ITextModel): FakeEditor {
  const content = new Set<() => void>();
  const switched = new Set<() => void>();
  let model = initial;
  const editor = {
    getModel: () => model,
    onDidChangeModelContent: (callback: () => void): Monaco.IDisposable => {
      content.add(callback);
      return { dispose: () => content.delete(callback) };
    },
    onDidChangeModel: (callback: () => void): Monaco.IDisposable => {
      switched.add(callback);
      return { dispose: () => switched.delete(callback) };
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  return {
    editor,
    setModel(next) {
      model = next;
      for (const callback of [...switched]) callback();
    },
    fireContent() {
      for (const callback of [...content]) callback();
    },
    contentListeners: () => content.size,
    modelListeners: () => switched.size,
  };
}

interface ManualScheduler {
  readonly scheduler: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  runAll(): void;
  pending(): number;
}

function manualScheduler(): ManualScheduler {
  const timers = new Map<number, () => void>();
  let seq = 0;
  return {
    scheduler: {
      setTimeout(callback) {
        seq += 1;
        timers.set(seq, callback);
        return seq;
      },
      clearTimeout(handle) {
        timers.delete(handle as number);
      },
    },
    runAll() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pending: () => timers.size,
  };
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function fakeKernel(): Kernel {
  return { project: { current: () => null } } as unknown as Kernel;
}

/** 一轮"成功"的诊断入口（markers 固定；测试要数调用次数，故保留 vi 的 `.mock` 面） */
function diagnoseReturning() {
  return vi.fn(async (input: { source: string; filePath: string }) => ({
    filePath: input.filePath,
    diagnostics: [],
    markers: [
      {
        severity: SEVERITY.Error,
        message: '示例错误',
        code: 'core/example',
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2,
      },
    ] as Monaco.editor.IMarkerData[],
    error: null,
    errorCount: 0,
    warningCount: 0,
    ok: true,
  }));
}

function wire(
  fake: FakeEditor,
  options: {
    readonly path: string;
    readonly diagnose?: Kojo2DiagnoseFn;
    readonly scheduler?: ManualScheduler;
    readonly notify?: (notice: { kind: 'info' | 'error'; message: string; detail?: string }) => void;
  },
) {
  const markerCalls: { readonly model: Monaco.editor.ITextModel; readonly markers: readonly Monaco.editor.IMarkerData[] }[] = [];
  const written: { path: string; items: readonly EditorProblem[] }[] = [];
  const erased: string[] = [];
  // 测试要数调用次数：默认入口就是 vi.fn；显式注入那几格（失败形）不数 `.mock`
  const diagnose = (options.diagnose ?? diagnoseReturning()) as unknown as ReturnType<
    typeof diagnoseReturning
  > & Kojo2DiagnoseFn;
  const dispose = installKojo2ProblemWiring({
    editor: fake.editor,
    kernel: fakeKernel(),
    filePathRef: { current: options.path },
    markerHost: {
      editor: {
        setModelMarkers: (model, _owner, markers) => {
          markerCalls.push({ model, markers });
        },
      },
    },
    severitySource: SEVERITY_SOURCE,
    diagnose,
    ...(options.scheduler ? { scheduler: options.scheduler.scheduler, debounceMs: 200 } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
    writeProblems: (path, items) => {
      written.push({ path, items });
    },
    eraseProblems: (path) => {
      erased.push(path);
    },
  });
  return { dispose, markerCalls, written, erased, diagnose };
}

describe('⑤ 诊断接线：活动 model 判定按路由', () => {
  it('2.0-default + `.kojo` 内容 2.0 ⇒ 接管（装上即诊断、markers 上屏）', async () => {
    boot('2.0-default');
    const model = fakeModel(KOJO_PATH, KOJO2_SAMPLE);
    const fake = fakeEditor(model.model);
    const wiring = wire(fake, { path: model.path });
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);
    expect(wiring.diagnose.mock.calls[0]![0]).toEqual({
      source: KOJO2_SAMPLE,
      filePath: KOJO_PATH,
    });
    expect(wiring.markerCalls).toHaveLength(1);
    expect(wiring.markerCalls[0]!.markers).toHaveLength(1);
    // 让路判据与诊断同源：EditorPane 的 path-only 调用现在也判归 2.0
    expect(kojo2OwnsDiagnostics(KOJO_PATH)).toBe(true);
    wiring.dispose();
  });

  it('2.0-default + `.kojo` 内容 v1 ⇒ 不接管（一次诊断都不跑，v1 装饰轮照常）', async () => {
    boot('2.0-default');
    const model = fakeModel(KOJO_PATH, V1_SAMPLE);
    const fake = fakeEditor(model.model);
    const scheduler = manualScheduler();
    const wiring = wire(fake, { path: model.path, scheduler });
    await flushMicrotasks();
    expect(wiring.diagnose).not.toHaveBeenCalled();
    expect(wiring.markerCalls).toEqual([]);
    expect(wiring.written).toEqual([]);
    expect(scheduler.pending()).toBe(0);
    // 击键仍然不排 2.0 诊断（v1 内容在 2.0-default 下归 v1）
    fake.fireContent();
    expect(wiring.diagnose).not.toHaveBeenCalled();
    wiring.dispose();
  });

  it('内容从 v1 改成 2.0 ⇒ 下一次停手就接管（不要求重开标签）', async () => {
    boot('2.0-default');
    const model = fakeModel(KOJO_PATH, V1_SAMPLE);
    const fake = fakeEditor(model.model);
    const scheduler = manualScheduler();
    const wiring = wire(fake, { path: model.path, scheduler });
    await flushMicrotasks();
    expect(wiring.diagnose).not.toHaveBeenCalled();

    model.setText(KOJO2_SAMPLE, 2);
    fake.fireContent();
    expect(scheduler.pending()).toBe(1); // needs-content 先排上，正文留到定时器响时读
    scheduler.runAll();
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);
    expect(wiring.markerCalls.at(-1)!.markers).toHaveLength(1);
    wiring.dispose();
  });

  it('切回不归 2.0 的文件 ⇒ 撤旧 markers / 面板条目（切到 `.erb`）', async () => {
    boot('2.0-default');
    const kojo = fakeModel(KOJO_PATH, KOJO2_SAMPLE);
    const erb = fakeModel('C:/p/a.erb', '; x\n');
    const fake = fakeEditor(kojo.model);
    const wiring = wire(fake, { path: kojo.path });
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);

    fake.setModel(erb.model);
    await flushMicrotasks();
    expect(wiring.markerCalls.at(-1)!.markers).toEqual([]);
    expect(wiring.erased).toContain(KOJO_PATH);
    wiring.dispose();
  });

  it('needs-content（正文取不到）⇒ 不接管、不静默：不跑诊断，info 通知恰一次', async () => {
    boot('2.0-default');
    const model = unreadableModel(KOJO_PATH);
    const fake = fakeEditor(model);
    const scheduler = manualScheduler();
    const notify = vi.fn();
    const wiring = wire(fake, { path: KOJO_PATH, scheduler, notify });
    await flushMicrotasks();
    expect(wiring.diagnose).not.toHaveBeenCalled();
    expect(wiring.markerCalls).toEqual([]);
    expect(wiring.written).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].kind).toBe('info');
    expect(notify.mock.calls[0]![0].message).toContain('2.0 默认');
    expect(notify.mock.calls[0]![0].detail).toBe(KOJO_PATH);

    // 同一份文件的后续击键不再刷屏
    fake.fireContent();
    scheduler.runAll();
    await flushMicrotasks();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(wiring.diagnose).not.toHaveBeenCalled();
    wiring.dispose();
  });

  it('dual 下 `.kojo` 仍不接管、`.kojo2` 接管（阶段是唯一判据，内容不参与）', async () => {
    boot('dual');
    const kojo = fakeModel(KOJO_PATH, KOJO2_SAMPLE);
    const fake = fakeEditor(kojo.model);
    const wiring = wire(fake, { path: kojo.path });
    await flushMicrotasks();
    expect(wiring.diagnose).not.toHaveBeenCalled();

    const kojo2 = fakeModel(KOJO2_PATH, KOJO2_SAMPLE);
    fake.setModel(kojo2.model);
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalledTimes(1);
    wiring.dispose();
  });

  it('flag 关 ⇒ 接线照挂，但 `.kojo` 零诊断（v1 行为逐字不变）', async () => {
    stubWindow();
    getKojo2CutoverController();
    const model = fakeModel(KOJO_PATH, KOJO2_SAMPLE);
    const fake = fakeEditor(model.model);
    const wiring = wire(fake, { path: model.path });
    expect(fake.contentListeners()).toBe(1);
    expect(fake.modelListeners()).toBe(1);
    fake.fireContent();
    await flushMicrotasks();
    expect(wiring.diagnose).not.toHaveBeenCalled();
    expect(wiring.markerCalls).toEqual([]);
    wiring.dispose();
  });

  it('v1-only ⇒ `.kojo2` 照常诊断（语言面无条件）', async () => {
    boot('v1-only');
    const model = fakeModel(KOJO2_PATH, KOJO2_SAMPLE);
    const fake = fakeEditor(model.model);
    const wiring = wire(fake, { path: model.path });
    expect(fake.contentListeners()).toBe(1);
    await flushMicrotasks();
    expect(wiring.diagnose).toHaveBeenCalled();
    wiring.dispose();
  });
});
