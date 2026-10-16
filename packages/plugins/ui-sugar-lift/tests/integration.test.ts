/**
 * 语法糖就地动作插件验收：**两条路径的端到端接线**（跨插件只走服务槽）。
 *
 * 用户 2026-10-12 口径（两条路径别混）：
 * - **`.kojo`** + 💡 → **改源文件**（可 `Ctrl+Z`）：`codeAction.edits`，宿主 executeEdits 落地；
 * - **`.erb`** + 糖视图 → **只用于看**（零写盘）：`provideLiftProject` 供段，宿主就地渲染。
 *
 * 本文件是**测试**（解耦审计规则 C 对 `tests/` 豁免），故可直接 import 两个插件包来验证接线
 * ——生产代码里它们只能通过服务槽相见。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  EditorCodeAction,
  EditorLiftPreviewContribution,
  FileIO,
  FileStat,
  KernelEventMap,
  Logger,
  Plugin,
  SugarLiftService,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createUiSugarLiftPlugin } from '../src/index';
import { LIFT_MAX_LINES } from '../src/large-file';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
/** 捕获 warn（断言"降级不静默"用；相关测试自行清空） */
const warnings: string[] = [];
const capturingLog: Logger = {
  ...log,
  warn: (m: string) => {
    warnings.push(m);
  },
};
const enc = (s: string) => new TextEncoder().encode(s);

/** 伪内核 io（内存 FS；只读读路径 + 写盘断言用） */
function makeIO(files: Record<string, Uint8Array>) {
  const io: FileIO = {
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
    isWritable: () => true,
    backup: async (p) => (files[p] ? `backup:///${p.replace(/\//g, '_')}.bak` : null),
    listBackups: async () => [],
    restoreBackup: async () => {
      throw new Error('restoreBackup is not supported by this fake');
    },
    exportFile: async () => {
      throw new Error('exportFile is not supported by this fake');
    },
  };
  return io;
}

/**
 * 最小内核替身：只实现本批需要的最小面。
 *
 * 为什么不拉真内核：本测试的意图是"接线正确"而不是"内核正确"。这里把服务槽/事件总线的
 * 契约**降到最小**，反而让"插件依赖了哪些东西"变得无法含糊（`inject` 只给清单里那几项）。
 */
function makeKernel(files: Record<string, Uint8Array>, logger: Logger = log) {
  const io = makeIO(files);
  const provided = new Map<string, unknown>();
  const slots = new Map<string, unknown[]>();
  const events: Array<{ type: keyof KernelEventMap; payload: unknown }> = [];

  const bus = {
    on: () => () => undefined,
    once: () => () => undefined,
    emit(type: string, payload: unknown) {
      events.push({ type: type as keyof KernelEventMap, payload });
    },
  };

  /** kojo-sugar 只需要这几个槽（与它的 requires 一致） */
  const sugarCtx = {
    log: logger,
    inject: (key: string) => {
      if (key === 'kernel.project') return { current: () => ({ adapterId: 'eratw' }) };
      if (key === 'kernel.slots')
        return {
          query: (slot: string) =>
            slot === 'game.adapter'
              ? [{ adapter: { gameId: 'eratw', kojoFaceTemplates: createEratwFaceTable() } }]
              : [],
        };
      if (key === 'kernel.io') return io;
      // **结构扫描**（`erb.parser`）：整文件投影的地基——缺席时投影会降级（控制流原样保留、
      // 段被切碎），故测试提供真实扫描器（与生产装配同源）。
      if (key === 'erb.parser') return { scanControlFlow: (t: string) => scanControlFlow(t) };
      throw new Error(`未注册的服务：${key}`);
    },
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
    bus,
    // kojo-sugar 现在还注册一枚 `ui.editor.languageService` 贡献（转到定义，2026-10-15）
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => fn,
  };

  const panelCtx = {
    log: logger,
    inject: (key: string): never => {
      const v = provided.get(key);
      if (v === undefined && key !== 'kernel.io') throw new Error(`未注册的服务：${key}`);
      if (key === 'kernel.io') return io as never;
      return v as never;
    },
    slots: {
      register: (slot: string, contribution: unknown) => {
        const arr = slots.get(slot) ?? [];
        arr.push(contribution);
        slots.set(slot, arr);
      },
    },
    bus,
    onDispose: (fn: unknown) => fn,
  };

  return { io, provided, slots, events, bus, sugarCtx, panelCtx, files };
}

