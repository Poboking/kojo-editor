/**
 * W3「`.kojo` 的波浪线真的有修法」端到端验收：真转译器 + 真槽位接线。
 *
 * 本文件是**测试**（解耦审计规则 C 对 `tests/` 豁免），故直接装真转译器 + 本插件，
 * 用一枚受控的 refactor 供方验"quickfix 与其他 refactor 类动作在同一份文档里各归各类"。
 *
 * 钉住的五件事：
 * 1. 真转译器的 `stray-percent` / `function-name-typo` 波浪线**确实**换来 `kind:'quickfix'`；
 * 2. 动作关联的诊断与面上那条装饰**同一个对象**（B9 身份键：同行同 code 同 message）；
 * 3. 不在闭集里的码（`cont-inside-quotes`）**不产**动作——不猜；
 * 4. 与 refactor 类动作**共存**：类别不串、只有 quickfix 认领波浪线（不顶替、不重复计数）；
 * 5. 全程**零写盘、零事件**、不越界，且**没有可修红线时一次整篇转译都不多跑**。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  EditorCodeActionContribution,
  EditorDecoratorContribution,
  FileIO,
  FileStat,
  LineDecoration,
  Logger,
  SugarTranspileService,
  TrashEntry,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createUiSugarEditorPlugin } from '../src/index';
import { decorationKey } from '../src/kojo-quickfix';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const warnings: string[] = [];
const capturingLog: Logger = { ...log, warn: (m: string) => warnings.push(m) };
const enc = (s: string) => new TextEncoder().encode(s);

const PATH = '/proj/口上/x.kojo';

/**
 * 转译服务的缓存读数（实现侧 additive 面，**不在契约里** ⇒ 本测试按最小形状自取）。
 * 用它来断言"没有可修红线时一次整篇转译都不多跑"——比墙钟稳。
 */
interface SugarCacheStats {
  readonly hits: number;
  readonly misses: number;
}

/** 落盘被调用 = 本测试直接红（快速修复只改 model） */
function makeIO(files: Record<string, Uint8Array>, writes: string[], writable = true): FileIO {
  const boom = (name: string) => () => {
    writes.push(name);
    throw new Error(`快速修复不该写盘：${name}`);
  };
  // W11 回收站**如实可用**假桩（内存条目表；口径照 io.ts :293/:310/:324/:330 原文）：
  // listTrash 返回空清单/筛选清单；restore/purge 对未知或形态不合的 id **按契约文本拒绝**；
  // holdTrash 是会话内软保护（整替语义、纯内存、不落盘、拦不住显式 purge）。
  // 注意：回收站是管理性通道，不属于「快速修复写盘」口径 ⇒ restore/purge 不进 writes 记账。
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
    readTexts: async (paths) =>
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
    readBytesMany: async (paths) => paths.map((p) => files[p] ?? null),
    writeText: boom('writeText') as FileIO['writeText'],
    writeBytes: boom('writeBytes') as FileIO['writeBytes'],
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
    rename: async () => {
      throw new Error('rename is not wired in this fake');
    },
    copyFile: async () => {
      throw new Error('copyFile is not wired in this fake');
    },
    statFiles: async () => {
      throw new Error('statFiles is not wired in this fake');
    },
    removeDir: async () => {
      throw new Error('removeDir is not wired in this fake');
    },
    removeFile: async () => {
      throw new Error('removeFile is not wired in this fake');
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
    chooseWorkspaceRoot: async () => {
      throw new Error('chooseWorkspaceRoot is not supported by this fake');
    },
    isWritable: () => writable,
    backup: async () => null,
    listBackups: async () => [],
    restoreBackup: async () => {
      throw new Error('restoreBackup is not supported by this fake');
    },
    exportFile: async () => {
      throw new Error('exportFile is not supported by this fake');
    },
  };
}

interface Harness {
  sugar: SugarTranspileService;
  codeActions: EditorCodeActionContribution[];
  decorators: EditorDecoratorContribution[];
  files: Record<string, Uint8Array>;
  writes: string[];
  events: Array<{ type: string; payload: unknown }>;
}

