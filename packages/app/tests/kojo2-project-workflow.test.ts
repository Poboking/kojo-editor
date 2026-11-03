/**
 * Kojo 2.0 项目工作流（命令 / 生命周期 / 问题面板 / 发布）单测。
 *
 * 假 kernel（`bus` 事件表 + 内存 `io.walkDir/readText/exportFile` + `project.current()`），
 * 真 Application Service + 真 eraTW 编译事实（组合根登记面同一份 bundle）：本文件钉的是
 * 「UI 接线」这一层的判据，不重复钉 Service/core 自己的语义。
 *
 * 覆盖：
 * 1. mount 后命令 id 恰 3 条（category `Kojo 2.0`）；没有项目时构建命令给 info、不报错；
 * 2. 项目打开 + 内存 `.kojo2`（显式初见 + legacy `# 机`）→ 构建命令跑完 phase ready，
 *    警告（legacy 跳过）已写入问题面板 `kojo2:build` bucket；
 * 3. 发布命令 → `exportFile` 收到含 dispatch 函数的字节，成功回执带落点与单元数；
 * 4. 构建失败（同角色同地点重复）→ 通知 error、问题面板有 error 行、发布被拒（不写盘）；
 * 5. `project.closed` → 问题面板清空且 Service 回 idle；
 * 6. `file.changed` → phase='stale'，且**不触发重编译**（不重读盘）；
 * 7. `enabled() === false` → 零动作（无命令、不 refresh）。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileIO } from '@kojo/plugin-api';
import type { EventBus } from '@kojo/plugin-api';
import type { GameProject } from '@kojo/plugin-api';
import { isPathUnder } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import {
  ERATW_CAPABILITY,
  ERATW_DISPATCH_SELECTORS,
  ERATW_GAME_ADAPTER,
  ERATW_SOURCE_MAP,
  ERATW_TARGET_REGISTRY,
  createEratwEmitBackend,
} from '@kojo/plugin-eratw-adapter';
import { registerKojo2CompileBundle } from '../src/bootstrap';
import { clearProjectScan, setProjectScanProblems, snapshot } from '../src/ui/problem-store';
import { KOJO2_BUILD_PROBLEM_PATH } from '../src/ui/kojo2-project-problems';
import {
  mountKojo2ProjectWorkflow,
  type Kojo2ProjectWorkflowMountDeps,
} from '../src/ui/kojo2-project-workflow';
import type { Kojo2ProjectWorkflowHandle } from '../src/ui/kojo2-project-service-contract';

/* ============================== 夹具 ============================== */

const GAME_ROOT = 'D:/game';
const KOJO_ROOT = 'D:/game/口上';
const CHARA_DIR = 'D:/game/口上/灵梦';
const SHRINE_PATH = 'D:/game/口上/灵梦/01-shrine.kojo2';
const LEGACY_PATH = 'D:/game/口上/灵梦/02-legacy.kojo2';
const DUP_PATH = 'D:/game/口上/灵梦/03-shrine-dup.kojo2';

const SHRINE_SOURCE = '【剧场：初见｜神社】\n# 视角 灵梦\n> 神社的初见\n';
const SHRINE_DUP_SOURCE = '【剧场：初见｜神社】\n# 视角 灵梦\n> 神社的初见（重复定义）\n';
const LEGACY_SOURCE = '# 机 指令 310\n# 视角 灵梦\n> 旧正文\n';

/** 组合根同一份 eraTW 2.0 编译事实（与 `bootstrap.ts` 的登记逐项同源）。 */
beforeAll(() => {
  registerKojo2CompileBundle({
    adapterId: ERATW_GAME_ADAPTER.id,
    adapter: ERATW_GAME_ADAPTER,
    registry: ERATW_TARGET_REGISTRY,
    gameFingerprint: ERATW_GAME_ADAPTER.gameFingerprint,
    createBackend: (deps) =>
      createEratwEmitBackend({
        compileExpression: deps.compileExpression,
        ...(deps.charNo === undefined ? {} : { charNo: deps.charNo }),
        ...(deps.familySegment === undefined ? {} : { familySegment: deps.familySegment }),
      }),
    dispatchSelectors: ERATW_DISPATCH_SELECTORS,
    capability: ERATW_CAPABILITY,
    sourceMapPolicy: ERATW_SOURCE_MAP,
  });
});