/** 一份 `.kojo`：头部 + 一个时机 + 两条原生 ERB 直通行（💡 的对象） */
const KOJO = ['角色: 1', '时机 指令 310：', '\tPRINTFORMDW 甲。', '\tPRINTFORMDL 乙。', ''].join('\n');
const KOJO_PATH = '/proj/口上/x.kojo';
const ERB_PATH = '/proj/口上/x.erb';

function bootSugar(k: ReturnType<typeof makeKernel>): SugarLiftService {
  createKojoSugarPlugin().activate(k.sugarCtx as never);
  return k.provided.get(WellKnownServices.SugarLift) as SugarLiftService;
}

function bootPanel(k: ReturnType<typeof makeKernel>): void {
  createUiSugarLiftPlugin().activate(k.panelCtx as never);
}

const previewsOf = (k: ReturnType<typeof makeKernel>) =>
  (k.slots.get('ui.editor.liftPreview') ?? []) as EditorLiftPreviewContribution[];
const actionsOf = (k: ReturnType<typeof makeKernel>) =>
  (k.slots.get('ui.editor.codeAction') ?? []) as Array<{
    id: string;
    provideActions: (f: {
      path: string;
      text: string;
      project: null;
      line?: number;
      lineCount?: number;
    }) => EditorCodeAction[];
  }>;

const boot = (files: Record<string, Uint8Array>) => {
  const k = makeKernel(files);
  bootSugar(k);
  bootPanel(k);
  return k;
};

/* ============================== 一、接线 ============================== */

describe('语法糖就地动作插件 / 接线', () => {
  it('插件声明：只 require 识别服务 + 只读 io；不 provides；不注入写盘服务', () => {
    const p: Plugin = createUiSugarLiftPlugin();
    expect(p.id).toBe('ui-sugar-lift');
    expect(p.requires).toEqual(['sugar.lift', 'kernel.io']);
    expect(p.requires).not.toContain('sugar.liftApply');
    expect(p.provides ?? []).toEqual([]);
  });

  it('注册两槽：liftPreview（含 provideLiftProject）+ codeAction', () => {
    const k = boot({ [KOJO_PATH]: enc(KOJO) });
    expect(previewsOf(k)).toHaveLength(1);
    expect(typeof previewsOf(k)[0]!.provideLiftProject).toBe('function');
    // 逐条候选预览已停用（糖视图取代之）：不再实现该可选方法
    expect(previewsOf(k)[0]!.provideLiftPreview).toBeUndefined();
    expect(actionsOf(k)).toHaveLength(1);
    expect(actionsOf(k)[0]!.id).toBe('sugar-lift.rewrite-action');
    // 面板已按用户要求删除并停止后续开发
    expect(k.slots.get('ui.panel')).toBeUndefined();
  });

  it('服务槽顺序：kojo-sugar 先装配 → 本插件才能注入（反序必失败）', () => {
    const k = makeKernel({ [KOJO_PATH]: enc(KOJO) });
    expect(() => bootPanel(k)).toThrow(/未注册的服务：sugar.lift/);
  });
});

/* ============================== 二、`.kojo` 💡 改写 ============================== */

