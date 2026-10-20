/**
 * S6 批验收：糖判定面板 + 编辑器波浪线**端到端**（跨插件的服务槽接线）。
 *
 * 本文件是**测试**（解耦审计规则 C 对 `tests/` 豁免），故可以直接 import 两个
 * 插件包来验证接线——生产代码里它们只能通过服务槽相见。
 *
 * 验的是那条最容易坏、也最该被钉死的东西：
 *
 * ```
 * ui-sugar-editor  --(服务槽)-->  kojo-sugar 的 sugar.transpile（纯函数）
 *        |                              |
 *   ui.editor.decorator            （无 IO：只吃宿主给的 {path,text}）
 *   ui.panel（糖判定）──内核 io（只读当前 .kojo）
 * ```
 *
 * 四件事必须同时成立：
 * 1. **插件真的能激活**（`requires` 两项由 kojo-sugar / 内核提供）；
 * 2. **三处贡献都注册**（`ui.editor.decorator` + `ui.editor.saveHandler` + `ui.panel`）；
 * 3. **波浪线是"诊断 → 装饰"的翻译**——`.kojo` 坏源出行级装饰、原生 `.ERB` 返回空；
 * 4. **没有自发明的转译逻辑**——装饰与判定都源自 `sugar.transpile`。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  EditorDecoratorContribution,
  EditorSaveHandlerContribution,
  FileIO,
  FileStat,
  KernelEventMap,
  LineDecoration,
  Logger,
  Plugin,
  SugarTranspileService,
  TrashEntry,
  UIPanelContribution,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createUiSugarEditorPlugin } from '../src/index';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const enc = (s: string) => new TextEncoder().encode(s);

/** 良构糖源（无 error；`「你好。」` 的 `续` 在引号外，故不触发 cont-inside-quotes） */
const KOJO_OK = ['角色: 1', '时机 初见：', '    「你好。」', '    她笑了。 续', ''].join('\n');
/** 坏糖源：`续` 写在引号内 → error 诊断 `cont-inside-quotes`（带行列） */
const KOJO_BAD = ['角色: 1', '时机 初见：', '    「你好。 续」', ''].join('\n');
const PATH_KOJO = '/proj/口上/x.kojo';
const PATH_ERB = '/proj/口上/x.ERB';
/** 声明文件（FT-2 进面的 `.ERH`）：糖线一律不接管，保存原样写盘 */
const PATH_ERH = '/proj/口上/x.ERH';