/** 装真转译器 + 激活 ui-sugar-editor（本批主角） */
function boot(source: string, options: { writable?: boolean } = {}): Harness {
  const writable = options.writable ?? true;
  const files: Record<string, Uint8Array> = { [PATH]: enc(source) };
  const writes: string[] = [];
  const events: Array<{ type: string; payload: unknown }> = [];
  const io = makeIO(files, writes, writable);
  const provided = new Map<string, unknown>();
  const codeActions: EditorCodeActionContribution[] = [];
  const decorators: EditorDecoratorContribution[] = [];

  const bus = {
    on: () => () => undefined,
    once: () => () => undefined,
    emit(type: string, payload: unknown) {
      events.push({ type, payload });
    },
  };

  const slotsQuery = (slot: string) =>
    slot === 'game.adapter'
      ? [{ adapter: { gameId: 'eratw', kojoFaceTemplates: createEratwFaceTable() } }]
      : [];

  const sugarCtx = {
    log,
    inject: (key: string) => {
      if (key === KernelServices.Project) return { current: () => ({ adapterId: 'eratw' }) };
      if (key === KernelServices.Slots) return { query: slotsQuery };
      if (key === KernelServices.IO) return io;
      if (key === 'erb.parser') return { scanControlFlow: (t: string) => scanControlFlow(t) };
      throw new Error(`未注册的服务：${key}`);
    },
    provide: (key: string, value: unknown) => provided.set(key, value),
    bus,
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => fn,
  };
  createKojoSugarPlugin().activate(sugarCtx as never);
  const sugar = provided.get(WellKnownServices.SugarTranspile) as SugarTranspileService;

  const editorCtx = {
    pluginId: 'ui-sugar-editor',
    log: capturingLog,
    inject: (key: string): never => {
      if (key === KernelServices.IO) return io as never;
      if (key === KernelServices.Project) return { current: () => ({ adapterId: 'eratw' }) } as never;
      if (key === KernelServices.Workspaces)
        return {
          rootDir: () => '/appdata/workspaces',
          list: async () => [],
          get: async () => null,
          projectDir: (id: string) => `/appdata/workspaces/${id}`,
        } as never;
      if (key === KernelServices.Slots) return { query: slotsQuery } as never;
      const v = provided.get(key);
      if (v === undefined) throw new Error(`未注册的服务：${key}`);
      return v as never;
    },
    tryInject: (): undefined => undefined,
    slots: {
      register: (slot: string, contribution: unknown) => {
        if (slot === 'ui.editor.codeAction') codeActions.push(contribution as EditorCodeActionContribution);
        else if (slot === 'ui.editor.decorator') decorators.push(contribution as EditorDecoratorContribution);
      },
    },
    bus,
    onDispose: (fn: unknown) => fn,
  };
  createUiSugarEditorPlugin().activate(editorCtx as never);

  return { sugar, codeActions, decorators, files, writes, events };
}

/** 面上那些波浪线（就是宿主 `documentDiagnostics` 干的事：问 decorator 槽全部贡献） */
function markers(h: Harness, source: string): LineDecoration[] {
  return h.decorators.flatMap((c) => c.decorate({ path: PATH, text: source, project: null }));
}