describe('`.kojo` / 💡 转成 .kojo 写法（改源文件、可撤销）', () => {
  it('光标落在原生 ERB 直通行 → 给出**带 edits** 的动作（宿主 executeEdits 落地）', () => {
    const k = boot({ [KOJO_PATH]: enc(KOJO) });
    const actions = actionsOf(k)[0]!.provideActions({ path: KOJO_PATH, text: KOJO, project: null, line: 3 });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('refactor');
    expect(actions[0]!.title).toContain('转成 .kojo 写法');
    expect(actions[0]!.edits).toBeDefined();
    expect(actions[0]!.edits![0]).toEqual({ fromLine: 3, toLine: 3, newText: '\t甲。' });
  });

  it('缩进补回原层级（改写不改变所在深度）', () => {
    const deep = ['角色: 1', '时机 指令 310：', '    如果 FLAG:1：', '        PRINTFORMDW 甲。', ''].join('\n');
    const k = boot({ [KOJO_PATH]: enc(deep) });
    const actions = actionsOf(k)[0]!.provideActions({ path: KOJO_PATH, text: deep, project: null, line: 4 });
    // 原文缩进是 8 空格 → 替换文本必须仍是 8 空格缩进（相对缩进由候选自带）
    expect(actions[0]!.edits![0]).toEqual({ fromLine: 4, toLine: 4, newText: '        甲。' });
  });

  it('光标不在任何可升糖片段上 → 无动作（💡 不乱出现）', () => {
    const k = boot({ [KOJO_PATH]: enc(KOJO) });
    expect(
      actionsOf(k)[0]!.provideActions({ path: KOJO_PATH, text: KOJO, project: null, line: 1 }),
    ).toEqual([]);
  });

  it('**`.erb` 不给改写动作**（它恒只读 / 解锁后糖视图关闭，改它没有意义）', () => {
    const k = boot({ [ERB_PATH]: enc(KOJO) });
    expect(
      actionsOf(k)[0]!.provideActions({ path: ERB_PATH, text: KOJO, project: null, line: 3 }),
    ).toEqual([]);
  });

  it('行号未知（无 `line`）→ 不给动作', () => {
    const k = boot({ [KOJO_PATH]: enc(KOJO) });
    expect(actionsOf(k)[0]!.provideActions({ path: KOJO_PATH, text: KOJO, project: null })).toEqual([]);
  });
});

/* ============================== 三、`.erb` 糖视图供给 ============================== */

describe('`.erb` / 整文件糖视图供给（只用于看，零写盘）', () => {
  const ERB_FULL = [
    '; 分节标记',
    'IF TALENT:TARGET:恋慕',
    '\tPRINTFORMW 「%CALLNAME:MASTER%，今天也来训练了？」',
    '\tPRINTFORMDL 她别开了脸。',
    'ENDIF',
    '@FUNC',
    '#DIM X',
  ].join('\n');

  it('一个连续段：控制流 + 台词 + 注释透传 + 反糖；`@`/`#DIM` 切断', () => {
    const k = boot({ [ERB_PATH]: enc(ERB_FULL) });
    const items = previewsOf(k)[0]!.provideLiftProject!({
      path: ERB_PATH,
      text: ERB_FULL,
      project: null,
    });
    expect(items).toHaveLength(1);
    expect(`${items[0]!.fromLine}-${items[0]!.toLine}`).toBe('1-5');
    expect(items[0]!.sugarText.split('\n')).toEqual([
      '; 分节标记',
      '如果 TALENT:TARGET:恋慕：',
      '\t「{你}，今天也来训练了？」',
      '\t她别开了脸。 续',
    ]);
  });

  it('`.kojo` 不供给投影（它本身就是糖）', () => {
    const k = boot({ [KOJO_PATH]: enc(KOJO) });
    expect(previewsOf(k)[0]!.provideLiftProject!({ path: KOJO_PATH, text: KOJO, project: null })).toEqual(
      [],
    );
  });

  it('两条路径**全程零写盘**：跑完源文件逐字节不变、不发任何事件', () => {
    const k = boot({ [ERB_PATH]: enc(ERB_FULL), [KOJO_PATH]: enc(KOJO) });
    const beforeErb = new Uint8Array(k.files[ERB_PATH]!);
    const beforeKojo = new Uint8Array(k.files[KOJO_PATH]!);
    previewsOf(k)[0]!.provideLiftProject!({ path: ERB_PATH, text: ERB_FULL, project: null });
    actionsOf(k)[0]!.provideActions({ path: KOJO_PATH, text: KOJO, project: null, line: 3 });
    expect(k.events).toEqual([]);
    expect(k.files[ERB_PATH]).toEqual(beforeErb);
    expect(k.files[KOJO_PATH]).toEqual(beforeKojo);
  });
});