interface Harness {
  readonly kernel: Kernel;
  readonly notices: Array<{ kind: 'info' | 'error'; message: string }>;
  readonly exports: Array<{ fileName: string; bytes: Uint8Array; target: string | null }>;
  setProject(project: GameProject | null): void;
  emit(type: string, payload: unknown): void;
  readCount(): number;
}

function gameProject(adapterId = ERATW_GAME_ADAPTER.id): GameProject {
  return {
    rootDir: GAME_ROOT,
    adapterId,
    kojoPaths: [KOJO_ROOT],
    charaIndex: new Map([
      [12, { no: 12, kojoDir: CHARA_DIR, name: '灵梦' }],
      [13, { no: 13, kojoDir: 'D:/game/口上/魔理沙', name: '魔理沙' }],
    ]),
  } as unknown as GameProject;
}

function createHarness(files: ReadonlyMap<string, string>): Harness {
  const notices: Harness['notices'] = [];
  const exportsList: Harness['exports'] = [];
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  let project: GameProject | null = null;
  let reads = 0;

  const bus = {
    on(type: string, handler: (payload: unknown) => void) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return () => {
        set.delete(handler);
      };
    },
  } as unknown as EventBus;

  const io = {
    async walkDir(root: string, opts?: { filter?: (entry: { name: string; isDirectory: boolean }) => boolean }) {
      const entries = [...files.keys()]
        .filter((filePath) => isPathUnder(root, filePath))
        .map((filePath) => ({
          name: filePath.slice(filePath.lastIndexOf('/') + 1),
          path: filePath,
          isDirectory: false,
        }));
      const filter = opts?.filter;
      return filter === undefined ? entries : entries.filter((entry) => filter(entry));
    },
    async readText(path: string) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      reads += 1;
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async exportFile(fileName: string, bytes: Uint8Array): Promise<string | null> {
      const target = `C:/out/${fileName}`;
      exportsList.push({ fileName, bytes, target });
      return target;
    },
  } as unknown as FileIO;

  const kernel = {
    project: {
      current: () => project,
    },
    io,
    bus,
  } as unknown as Kernel;

  return {
    kernel,
    notices,
    exports: exportsList,
    setProject: (next) => {
      project = next;
    },
    emit: (type, payload) => {
      const set = handlers.get(type);
      if (set === undefined) return;
      for (const handler of [...set]) handler(payload);
    },
    readCount: () => reads,
  };
}

function mount(harness: Harness, overrides: Partial<Kojo2ProjectWorkflowMountDeps> = {}): Kojo2ProjectWorkflowHandle {
  return mountKojo2ProjectWorkflow({
    kernel: harness.kernel,
    notify: (notice) => harness.notices.push({ kind: notice.kind, message: notice.message }),
    ...overrides,
  });
}

const flush = async (times = 3): Promise<void> => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const commandOf = (handle: Kojo2ProjectWorkflowHandle, id: string) => {
  const found = handle.commands.find((command) => command.id === id);
  if (found === undefined) throw new Error(`命令缺失：${id}`);
  return found;
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

let active: Kojo2ProjectWorkflowHandle | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
  // problem-store 是全局：清掉整项目扫描簇（本文件只写这一簇）。
  clearProjectScan();
});

/* ============================== 用例 ============================== */