/** 问 `ui.editor.codeAction` 全部贡献（宿主 `documentQuickFixes` 的同款动作） */
function provideAll(
  h: Harness,
  source: string,
  opts: { line?: number; scope?: 'range' | 'document' } = {},
) {
  const diagnostics = markers(h, source);
  const out: Array<{ contributionId: string; action: ReturnType<EditorCodeActionContribution['provideActions']>[number] }> = [];
  for (const contribution of h.codeActions) {
    for (const action of contribution.provideActions({
      path: PATH,
      text: source,
      project: null,
      diagnostics,
      lineCount: source.split('\n').length,
      ...(opts.line !== undefined ? { line: opts.line } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    })) {
      out.push({ contributionId: contribution.id, action });
    }
  }
  return { diagnostics, out };
}

/* 一条 `stray-percent`（warning，本行恰好一个半角 %）+ 一条原生 ERB 直通行（改写法那类动作的对象） */
const SRC_STRAY = ['角色: 1', '时机 指令 310：', '    旁白 50% 吧。', '\tPRINTFORMDW 甲。', ''].join('\n');
/** 改好后的那一行（全角 ％） */
const STRAY_FIXED_LINE = '    旁白 50％ 吧。';

/* 一条 `function-name-typo`（error，唯一近名「最大值」） */
const SRC_TYPO = ['角色: 1', '时机 指令 310：', '    调用 最大直(1, 2)', ''].join('\n');

/* 非闭集码：`续` 写在引号内（error，但文案给了两条出路 ⇒ 本批不动手） */
const SRC_QUOTES = ['角色: 1', '时机 指令 310：', '    「你好。续」', ''].join('\n');

describe('W3 / 真转译器：`.kojo` 波浪线换来 quickfix', () => {
  it('注册了 `ui.editor.codeAction`（id sugar-quickfix）', () => {
    const h = boot(SRC_STRAY);
    const ids = h.codeActions.map((c) => c.id);
    expect(ids).toContain('sugar-quickfix');
  });

  it('stray-percent：产 kind:quickfix，edits 落地后整篇再转译那条红线消失', () => {
    const h = boot(SRC_STRAY);
    const { diagnostics, out } = provideAll(h, SRC_STRAY, { scope: 'document' });
    const target = diagnostics.find((d) => d.code === 'stray-percent')!;
    expect(target).toBeDefined();

    const fixes = out.filter((x) => x.action.kind === 'quickfix');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.contributionId).toBe('sugar-quickfix');
    expect(fixes[0]!.action.edits).toHaveLength(1);

    // 代回模型：把 edit 应用到文本上（宿主 executeEdits 的同款行替换语义）
    const fixed = applyEdit(SRC_STRAY, fixes[0]!.action.edits![0]!);
    expect(fixed.split('\n')[target.line - 1]).toBe(STRAY_FIXED_LINE);
    expect(markers(h, fixed).some((d) => d.code === 'stray-percent')).toBe(false);
  });

  it('function-name-typo：error 级也修得了（改完本行换成唯一近名，该码整篇归零）', () => {
    const h = boot(SRC_TYPO);
    const diags = h.sugar.transpile(SRC_TYPO, { filePath: PATH }).diagnostics;
    expect(diags.some((d) => d.code === 'function-name-typo')).toBe(true);

    const { diagnostics, out } = provideAll(h, SRC_TYPO, { scope: 'document' });
    const target = diagnostics.find((d) => d.code === 'function-name-typo')!;
    expect(target).toBeDefined();
    const fixes = out.filter((x) => x.action.kind === 'quickfix' && !x.action.title.includes('登记'));
    expect(fixes).toHaveLength(1);

    const fixed = applyEdit(SRC_TYPO, fixes[0]!.action.edits![0]!);
    expect(fixed.split('\n')[target.line - 1]).toBe('    调用 最大值(1, 2)');
    expect(markers(h, fixed).some((d) => d.code === 'function-name-typo')).toBe(false);
  });

  it('闭集外的码（cont-inside-quotes）不产动作——宁可不修也不猜', () => {
    const h = boot(SRC_QUOTES);
    const { diagnostics, out } = provideAll(h, SRC_QUOTES, { scope: 'document' });
    expect(diagnostics.some((d) => d.code === 'cont-inside-quotes')).toBe(true);
    expect(out.filter((x) => x.action.kind === 'quickfix')).toEqual([]);
  });

  it('宿主没递波浪线（旧宿主 / 区间无红线）⇒ 一条 quickfix 都不造', () => {
    const h = boot(SRC_STRAY);
    const quickfix = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    expect(
      quickfix.provideActions({ path: PATH, text: SRC_STRAY, project: null, diagnostics: [], scope: 'document' }),
    ).toEqual([]);
    expect(quickfix.provideActions({ path: PATH, text: SRC_STRAY, project: null })).toEqual([]);
  });

  it('非 `.kojo`（原生 ERB）不应答：本贡献只对糖源供动作', () => {
    const h = boot(SRC_STRAY);
    const quickfix = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    const erb = 'PRINTFORMW 你好 50% 吧。\n';
    expect(
      quickfix.provideActions({
        path: '/proj/口上/x.ERB',
        text: erb,
        project: null,
        diagnostics: [{ line: 1, severity: 'warning', message: 'x', code: 'stray-percent' }],
      }),
    ).toEqual([]);
  });

  it('写允许域之外的 `.kojo`（只读）不给改写动作——与 erb-structure-fix / convention-linter 同一条保守口径', () => {
    const h = boot(SRC_STRAY, { writable: false });
    const quickfix = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    const diagnostics = markers(h, SRC_STRAY);
    expect(diagnostics.some((d) => d.code === 'stray-percent')).toBe(true);
    expect(
      quickfix.provideActions({ path: PATH, text: SRC_STRAY, project: null, diagnostics, scope: 'document' }),
    ).toEqual([]);
  });
});