/* ================= 三、超长文件降级（合流批：守卫接回存活路径） ================= */

/**
 * 两线合流的处理（口上项目/内核优化批的 `large-file.ts` 判据，语法糖批 A 删面板后无宿主消费）：
 * **判据原样保留，接到本线唯一剩下的自动触发路径上** —— `.kojo` 的 💡 可用性探测
 * 由 Monaco 在光标 / 选区变化时反复调用，而其判据是整篇 round-trip 自证
 * （实测 52,601 行的真实文件 **231 ms**）→ 降级 + **告警可见**，不静默。
 *
 * 注意糖视图那条路径**不套这个阈值**：`liftProject` 是逐行局部映射（实测整篇 2,285 文件
 * 约 9 s，即千行级 ~4 ms），而 5,000 行以上的文件恰恰是读者最想要"像剧本一样读懂"的那些。
 */
describe('超长文件降级：`.kojo` 💡 自动路径让路，显式信息缺失时自己数', () => {
  const huge = (lines: number): string =>
    Array.from({ length: lines }, (_, i) => (i === 2 ? 'PRINTFORMDW 甲。' : ';占位注释')).join('\n');

  const act = (text: string, lineCount?: number): EditorCodeAction[] => {
    warnings.length = 0;
    const k = makeKernel({ [KOJO_PATH]: enc(text) }, capturingLog);
    bootSugar(k);
    bootPanel(k);
    return actionsOf(k)[0]!.provideActions({
      path: KOJO_PATH,
      text,
      project: null,
      line: 3,
      ...(lineCount === undefined ? {} : { lineCount }),
    });
  };

  it('未超限的小文件 → 照常给动作（守卫不误伤日常编辑）', () => {
    expect(act(KOJO, KOJO.split('\n').length)).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('超过 `LIFT_MAX_LINES` → 不给动作，且**告警可见**（内核铁律：不许静默降级）', () => {
    expect(act(huge(LIFT_MAX_LINES + 1), LIFT_MAX_LINES + 1)).toHaveLength(0);
    expect(warnings.join('\n')).toContain('已跳过整篇 .kojo 候选扫描');
  });

  it('宿主没给 `lineCount` → 自己数行数，同样让路（不因信息缺失而白扫一遍）', () => {
    expect(act(huge(LIFT_MAX_LINES + 2))).toHaveLength(0);
    expect(warnings.join('\n')).toContain('已跳过整篇 .kojo 候选扫描');
  });

  it('边界含等号：恰好到上限不降级（与 `large-file.ts` 的纯函数口径一致）', () => {
    expect(act(huge(LIFT_MAX_LINES), LIFT_MAX_LINES)).toHaveLength(1);
  });

  it('同一文件只告警一次（探测是高频调用，日志不能被刷屏）', () => {
    const text = huge(LIFT_MAX_LINES + 1);
    const k = makeKernel({ [KOJO_PATH]: enc(text) }, capturingLog);
    bootSugar(k);
    bootPanel(k);
    const provide = actionsOf(k)[0]!.provideActions;
    warnings.length = 0;
    for (let i = 0; i < 5; i++) provide({ path: KOJO_PATH, text, project: null, line: 3, lineCount: LIFT_MAX_LINES + 1 });
    expect(warnings).toHaveLength(1);
  });
});