describe('mount · 命令面与前置检查', () => {
  it('命令 id 恰 3 条、category = Kojo 2.0', () => {
    const handle = mount(createHarness(new Map()));
    active = handle;
    expect(handle.commands.map((command) => command.id).sort()).toEqual([
      'kojo2.project.compile',
      'kojo2.project.previewDispatch',
      'kojo2.project.publish',
    ]);
    expect(handle.commands.every((command) => command.category === 'Kojo 2.0')).toBe(true);
  });

  it('没有项目时构建命令只给 info（不报错、不触发 Service 失败）', async () => {
    const harness = createHarness(new Map());
    const handle = mount(harness);
    active = handle;
    commandOf(handle, 'kojo2.project.compile').run();
    await waitFor(() => harness.notices.length > 0, '构建命令回执');
    expect(harness.notices[0]?.kind).toBe('info');
    expect(harness.notices[0]?.message).toContain('还没有打开的游戏项目');
    expect(harness.exports).toEqual([]);
  });

  it('enabled()===false：零动作（无命令、不 refresh、不读盘）', async () => {
    const files = new Map([[SHRINE_PATH, SHRINE_SOURCE]]);
    const harness = createHarness(files);
    harness.setProject(gameProject());
    const handle = mount(harness, { enabled: () => false });
    active = handle;
    await flush();
    expect(handle.commands).toEqual([]);
    expect(harness.readCount()).toBe(0);
    expect(snapshot()).toEqual([]);
  });
});

describe('构建命令 · 显式初见 + legacy 混合项目', () => {
  function mixedHarness(): Harness {
    const harness = createHarness(
      new Map([
        [SHRINE_PATH, SHRINE_SOURCE],
        [LEGACY_PATH, LEGACY_SOURCE],
      ]),
    );
    harness.setProject(gameProject());
    return harness;
  }

  it('phase ready；文档/Theater/目标组读数齐；legacy 跳过警告已上问题面板', async () => {
    const harness = mixedHarness();
    const handle = mount(harness);
    active = handle;
    commandOf(handle, 'kojo2.project.compile').run();
    await waitFor(() => handle.service.state().phase === 'ready', 'phase ready');

    const state = handle.service.state();
    expect(state.result?.build.buildStatus).toBe('succeeded');
    expect(state.result?.dispatchErb).toHaveLength(1);
    expect(state.plan?.status).toBe('ready');
    expect(state.plan?.legacyFiles).toHaveLength(1);
    expect(state.plan?.previewOnlyTheaterCount).toBe(1);
    expect(state.stats.documentCount).toBe(2);
    expect(state.stats.theaterCount).toBeGreaterThan(0);

    await waitFor(() => harness.notices.length > 0, '构建成功回执');
    const notice = harness.notices[harness.notices.length - 1];
    expect(notice?.kind).toBe('info');
    expect(notice?.message).toContain('Kojo 2.0 项目构建完成');
    expect(notice?.message).toContain('2 份文档');

    // 问题桶写入可查：legacy 跳过（warning）在面板里；能下钻到文件就带真实路径
    // （Service 用 candidateTheaterIds 反查），反查不到才落项目级 `kojo2:build`。
    const items = snapshot();
    expect(items.some((item) => item.severity === 'warning')).toBe(true);
    expect(items.some((item) => item.message.includes('[调度]'))).toBe(true);
    expect(
      items.some(
        (item) => item.path === KOJO2_BUILD_PROBLEM_PATH || item.path === LEGACY_PATH,
      ),
    ).toBe(true);
  });

  it('预览命令：一条 info 汇总 plan / assembly / previewOnlyTheaterCount', async () => {
    const harness = mixedHarness();
    const handle = mount(harness);
    active = handle;
    commandOf(handle, 'kojo2.project.compile').run();
    await waitFor(() => handle.service.state().phase === 'ready', 'phase ready');
    commandOf(handle, 'kojo2.project.previewDispatch').run();
    await waitFor(
      () => harness.notices.some((notice) => notice.message.includes('调度计划')),
      '预览回执',
    );
    const text = harness.notices[harness.notices.length - 1]?.message ?? '';
    expect(text).toContain('dispatch target');
    expect(text).toContain('M_KOJO_ENCOUNTER_K12');
    expect(text).toContain('仅预览');
    expect(text).toContain('legacy 文件');
  });

  it('发布命令：exportFile 收到含 dispatch 函数的字节，成功回执带落点与单元数', async () => {
    const harness = mixedHarness();
    const handle = mount(harness);
    active = handle;
    commandOf(handle, 'kojo2.project.publish').run();
    await waitFor(() => harness.exports.length > 0, 'exportFile 调用');
    await waitFor(
      () => harness.notices.some((notice) => notice.message.startsWith('已导出：')),
      '发布成功回执',
    );

    const exported = harness.exports[0];
    expect(exported?.fileName).toBe('kojo2-project.ERB');
    const text = decode(exported?.bytes ?? new Uint8Array());
    // dispatch 是最终运行时调度产物；legacy `# 机` 字节由 M1 路径补进来。
    expect(text).toContain('@M_KOJO_ENCOUNTER_K12');
    expect(text).toContain('@M_KOJO');
    // 1 dispatch unit + 1 legacy-m1 unit
    expect(text).toContain('__D1');
    const notice = harness.notices[harness.notices.length - 1];
    expect(notice?.kind).toBe('info');
    expect(notice?.message).toContain(`已导出：${exported?.target}`);
    expect(notice?.message).toContain('（2 个单元）');
    // 已知缺口提示：表达式端口恒等透传，不阻断发布但要随成功回执说清楚。
    expect(notice?.message).toContain('已知缺口');
    expect(notice?.message).toContain('恒等透传');
  });
});