describe('W3 / B9 身份键：动作关联的就是面上那一条', () => {
  it('quickfix 的 diagnostics 与那条波浪线**同一引用**、同 severity/line/code/message', () => {
    const h = boot(SRC_STRAY);
    const { diagnostics, out } = provideAll(h, SRC_STRAY, { scope: 'document' });
    const target = diagnostics.find((d) => d.code === 'stray-percent')!;
    const linked = out.find((x) => x.action.kind === 'quickfix')!.action.diagnostics!;
    expect(linked).toHaveLength(1);
    expect(linked[0]).toBe(target);
    expect(decorationKey(linked[0]!)).toBe(decorationKey(target));
    expect([linked[0]!.line, linked[0]!.code, linked[0]!.message, linked[0]!.severity]).toEqual([
      target.line,
      target.code,
      target.message,
      target.severity,
    ]);
  });

  it('区间请求（💡 / Ctrl+.，只递那一条红线）也只应答那一条', () => {
    const h = boot(SRC_STRAY);
    const quickfix = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    const all = markers(h, SRC_STRAY);
    const onLine3 = all.filter((d) => d.line === 3);
    const actions = quickfix.provideActions({
      path: PATH,
      text: SRC_STRAY,
      project: null,
      line: 3,
      diagnostics: onLine3,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.diagnostics!.every((d) => d.line === 3)).toBe(true);
    // 反过来：区间里没有这条红线 ⇒ 不答（不越区间去修别处的诊断）
    expect(
      quickfix.provideActions({
        path: PATH,
        text: SRC_STRAY,
        project: null,
        line: 4,
        diagnostics: all.filter((d) => d.line !== 3),
      }),
    ).toEqual([]);
  });
});

describe('W3 / 与 refactor 类动作共存：各归各类、不互相顶替', () => {
  /**
   * 一枚**受控**的 refactor 供方（形状 = 任何宿主侧改写动作）。
   * 断言只绑本批唯一相关的两件事：**类别**与**认领**，不依赖别线产量。
   */
  const refactorStub = (line: number): EditorCodeActionContribution => ({
    id: 'stub.rewrite-action',
    provideActions: ({ line: at }) =>
      at === line
        ? [
            {
              title: '转成 .kojo 写法（片段·可 Ctrl+Z 撤回）',
              kind: 'refactor',
              edits: [{ fromLine: line, toLine: line, newText: '    甲。' }],
              run: () => undefined,
            },
          ]
        : [],
  });

  it('同一次请求里 quickfix 与 refactor 各一条：类别不串、认领不重复计数', () => {
    const h = boot(SRC_STRAY);
    const rawLine = SRC_STRAY.split('\n').findIndex((l) => l.includes('PRINTFORMDW')) + 1;
    h.codeActions.push(refactorStub(rawLine));
    const { out } = provideAll(h, SRC_STRAY, { line: rawLine });
    const quick = out.filter((x) => x.action.kind === 'quickfix');
    const refactor = out.filter((x) => x.action.kind === 'refactor');
    // 认领波浪线的只有 quickfix 这一类
    expect(quick.map((x) => x.contributionId)).toEqual(['sugar-quickfix']);
    expect(refactor.map((x) => x.contributionId)).toContain('stub.rewrite-action');
    const stubAction = refactor.find((x) => x.contributionId === 'stub.rewrite-action')!.action;
    // **只有 quickfix 带关联诊断**：宿主 `quickFixOwnership` 据此把 refactor 排除在
    // "某条红线的解"之外 ⇒ 一条红线只算一个解（不互相顶替、不重复计数）
    expect(quick[0]!.action.diagnostics).toHaveLength(1);
    expect(stubAction.diagnostics).toBeUndefined();
    expect(quick[0]!.action.edits).toHaveLength(1);
    expect(stubAction.edits).toHaveLength(1);
    // 两条动作改的是**不同行**（红线在第 3 行、写法在第 4 行）⇒ 宿主合批时不会相撞
    expect(quick[0]!.action.edits![0]!.fromLine).toBe(3);
    expect(stubAction.edits![0]!.fromLine).toBe(rawLine);
  });

  it('本批供方只交 quickfix 类：宿主按类别分工，不会冒出 refactor', () => {
    const h = boot(SRC_STRAY);
    const rawLine = SRC_STRAY.split('\n').findIndex((l) => l.includes('PRINTFORMDW')) + 1;
    const quick = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    const mine = quick.provideActions({
      path: PATH,
      text: SRC_STRAY,
      project: null,
      line: rawLine,
      diagnostics: markers(h, SRC_STRAY),
    });
    expect(mine).toHaveLength(1);
    expect(mine.every((a) => a.kind === 'quickfix')).toBe(true);
  });
});

describe('W3 / 纪律：只改 model、不越界、不写盘', () => {
  it('每条 edits 行号在 [1, 行数] 内；行级改写是整行替换（不改行数），登记动作恰好多出一行声明', () => {
    const h = boot(SRC_TYPO);
    const { out } = provideAll(h, SRC_TYPO, { scope: 'document' });
    const lineCount = SRC_TYPO.split('\n').length;
    const quick = out.filter((x) => x.action.kind === 'quickfix');
    expect(quick.length).toBeGreaterThan(1); // 改近名 + 登记，两条并存
    for (const { action } of quick) {
      for (const edit of action.edits!) {
        expect(edit.fromLine).toBe(edit.toLine);
        expect(edit.fromLine).toBeGreaterThanOrEqual(1);
        expect(edit.toLine).toBeLessThanOrEqual(lineCount);
        const added = edit.newText.split('\n');
        if (action.title.includes('登记')) {
          expect(added[0]).toMatch(/^函数 /); // 插的那行声明在第 0 列、块头形
          expect(added).toHaveLength(2); // 声明行 + 锚行原文整条带走
        } else {
          expect(added).toHaveLength(1); // 行级改写不改行数 ⇒ 行号坐标系不漂移
        }
      }
    }
  });

  it('供动作全程零写盘、零事件、磁盘内容逐字节未变', () => {
    const h = boot(SRC_STRAY);
    const before = new Uint8Array(h.files[PATH]!);
    provideAll(h, SRC_STRAY, { scope: 'document' });
    provideAll(h, SRC_STRAY, { line: 3 });
    expect(h.writes).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.files[PATH]).toEqual(before);
  });

  it('没有可修红线时**不重跑整篇转译**（💡 探测由 Monaco 自动触发；闭集筛在基准转译之前）', () => {
    const h = boot(SRC_QUOTES); // 只有 cont-inside-quotes（闭集外）
    const stats = () =>
      (h.sugar as unknown as { transpileCacheStats(): SugarCacheStats }).transpileCacheStats();
    const before = stats();
    const quickfix = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    const diagnostics = markers(h, SRC_QUOTES);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(quickfix.provideActions({ path: PATH, text: SRC_QUOTES, project: null, diagnostics })).toEqual([]);
    const after = stats();
    // 缓存计数一格没动 ⇒ 本贡献一次整篇转译都没多跑（基准转译只在真有候选时才要）
    expect(after.hits).toBe(before.hits);
    expect(after.misses).toBe(before.misses);
  });

  it('同输入两次供动作结果一致（纯函数；自证的额外转译不改任何状态）', () => {
    const h = boot(SRC_STRAY);
    const a = JSON.stringify(provideAll(h, SRC_STRAY, { scope: 'document' }).out);
    const b = JSON.stringify(provideAll(h, SRC_STRAY, { scope: 'document' }).out);
    expect(a).toBe(b);
  });

  it('自证不过关就不交付：把 `%%` 这种"改了也不消红线"的行交出去之前先问过转译器', () => {
    // `50%%` 是成对的变量记号（偶数个 %）⇒ 转译器本就不报 stray-percent；
    // 这里再钉一次：**没有对应红线的行**不会被凭空改写。
    const h = boot(SRC_STRAY);
    const text = SRC_STRAY.replace('50%', '50%%');
    const quick = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    const actions = quick.provideActions({
      path: PATH,
      text,
      project: null,
      diagnostics: markers(h, text),
      scope: 'document',
    });
    expect(actions).toEqual([]);
  });
});