/** 伪内核 io（内存 FS；与 preview / lift 集成测试同款） */
function makeIO(files: Record<string, Uint8Array>): FileIO {
  // W11 回收站**如实可用**假桩（内存条目表；口径照 io.ts :293/:310/:324/:330 原文）：
  // listTrash 返回空清单/筛选清单；restore/purge 对未知或形态不合的 id **按契约文本拒绝**；
  // holdTrash 是会话内软保护（整替语义、纯内存、不落盘、拦不住显式 purge）。
  // 写允许域闸门本夹具不模拟（writeBytes 同款直落内存表）——恢复口径一致。
  const trashStore = new Map<string, TrashEntry>();
  const trashPayload = new Map<string, Uint8Array>();
  const heldTrash = new Set<string>();
  const requireTrash = (id: string): TrashEntry => {
    if (!/^\d+-[0-9a-f]{8}$/.test(id)) throw new Error(`回收站条目 id 形态不合（应 <ts>-<hash8>）：${id}`);
    const e = trashStore.get(id);
    if (!e) throw new Error(`回收站条目不存在或已被清理：${id}`);
    return e;
  };
  return {
    readText: async (p) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return {
        path: p,
        text: new TextDecoder().decode(b).replace(/^\uFEFF/, ''),
        encoding: 'utf-8' as const,
        eol: 'lf' as const,
        bom: true,
        mtimeMs: 1,
        hasTrailingNewline: true,
      };
    },
    readTexts: async (paths: readonly string[]) =>
      paths.map((p) => {
        const b = files[p];
        return b
          ? {
              path: p,
              text: new TextDecoder().decode(b).replace(/^\uFEFF/, ''),
              encoding: 'utf-8' as const,
              eol: 'lf' as const,
              mtimeMs: 1,
            }
          : null;
      }),
    readBytes: async (p) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    // 契约 additive（2026-10-16 市场与导入 IO 批）：批量读 = 逐条取 + 失败位 null
    readBytesMany: async (paths: readonly string[]): Promise<Array<Uint8Array | null>> =>
      paths.map((p) => files[p] ?? null),
    writeText: async () => {},
    writeBytes: async (p, data) => {
      files[p] = data;
    },
    ensureDir: async () => {},
    listDir: async (): Promise<DirEntry[]> => [],
    walkDir: async (): Promise<DirEntry[]> => [],
    exists: async (p) => Boolean(files[p]),
    stat: async (p): Promise<FileStat | null> =>
      files[p] ? { size: files[p]!.length, mtimeMs: 1, isDirectory: false } : null,
    setWritableRoots: () => {},
    setAppWritableRoots: () => {},
    addAppWritableRoot: () => {},
    appDataDir: async () => '/appdata',
    rename: async () => { throw new Error('rename is not wired in this fake'); },
    // 契约 additive（2026-10-16 市场与导入 IO 批）：本夹具不提供服务端复制 ⇒ 走到即红
    copyFile: async () => { throw new Error('copyFile is not wired in this fake'); },
    // 契约 additive（2026-10-16 PERF-10b 批量 stat）：本夹具不核落点 ⇒ 走到即红
    statFiles: async () => { throw new Error('statFiles is not wired in this fake'); },
    removeDir: async () => { throw new Error('removeDir is not wired in this fake'); },
    // 契约 additive（2026-10-16 文件树编辑批）：本夹具不提供单文件删除 ⇒ 走到即红
    removeFile: async () => { throw new Error('removeFile is not wired in this fake'); },
    chooseWorkspaceRoot: async () => {
      throw new Error('chooseWorkspaceRoot is not supported by this fake');
    },
    isWritable: () => false,
    backup: async () => null,
    listBackups: async () => [],
    restoreBackup: async () => {
      throw new Error('restoreBackup is not supported by this fake');
    },
    exportFile: async () => {
      throw new Error('exportFile is not supported by this fake');
    },
    // 契约 additive（W11 回收站可见批）：如实可用内存桩（判据注释见方法体）
    listTrash: async (opts?: { forPath?: string }): Promise<TrashEntry[]> =>
      [...trashStore.values()]
        .filter((e) => {
          const fp = opts?.forPath;
          // 相关性简化为前缀判（真实 pathKey 判据住内核）：原路径就是它，或它住在被删目录里
          return fp === undefined || e.originalPath === fp || fp.startsWith(`${e.originalPath}/`);
        })
        .sort((a, b) => b.deletedAtMs - a.deletedAtMs),
    restoreFromTrash: async (id: string): Promise<string> => {
      const e = requireTrash(id);
      if (e.kind === 'dir') throw new Error(`回收站条目 ${id} 是整目录：本夹具不建模子树载荷，拒绝恢复`);
      const bytes = trashPayload.get(id);
      if (!bytes) throw new Error(`回收站条目 ${id} 在本夹具无载荷字节，拒绝恢复`);
      files[e.originalPath] = bytes;
      trashStore.delete(id);
      trashPayload.delete(id); // 条目用掉即消失——回收站不是第二份历史账
      return e.originalPath;
    },
    purgeTrash: async (ids?: readonly string[]): Promise<number> => {
      if (ids === undefined) {
        // 自动清理口径：只动已超保留期的条目，且跳过本会话被 holdTrash 引用的那些
        let n = 0;
        const now = Date.now();
        for (const [id, e] of [...trashStore]) {
          if (e.expiresAtMs <= now && !heldTrash.has(id)) {
            trashStore.delete(id);
            trashPayload.delete(id);
            n++;
          }
        }
        return n;
      }
      // 显式「彻底删除」：命中即删、不看保留期也不看 hold；任一 id 不合形态/不在 ⇒ 抛，不静默跳过
      for (const id of ids) requireTrash(id);
      for (const id of ids) {
        trashStore.delete(id);
        trashPayload.delete(id);
      }
      return ids.length;
    },
    holdTrash: (ids: readonly string[]): void => {
      heldTrash.clear(); // 整替（照 setWritableRoots 的替换口径）
      for (const id of ids) heldTrash.add(id);
    },
  };
}