describe('失败路径 · 重复定义', () => {
  it('构建失败：通知 error、问题面板有 error 行、发布被拒（不写盘）', async () => {
    const harness = createHarness(
      new Map([
        [SHRINE_PATH, SHRINE_SOURCE],
        [DUP_PATH, SHRINE_DUP_SOURCE],
      ]),
    );
    harness.setProject(gameProject());
    const handle = mount(harness);
    active = handle;

    commandOf(handle, 'kojo2.project.compile').run();
    await waitFor(() => handle.service.state().phase === 'failed', 'phase failed');
    await waitFor(() => harness.notices.some((notice) => notice.kind === 'error'), '构建失败回执');
    const failureNotice = harness.notices.find((notice) => notice.kind === 'error');
    expect(failureNotice?.message).toContain('Kojo 2.0 项目构建失败');
    expect(failureNotice?.message).toContain('详见问题面板');

    const items = snapshot();
    expect(items.some((item) => item.severity === 'error')).toBe(true);
    expect(items.some((item) => item.path === 'kojo2:build')).toBe(true);

    commandOf(handle, 'kojo2.project.publish').run();
    await waitFor(
      () => harness.notices.some((notice) => notice.message.includes('无法发布')),
      '发布被拒回执',
    );
    expect(harness.exports).toEqual([]);
  });
});

describe('生命周期 · project.closed / file.changed', () => {
  it('project.closed 后问题桶清空且 Service 回 idle（不碰 kojo2:project 那一簇）', async () => {
    const harness = createHarness(new Map([[SHRINE_PATH, SHRINE_SOURCE]]));
    harness.setProject(gameProject());
    const handle = mount(harness);
    active = handle;
    commandOf(handle, 'kojo2.project.compile').run();
    await waitFor(() => handle.service.state().phase === 'ready', 'phase ready');

    // `kojo2:project` 那一簇不归本模块清：放一条，验证清账只清自己的 bucket。
    setProjectScanProblems('kojo2:project', [
      { path: 'kojo2:project', line: 1, severity: 'warning', message: '存储期问题（另一簇）' },
    ]);
    harness.setProject(null);
    harness.emit('project.closed', { rootDir: GAME_ROOT });
    await waitFor(() => handle.service.state().phase === 'idle', 'idle');

    const left = snapshot();
    expect(left.filter((item) => item.path === 'kojo2:build')).toEqual([]);
    expect(left.some((item) => item.path === 'kojo2:project')).toBe(true);
  });

  it('file.changed 只标脏：phase stale，且不重读盘（不触发重编译）', async () => {
    const harness = createHarness(new Map([[SHRINE_PATH, SHRINE_SOURCE]]));
    harness.setProject(gameProject());
    const handle = mount(harness);
    active = handle;
    commandOf(handle, 'kojo2.project.compile').run();
    await waitFor(() => handle.service.state().phase === 'ready', 'phase ready');
    const readsBefore = harness.readCount();
    const resultBefore = handle.service.state().result;

    harness.emit('file.changed', { kind: 'change', path: SHRINE_PATH });
    await waitFor(() => handle.service.state().phase === 'stale', 'stale');
    await flush(4);
    expect(handle.service.state().result).toBe(resultBefore);
    expect(harness.readCount()).toBe(readsBefore);
  });
});