/* ------------------------------ ZH-F2 · 真转译器：未收录名一键登记进名表 ------------------------------ */

/** 两表皆无、也没有近名的自定义名（判据在真语料表上跑，不在本测试自判） */
const CUSTOM = '嘎啦咕噜呓语';
const SRC_UNKNOWN = ['角色: 1', '时机 指令 310：', `    调用 ${CUSTOM}(7)`, ''].join('\n');

describe('ZH-F2 / 真转译器：`function-name-unknown` 换来登记动作，登记后同一条管线归零', () => {
  const registerActionOf = (h: Harness, source: string) => {
    const { diagnostics, out } = provideAll(h, source, { scope: 'document' });
    const target = diagnostics.find((d) => d.code === 'function-name-unknown');
    const reg = out.find((x) => x.action.kind === 'quickfix' && x.action.title.includes('登记'));
    return { diagnostics, target, reg };
  };

  it('登记前 warning 在面上；动作把 `函数 <名>(引数1)：` 插到第一个时机块之前，登记后**真转译**该码消失且无新波浪线', () => {
    const h = boot(SRC_UNKNOWN);
    const before = markers(h, SRC_UNKNOWN);
    expect(before.filter((d) => d.code === 'function-name-unknown')).toHaveLength(1);

    const { target, reg } = registerActionOf(h, SRC_UNKNOWN);
    expect(target).toBeDefined();
    expect(reg).toBeDefined();
    expect(reg!.contributionId).toBe('sugar-quickfix');
    const edit = reg!.action.edits![0]!;
    expect(edit.newText).toBe(`函数 ${CUSTOM}(引数1)：\n时机 指令 310：`);

    const fixed = applyEdit(SRC_UNKNOWN, edit);
    const after = markers(h, fixed);
    expect(after.some((d) => d.code === 'function-name-unknown')).toBe(false);
    expect(after.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(after.length).toBeLessThanOrEqual(before.length);
    // 真管线吃了这份名表：调用降到产物名（adapter 模板），不是本地打勾
    expect(h.sugar.transpile(fixed, { filePath: PATH }).erb).toContain(`M_KOJO_K1_${CUSTOM}(7)`);
  });

  it('已有「函数」块 ⇒ 声明聚堆插在最后一块之后；登记后同样归零', () => {
    const source = ['角色: 1', '函数 开场()：', '    返回', '时机 指令 310：', `    调用 ${CUSTOM}(7)`, ''].join('\n');
    const h = boot(source);
    expect(markers(h, source).some((d) => d.code === 'function-name-unknown')).toBe(true);
    const { reg } = registerActionOf(h, source);
    expect(reg).toBeDefined();
    expect(reg!.action.edits![0]!.fromLine).toBe(4);
    const fixed = applyEdit(source, reg!.action.edits![0]!);
    expect(markers(h, fixed).some((d) => d.code === 'function-name-unknown')).toBe(false);
  });

  it('typo 那一条也有"我确实要这个名字"支：登记动作落地后 error 级的 `function-name-typo` 消失（该文件恢复可编译）', () => {
    const h = boot(SRC_TYPO);
    const { out } = provideAll(h, SRC_TYPO, { scope: 'document' });
    const reg = out.find((x) => x.action.kind === 'quickfix' && x.action.title.includes('登记'));
    expect(reg).toBeDefined();
    expect(reg!.action.edits![0]!.newText).toBe('函数 最大直(引数1, 引数2)：\n时机 指令 310：');
    const fixed = applyEdit(SRC_TYPO, reg!.action.edits![0]!);
    const after = markers(h, fixed);
    expect(after.some((d) => d.code === 'function-name-typo')).toBe(false);
    expect(after.some((d) => d.code === 'function-name-unknown')).toBe(false);
  });

  it('登记动作全程零写盘、零事件（与行级改写同一条 model-only 通道）', () => {
    const h = boot(SRC_UNKNOWN);
    const before = new Uint8Array(h.files[PATH]!);
    registerActionOf(h, SRC_UNKNOWN);
    expect(h.writes).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.files[PATH]).toEqual(before);
  });

  it('只读文件（写允许域外）不给登记动作——接线层那道写闸覆盖新动作形态', () => {
    const h = boot(SRC_UNKNOWN, { writable: false });
    const quick = h.codeActions.find((c) => c.id === 'sugar-quickfix')!;
    expect(
      quick.provideActions({
        path: PATH,
        text: SRC_UNKNOWN,
        project: null,
        diagnostics: markers(h, SRC_UNKNOWN),
        scope: 'document',
      }),
    ).toEqual([]);
  });
});

/* ------------------------------ 夹具：宿主 executeEdits 的同款行替换 ------------------------------ */

function applyEdit(text: string, edit: { fromLine: number; toLine: number; newText: string }): string {
  const lines = text.split('\n');
  lines.splice(edit.fromLine - 1, edit.toLine - edit.fromLine + 1, ...edit.newText.split('\n'));
  return lines.join('\n');
}