/**
 * 最小内核替身：只实现本批需要的最小面（服务槽 + 事件总线 + io）。
 * 意图是"接线正确"而非"内核正确"——多要一个槽就抛，让依赖面无法含糊。
 */
function makeKernel(files: Record<string, Uint8Array>) {
  const io = makeIO(files);
  const provided = new Map<string, unknown>();
  const panels: UIPanelContribution[] = [];
  const decorators: EditorDecoratorContribution[] = [];
  const saveHandlers: EditorSaveHandlerContribution[] = [];
  const events: Array<{ type: keyof KernelEventMap; payload: unknown }> = [];
  const listeners = new Map<string, Set<(p: never) => void>>();

  const bus = {
    on(type: string, handler: (p: never) => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
    once(type: string, handler: (p: never) => void) {
      const un = bus.on(type, (p: never) => {
        un();
        handler(p);
      });
      return un;
    },
    emit(type: string, payload: unknown) {
      events.push({ type: type as keyof KernelEventMap, payload });
      for (const h of [...(listeners.get(type) ?? [])]) h(payload as never);
    },
  };

  /** kojo-sugar 的激活上下文（只给它的 requires 三项） */
  const sugarCtx = {
    log,
    inject: (key: string) => {
      if (key === KernelServices.Project) return { current: () => ({ adapterId: 'eratw' }) };
      if (key === KernelServices.Slots)
        return {
          query: (slot: string) =>
            slot === 'game.adapter'
              ? [{ adapter: { gameId: 'eratw', kojoFaceTemplates: createEratwFaceTable() } }]
              : [],
        };
      if (key === KernelServices.IO) return io;
      // 软取目标（state.replay / erb.parser / condition.extractor）缺席是合法情形
      throw new Error(`未注册的服务：${key}`);
    },
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
    bus,
    // kojo-sugar 现在还注册一枚 `ui.editor.languageService` 贡献（转到定义，2026-10-15）——
    // 上下文里得有个槽注册表；本文件断言的是它**提供什么服务**，故注册侧不必记录。
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => fn,
  };

  return { io, provided, panels, decorators, saveHandlers, events, bus, sugarCtx, files, listeners };
}

/** 激活 kojo-sugar，返回它提供的 sugar.transpile 服务 */
function bootSugar(k: ReturnType<typeof makeKernel>): SugarTranspileService {
  createKojoSugarPlugin().activate(k.sugarCtx as never);
  return k.provided.get(WellKnownServices.SugarTranspile) as SugarTranspileService;
}

/** 激活 ui-sugar-editor（只给服务槽 + 内核 io + 总线） */
  function bootEditor(k: ReturnType<typeof makeKernel>) {
    const ctx = {
      pluginId: 'ui-sugar-editor',
      log,
      inject: (key: string): never => {
        if (key === KernelServices.IO) return k.io as never;
        // P2 新增硬依赖：新建向导取角色表（project）与分野模板表（slots）
        if (key === KernelServices.Project)
          return { current: () => ({ adapterId: 'eratw' }) } as never;
        // 反馈 3 批新增硬依赖：新建向导的落点来自工作区（这里只给空工作区，
        // 落盘编排本身的新增用例在 new-file-flow.test.ts）
        if (key === KernelServices.Workspaces)
          return {
            rootDir: () => '/appdata/workspaces',
            list: async () => [],
            get: async () => null,
            projectDir: (id: string) => `/appdata/workspaces/${id}`,
          } as never;
        if (key === KernelServices.Slots)
          return {
            query: (slot: string) =>
              slot === 'game.adapter'
                ? [{ adapter: { gameId: 'eratw', kojoFaceTemplates: createEratwFaceTable() } }]
                : [],
          } as never;
        const v = k.provided.get(key);
        if (v === undefined) throw new Error(`未注册的服务：${key}`);
        return v as never;
      },
    // 可选依赖通道（kernel.ops journal）：测试替身一律缺席 → 插件走自有快照兜底路径
    tryInject: (): undefined => undefined,
    slots: {
      register: (slot: string, contribution: unknown) => {
        if (slot === 'ui.panel') k.panels.push(contribution as UIPanelContribution);
        else if (slot === 'ui.editor.decorator')
          k.decorators.push(contribution as EditorDecoratorContribution);
        else if (slot === 'ui.editor.saveHandler')
          k.saveHandlers.push(contribution as EditorSaveHandlerContribution);
      },
    },
    bus: k.bus,
    onDispose: (fn: unknown) => fn,
  };
  createUiSugarEditorPlugin().activate(ctx as never);
}

/* ============================== 一、接线 ============================== */

describe('S6 / 插件接线（跨插件只走服务槽）', () => {
  it('插件声明：requires 五个服务键，无 provides（纯消费者）', () => {
    const p: Plugin = createUiSugarEditorPlugin();
    expect(p.id).toBe('ui-sugar-editor');
    // 反馈 3 批：落点改工作区 → kernel.workspaces 成为硬依赖（内核常驻服务，恒在）
    expect(p.requires).toEqual([
      'sugar.transpile',
      'kernel.io',
      'kernel.project',
      'kernel.slots',
      'kernel.workspaces',
    ]);
    expect(p.provides ?? []).toEqual([]);
  });

  it('激活后注册 1 个 `ui.editor.decorator`（sugar-diagnostics）+ 1 个 `ui.editor.saveHandler`（sugar-save）+ 1 个 `ui.panel`（sugar-verdict）', () => {
    const k = makeKernel({ [PATH_KOJO]: enc(KOJO_OK) });
    bootSugar(k);
    bootEditor(k);
    expect(k.decorators).toHaveLength(1);
    expect(k.decorators[0]!.id).toBe('sugar-diagnostics');
    expect(typeof k.decorators[0]!.decorate).toBe('function');
    // 装饰热路径批（PERF-4）：声明 offloadKind ⇒ 宿主把整份 `.kojo` 转译请出同步装饰轮。
    // 这条 kind **不在** worker 任务表里（转译器要吃项目内注入的适配器表），宿主走异步就地；
    // 声明它的收益是"同版本重触发零重算"的缓存在这条线上同样生效。
    expect(k.decorators[0]!.offloadKind).toBe('sugar.diagnostics');
    expect(k.saveHandlers).toHaveLength(1);
    expect(k.saveHandlers[0]!.id).toBe('sugar-save');
    expect(typeof k.saveHandlers[0]!.save).toBe('function');
    // `.kojo` 命中、原生 `.ERB` 不命中（接管只在糖源上生效）
    expect(k.saveHandlers[0]!.matches(PATH_KOJO)).toBe(true);
    expect(k.saveHandlers[0]!.matches(PATH_ERB)).toBe(false);
    // `.ERH` 同样不接管：FT-2 让声明文件进面（能拖开 / 进索引 / 有高亮），
    // 但**没有**把它拖进糖线 ⇒ 存盘走内核 io 原样写，产物不回退。
    expect(k.saveHandlers[0]!.matches(PATH_ERH)).toBe(false);
    expect(k.decorators[0]!.decorate({ path: PATH_ERH, text: '#DIM ABL:1\n', project: null })).toEqual([]);
    expect(k.panels).toHaveLength(1);
    expect(k.panels[0]!.id).toBe('sugar-verdict');
    expect(typeof k.panels[0]!.component).toBe('function');
  });

  it('反馈 3 接线：插件订阅 `workspace.projectCreated`（跳去建项目后自动落盘的兑现点）', () => {
    const k = makeKernel({ [PATH_KOJO]: enc(KOJO_OK) });
    bootSugar(k);
    bootEditor(k);
    expect([...k.listeners.keys()]).toContain('workspace.projectCreated');
  });

  it('服务槽顺序：kojo-sugar 先装配 → 编辑器插件才能注入（反序必失败）', () => {
    const k = makeKernel({ [PATH_KOJO]: enc(KOJO_OK) });
    expect(() => bootEditor(k)).toThrow(/未注册的服务：sugar\.transpile/);
  });

  it('`sugar.transpile` 服务键已登记（WellKnownServices）', () => {
    expect(WellKnownServices.SugarTranspile).toBe('sugar.transpile');
  });
});

/* ============================== 二、波浪线（诊断 → 装饰） ============================== */

describe('S6 / 波浪线：`.kojo` 诊断翻成行级装饰', () => {
  const boot = (files: Record<string, Uint8Array>) => {
    const k = makeKernel(files);
    const sugar = bootSugar(k);
    bootEditor(k);
    return { k, sugar, deco: k.decorators[0]! };
  };

  it('坏源 → 返回带行列的装饰，且逐条对应 loc 非空的诊断', () => {
    const { sugar, deco } = boot({ [PATH_KOJO]: enc(KOJO_BAD) });
    const diags = sugar.transpile(KOJO_BAD, { filePath: PATH_KOJO }).diagnostics;
    expect(diags.some((d) => d.code === 'cont-inside-quotes')).toBe(true);

    const out = deco.decorate({ path: PATH_KOJO, text: KOJO_BAD, project: null });
    expect(out.length).toBe(diags.filter((d) => d.loc !== null).length);
    expect(out.length).toBeGreaterThan(0);
    // 诊断在第 3 行 → 装饰也在第 3 行，且携带诊断码
    const hit = out.find((d) => d.code === 'cont-inside-quotes')!;
    expect(hit).toBeDefined();
    expect(hit.line).toBe(3);
    expect(hit.severity).toBe('error');
    expect(hit.startColumn).toBeGreaterThanOrEqual(1);
  });

  it('良构源 → 无 error 装饰（波浪线不无中生有）', () => {
    const { sugar, deco } = boot({ [PATH_KOJO]: enc(KOJO_OK) });
    const diags = sugar.transpile(KOJO_OK, { filePath: PATH_KOJO }).diagnostics;
    const out = deco.decorate({ path: PATH_KOJO, text: KOJO_OK, project: null });
    expect(out.length).toBe(diags.filter((d) => d.loc !== null).length);
    expect(out.some((d) => d.severity === 'error')).toBe(false);
  });

  it('原生 `.ERB` → 装饰为空（波浪线只作用于糖源）', () => {
    const { deco } = boot({ [PATH_ERB]: enc('@FUNCTION\nPRINTFORM 你好\n') });
    const out = deco.decorate({ path: PATH_ERB, text: 'IGNORED', project: null });
    expect(out).toEqual([]);
  });

  it('纯函数纪律：同一输入两次调用结果一致；不读盘不写盘不发事件', () => {
    const { k, deco } = boot({ [PATH_KOJO]: enc(KOJO_BAD) });
    const before = new Uint8Array(k.files[PATH_KOJO]!);
    const a = deco.decorate({ path: PATH_KOJO, text: KOJO_BAD, project: null });
    const b = deco.decorate({ path: PATH_KOJO, text: KOJO_BAD, project: null });
    expect(a).toEqual(b);
    expect(k.files[PATH_KOJO]).toEqual(before);
    expect(k.events).toHaveLength(0);
  });

  it('装饰形状合法：行号 ≥1、severity 在闭集内（宿主可直接消费为 markers）', () => {
    const { deco } = boot({ [PATH_KOJO]: enc(KOJO_BAD) });
    const out: LineDecoration[] = deco.decorate({ path: PATH_KOJO, text: KOJO_BAD, project: null });
    for (const d of out) {
      expect(d.line).toBeGreaterThanOrEqual(1);
      expect(['info', 'warning', 'error']).toContain(d.severity);
      expect(d.message.length).toBeGreaterThan(0);
    }
  });
});