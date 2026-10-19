/**
 * 语法糖只读投影插件验收：**`.erb` 糖视图的端到端接线**（跨插件只走服务槽）。
 *
 * 用户 2026-10-19 口径：`.kojo` 的写回建议（💡「转成 .kojo 写法」）已删除——
 * 升糖识别不可靠时，写回等于把作者的源文件改坏；本插件只保留
 * **`.erb` 糖视图（只用于看、零写盘）**，底层 `sugar.lift` 识别引擎照旧提供。
 *
 * 本文件是**测试**（解耦审计规则 C 对 `tests/` 豁免），故可直接 import 两个插件包来验证接线
 * ——生产代码里它们只能通过服务槽相见。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  EditorLiftPreviewContribution,
  FileIO,
  FileStat,
  KernelEventMap,
  Logger,
  Plugin,
  SugarLiftService,
  TrashEntry,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createUiSugarLiftPlugin } from '../src/index';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const enc = (s: string) => new TextEncoder().encode(s);

/** 伪内核 io（内存 FS；只读路径） */
function makeIO(files: Record<string, Uint8Array>) {
  const trashStore = new Map<string, TrashEntry>();
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
    listTrash: async (): Promise<TrashEntry[]> => [...trashStore.values()],
    restoreFromTrash: async (id: string): Promise<string> => {
      throw new Error(`回收站条目不存在或已被清理：${id}`);
    },
    purgeTrash: async (): Promise<number> => 0,
    holdTrash: (): void => {},
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
    slots: { register: () => () => undefined },
    onDispose: (fn: unknown) => fn,
  };

  const panelCtx = {
    pluginId: 'ui-sugar-lift',
    log: logger,
    inject: (key: string): never => {
      const v = provided.get(key);
      if (v === undefined) throw new Error(`未注册的服务：${key}`);
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

/** 一份 `.kojo`（本身即糖；不供给投影） */
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

const boot = (files: Record<string, Uint8Array>) => {
  const k = makeKernel(files);
  bootSugar(k);
  bootPanel(k);
  return k;
};

/* ============================== 一、接线 ============================== */

describe('语法糖只读投影插件 / 接线', () => {
  it('插件声明：只 require 识别服务；不 provides；不注册 codeAction', () => {
    const p: Plugin = createUiSugarLiftPlugin();
    expect(p.id).toBe('ui-sugar-lift');
    expect(p.requires).toEqual(['sugar.lift']);
    expect(p.provides ?? []).toEqual([]);
  });

  it('只注册 liftPreview（含 provideLiftProject）；写回动作槽一枚都不注册', () => {
    const k = boot({ [KOJO_PATH]: enc(KOJO) });
    expect(previewsOf(k)).toHaveLength(1);
    expect(typeof previewsOf(k)[0]!.provideLiftProject).toBe('function');
    expect(previewsOf(k)[0]!.provideLiftPreview).toBeUndefined();
    expect(k.slots.get('ui.editor.codeAction')).toBeUndefined();
    expect(k.slots.get('ui.panel')).toBeUndefined();
  });

  it('服务槽顺序：kojo-sugar 先装配 → 本插件才能注入（反序必失败）', () => {
    const k = makeKernel({ [KOJO_PATH]: enc(KOJO) });
    expect(() => bootPanel(k)).toThrow(/未注册的服务：sugar.lift/);
  });
});

/* ============================== 二、`.erb` 糖视图供给 ============================== */

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

  it('真糖段一个连续段：控制流 + 台词 + 注释透传 + 反糖；`@`/`#DIM` 切断并自带 nativeOnly 兜底段', () => {
    const k = boot({ [ERB_PATH]: enc(ERB_FULL) });
    const items = previewsOf(k)[0]!.provideLiftProject!({
      path: ERB_PATH,
      text: ERB_FULL,
      project: null,
    });
    // ① 1–5 真糖段；② 6–7 = `@FUNC`/`#DIM` 的 nativeOnly 兜底段（ZH-P 批：native 行显式上屏）
    expect(items).toHaveLength(2);
    expect(`${items[0]!.fromLine}-${items[0]!.toLine}`).toBe('1-5');
    expect(items[0]!.nativeOnly).toBeUndefined(); // 真糖段不带兜底标记（additive 契约）
    expect(items[0]!.sugarText.split('\n')).toEqual([
      '; 分节标记',
      '如果 TALENT:TARGET:恋慕：',
      '\t「{你}，今天也来训练了？」',
      '\t她别开了脸。 续',
    ]);
    // 兜底段标记从 `SugarProjectSegment` 原样透传到 UI 供给项（宿主可区分"没读懂"的段）
    expect(`${items[1]!.fromLine}-${items[1]!.toLine}`).toBe('6-7');
    expect(items[1]!.nativeOnly).toBe(true);
  });

  it('`.kojo` 不供给投影（它本身就是糖）', () => {
    const k = boot({ [KOJO_PATH]: enc(KOJO) });
    expect(previewsOf(k)[0]!.provideLiftProject!({ path: KOJO_PATH, text: KOJO, project: null })).toEqual(
      [],
    );
  });

  it('同一输入二次取段命中缓存、结果逐字相等', () => {
    const k = boot({ [ERB_PATH]: enc(ERB_FULL) });
    const get = () => previewsOf(k)[0]!.provideLiftProject!({ path: ERB_PATH, text: ERB_FULL, project: null });
    expect(get()).toEqual(get());
  });

  it('整文件投影**全程零写盘**：跑完源文件逐字节不变、不发任何事件', () => {
    const k = boot({ [ERB_PATH]: enc(ERB_FULL), [KOJO_PATH]: enc(KOJO) });
    const beforeErb = new Uint8Array(k.files[ERB_PATH]!);
    const beforeKojo = new Uint8Array(k.files[KOJO_PATH]!);
    previewsOf(k)[0]!.provideLiftProject!({ path: ERB_PATH, text: ERB_FULL, project: null });
    expect(k.events).toEqual([]);
    expect(k.files[ERB_PATH]).toEqual(beforeErb);
    expect(k.files[KOJO_PATH]).toEqual(beforeKojo);
  });
});
