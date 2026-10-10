/**
 * S5-UI 批验收：升糖应用（候选 → `.kojo` 源文件写回）。
 *
 * 覆盖三块：
 * 1. **纯函数 `applyLift`**：倒序替换正确性 / 缩进平移 / 文件头补充 /
 *    三类校验（越界、重叠、原文不一致）/ `alias` 不参与替换；
 * 2. **写链路 `applyLiftToFile`**（伪 FileIO 精确驱动各路径）：成功路径
 *    （编码口径字节级）/ 越权原样传播 / 回读不一致（携带备份位置）/
 *    无原文件时不备份；
 * 3. **`file.changed` 发口**：只有写盘成功才发（装配层注入 `onApplied`）。
 *
 * 编码口径断言与 S3 同源：**UTF-8 BOM + LF + 末尾换行**。
 *
 * 说明：本文件是**测试**，按解耦审计规则 C 豁免可直接 import 其它插件包。
 */

import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  FileIO,
  FileStat,
  Logger,
  SugarLiftApplyRequest,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { SugarApplyError } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { liftSuggest } from '../src/lift';
import { applyLift, applyLiftToFile, createSugarLiftApplyService } from '../src/lift-apply';
import type { LiftDeps } from '../src/lift';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';

/* ============================== 装配 ============================== */

const stubDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '好感度' || name === '心情') return 'CFLAG';
    if (name === '名字') return 'CALLNAME';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    if (['CFLAG', 'TALENT', 'ABL', 'FLAG', 'TFLAG', 'CALLNAME', 'NAME'].includes(head)) return ident;
    return undefined;
  },
};

const deps = (): LiftDeps => ({
  transpile: (source, options): SugarTranspileResult =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() }).transpile(source, options),
});

/** 对一份 `.kojo` 源做升糖扫描，返回候选（供应用用例的输入） */
const scan = (source: string) => liftSuggest(deps(), { source });

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 伪 FileIO（内存文件系统 + 双闸替身）。
 * `writeMode` 用于精确驱动失败路径；`writable` 控制第一道闸。
 */
function makeIO(opts: {
  files: Record<string, Uint8Array>;
  writable?: (path: string) => boolean;
  writeMode?: 'stale' | 'throw';
}) {
  const files = opts.files;
  const backups: string[] = [];
  const written: string[] = [];
  const isWritable = opts.writable ?? (() => true);
  const io: FileIO = {
    readText: async (p) => ({ path: p, text: '', encoding: 'utf-8' as const, eol: 'lf' as const, bom: false, mtimeMs: 1, hasTrailingNewline: true }),
    readBytes: async (p) => {
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    writeText: async () => {
      throw new Error('writeText not wired');
    },
    writeBytes: async (p, data) => {
      if (!isWritable(p)) {
        throw Object.assign(new Error(`Write not allowed outside declared writable roots: ${p}`), {
          name: 'WriteNotAllowedError',
        });
      }
      written.push(p);
      if (opts.writeMode === 'throw') throw new Error('disk full');
      if (opts.writeMode === 'stale') return; // 不落盘 → 回读不一致
      files[p] = data;
    },
    ensureDir: async () => {},
    listDir: async (): Promise<DirEntry[]> => [],
    walkDir: async (): Promise<DirEntry[]> => [],
    exists: async (p) => {
      if (files[p]) return true;
      const prefix = `${p}/`;
      return Object.keys(files).some((k) => k.startsWith(prefix));
    },
    stat: async (p): Promise<FileStat | null> => {
      const b = files[p];
      return b ? { size: b.length, mtimeMs: 1, isDirectory: false } : null;
    },
    setWritableRoots: () => {},
    isWritable: (p) => isWritable(p),
    backup: async (p) => {
      if (!files[p]) return null;
      const target = `backup:///${p.replace(/\//g, '_')}.bak`;
      backups.push(target);
      return target;
    },
  };
  return { io, backups, written, files };
}

const enc = (s: string) => new TextEncoder().encode(s);

/* ============================== 一、纯函数 applyLift ============================== */

describe('S5-UI / applyLift —— 候选写回源文本', () => {
  it('单条候选：区间被糖源码替换，diff 记录改前改后', () => {
    const source = ['角色: 1', '时机 指令 1：', '\tPRINTFORMDW 她看起来很高兴。', ''].join('\n');
    const r = scan(source);
    expect(r.candidates).toHaveLength(1);
    const out = applyLift({ source, candidates: r.candidates });
    expect(out.appliedCount).toBe(1);
    expect(out.text).toBe(['角色: 1', '时机 指令 1：', '\t她看起来很高兴。', ''].join('\n'));
    expect(out.hunks).toHaveLength(1);
    expect(out.hunks[0]!.removed).toEqual(['\tPRINTFORMDW 她看起来很高兴。']);
    expect(out.hunks[0]!.added).toEqual(['\t她看起来很高兴。']);
    expect(out.frontMatterChanged).toBe(false);
  });

  it('倒序替换：多条候选不互相错位（三条同缩进候选一次应用）', () => {
    const source = [
      '角色: 1',
      '时机 指令 1：',
      '\tPRINTFORMDW 甲。',
      '\tPRINTFORMDW 乙。',
      '\tPRINTFORMDW 丙。',
      '',
    ].join('\n');
    const r = scan(source);
    expect(r.candidates.length).toBe(3);
    const out = applyLift({ source, candidates: r.candidates });
    expect(out.text).toBe(['角色: 1', '时机 指令 1：', '\t甲。', '\t乙。', '\t丙。', ''].join('\n'));
    expect(out.hunks.map((h) => h.fromLine)).toEqual([3, 4, 5]);
  });

  it('缩进平移：候选可带 `indentBase`（多级嵌套场景）', () => {
    const source = ['角色: 1', '时机 指令 1：', '\tPRINTFORMDW 甲。', ''].join('\n');
    const r = scan(source);
    const out = applyLift({ source, candidates: r.candidates, indentBase: 2 });
    expect(out.text).toBe(['角色: 1', '时机 指令 1：', '\t\t甲。', ''].join('\n'));
  });

  it('多行糖片段：后续行按基准平移（IF 块候选）', () => {
    const source = [
      '角色: 1',
      '时机 指令 1：',
      '\tIF CFLAG:2 >= 30',
      '\t\tPRINTFORMDW 她看起来很高兴。',
      '\tENDIF',
      '',
    ].join('\n');
    const r = scan(source);
    expect(r.candidates.map((c) => c.kind)).toContain('if-block');
    const out = applyLift({ source, candidates: r.candidates });
    // 糖块产物：`如果 …：` + 缩进体（**变量引用原样透传**——转译器不改写 ERB 记号）
    expect(out.text).toContain('\t如果 CFLAG:2 >= 30：');
    expect(out.text).toContain('\t\t她看起来很高兴。');
    expect(out.text).not.toContain('PRINTFORMDW');
    expect(out.text).not.toContain('ENDIF');
  });

  it('文件头：应用 `作者色` 口径候选时补 `旁白色: 作者色` 声明行', () => {
    const source = ['角色: 1', '时机 指令 1：', '\tPRINTFORML 她红着脸，小声嘟囔着。', ''].join('\n');
    const r = scan(source);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.narrationColor).toBe('作者色');
    const out = applyLift({ source, candidates: r.candidates });
    expect(out.frontMatterChanged).toBe(true);
    // 插入点在 `角色: 1` **之后**（文件头声明的既有次序：角色 → 旁白色）
    expect(out.text).toBe(['角色: 1', '旁白色: 作者色', '时机 指令 1：', '\t她红着脸，小声嘟囔着。 续', ''].join('\n'));
  });

  it('文件头：已有 `旁白色: 默认` 且本次需要作者色 → 就地改写该行', () => {
    const source = [
      '角色: 1',
      '旁白色: 默认',
      '时机 指令 1：',
      '\tPRINTFORML 她红着脸，小声嘟囔着。',
      '',
    ].join('\n');
    const r = scan(source);
    const out = applyLift({ source, candidates: r.candidates });
    expect(out.text).toContain('旁白色: 作者色');
    expect(out.text).not.toContain('旁白色: 默认');
    // 就地改写 → 行数不变
    expect(out.text.split('\n').length).toBe(source.split('\n').length);
  });

  it('文件头：已有 `旁白色: 作者色` 且本次不再需要 → **不动它**（零侵入）', () => {
    const source = [
      '角色: 1',
      '旁白色: 作者色',
      '时机 指令 1：',
      '\tPRINTFORMDW 她看起来很高兴。',
      '',
    ].join('\n');
    const r = scan(source);
    // 该候选走默认口径就成立（PRINTFORMDW + 无引号），但刻意传 `作者色` 也不该删声明
    const candidates = r.candidates.map((c) => ({ ...c, narrationColor: '默认' as const }));
    const out = applyLift({ source, candidates });
    expect(out.frontMatterChanged).toBe(false);
    expect(out.text).toContain('旁白色: 作者色');
  });

  it('头注横幅（`//`）不影响文件头插入点', () => {
    const source = [
      '// 这是头注',
      '// 第二行',
      '角色: 1',
      '时机 指令 1：',
      '\tPRINTFORML 她红着脸，小声嘟囔着。',
      '',
    ].join('\n');
    const r = scan(source);
    const out = applyLift({ source, candidates: r.candidates });
    expect(out.text.split('\n').slice(0, 3)).toEqual(['// 这是头注', '// 第二行', '角色: 1']);
    expect(out.text).toContain('角色: 1\n旁白色: 作者色\n');
  });

  it('`alias` 类候选不参与替换（契约：指向插入点而非区间）', () => {
    const source = ['角色: 1', '时机 指令 1：', '\tPRINTFORMDW 甲。', ''].join('\n');
    const r = scan(source);
    const withAlias = [
      ...r.candidates,
      { ...r.candidates[0]!, kind: 'alias' as const, fromLine: 3, toLine: 3, sugarSource: '别名 甲 = "甲"' },
    ];
    const out = applyLift({ source, candidates: withAlias });
    expect(out.appliedCount).toBe(1); // alias 被过滤掉
    expect(out.text).toBe(['角色: 1', '时机 指令 1：', '\t甲。', ''].join('\n'));
  });

  it('空候选：文本原样返回', () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const out = applyLift({ source, candidates: [] });
    expect(out.text).toBe(source);
    expect(out.appliedCount).toBe(0);
    expect(out.hunks).toEqual([]);
  });

  /* ---------- 校验（fail-closed） ---------- */

  it('校验：区间越界 → 抛 SugarApplyError', () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const r = scan(source);
    const bad = [{ ...r.candidates[0]!, fromLine: 99, toLine: 99 }];
    expect(() => applyLift({ source, candidates: bad })).toThrow(SugarApplyError);
    expect(() => applyLift({ source, candidates: bad })).toThrow(/越界/);
  });

  it('校验：区间重叠 → 抛 SugarApplyError', () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const r = scan(source);
    const c = r.candidates[0]!;
    expect(() => applyLift({ source, candidates: [c, { ...c }] })).toThrow(/重叠/);
  });

  it('校验：候选原文与源文本不符（行号漂移）→ 抛 SugarApplyError', () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const r = scan(source);
    const drifted = [{ ...r.candidates[0]!, fromLine: 2, toLine: 2 }];
    expect(() => applyLift({ source, candidates: drifted })).toThrow(/不一致/);
  });
});

/* ============================== 二、写链路 applyLiftToFile ============================== */

describe('S5-UI / applyLiftToFile —— 写链路（与 compileToFile 同款）', () => {
  const PATH = '/proj/口上/x.kojo';

  it('成功路径：落盘字节 = UTF-8 BOM + LF + 末尾换行（与 S3 同口径）', async () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const h = makeIO({ files: { [PATH]: enc(source) } });
    const r = scan(source);
    const res = await applyLiftToFile({ io: h.io, log }, PATH, { source, candidates: r.candidates });
    expect(res.appliedCount).toBe(1);
    expect(res.byteSize).toBe(h.files[PATH]!.length);
    const bytes = h.files[PATH]!;
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text).toBe('角色: 1\n时机 指令 1：\n\t甲。\n');
    expect(text.includes('\r')).toBe(false);
  });

  it('备份：目标已存在 → 先备份再写；backupPath 回传', async () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const h = makeIO({ files: { [PATH]: enc(source) } });
    const r = scan(source);
    const res = await applyLiftToFile({ io: h.io, log }, PATH, { source, candidates: r.candidates });
    expect(h.backups).toHaveLength(1);
    expect(res.backupPath).toBe(h.backups[0]);
    // 备份在写盘之前（顺序即安全语义）
    expect(h.written).toEqual([PATH]);
  });

  it('备份：目标不存在 → 返回 null（不产生空备份）', async () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const h = makeIO({ files: {} });
    const r = scan(source);
    const res = await applyLiftToFile({ io: h.io, log }, PATH, { source, candidates: r.candidates });
    expect(res.backupPath).toBeNull();
    expect(h.backups).toHaveLength(0);
  });

  it('第一道闸：越权写 → WriteNotAllowedError **原样传播**（不包装）', async () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const h = makeIO({ files: { [PATH]: enc(source) }, writable: () => false });
    const r = scan(source);
    await expect(
      applyLiftToFile({ io: h.io, log }, PATH, { source, candidates: r.candidates }),
    ).rejects.toMatchObject({ name: 'WriteNotAllowedError' });
    // 越权时备份已做、原文件未被覆盖
    expect(h.backups).toHaveLength(1);
    expect(new TextDecoder().decode(h.files[PATH]!).includes('PRINTFORMDW')).toBe(true);
  });

  it('回读验证：落盘字节不一致 → SugarApplyError 且**携带备份位置**', async () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const h = makeIO({ files: { [PATH]: enc(source) }, writeMode: 'stale' });
    const r = scan(source);
    await expect(
      applyLiftToFile({ io: h.io, log }, PATH, { source, candidates: r.candidates }),
    ).rejects.toThrow(/回读验证失败[\s\S]*原文件已备份于/);
  });

  it('写盘异常：包装为 SugarApplyError 并提示备份位置', async () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const h = makeIO({ files: { [PATH]: enc(source) }, writeMode: 'throw' });
    const r = scan(source);
    await expect(
      applyLiftToFile({ io: h.io, log }, PATH, { source, candidates: r.candidates }),
    ).rejects.toThrow(/写盘失败：disk full[\s\S]*已备份于/);
  });

  it('校验失败先于一切副作用：不备份、不写盘', async () => {
    const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';
    const h = makeIO({ files: { [PATH]: enc(source) } });
    const r = scan(source);
    const bad: SugarLiftApplyRequest = {
      source,
      candidates: [{ ...r.candidates[0]!, fromLine: 99, toLine: 99 }],
    };
    await expect(applyLiftToFile({ io: h.io, log }, PATH, bad)).rejects.toThrow(SugarApplyError);
    expect(h.backups).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });
});

/* ============================== 三、file.changed 发口 ============================== */

describe('S5-UI / 事件纪律 —— 写盘成功才发 file.changed', () => {
  const PATH = '/proj/口上/x.kojo';
  const source = '角色: 1\n时机 指令 1：\n\tPRINTFORMDW 甲。\n';

  it('成功：发一次，payload = { kind: "change", path }（S3 已落契约）', async () => {
    const h = makeIO({ files: { [PATH]: enc(source) } });
    const events: Array<{ kind: string; path: string }> = [];
    const svc = createSugarLiftApplyService({ io: h.io, log, onApplied: (p) => events.push({ kind: 'change', path: p }) });
    const r = scan(source);
    const res = await svc.applyToFile(PATH, { source, candidates: r.candidates });
    expect(res.appliedCount).toBe(1);
    expect(events).toEqual([{ kind: 'change', path: PATH }]);
  });

  it('失败：越权写不发事件（写盘未成功）', async () => {
    const h = makeIO({ files: { [PATH]: enc(source) }, writable: () => false });
    const events: string[] = [];
    const svc = createSugarLiftApplyService({ io: h.io, log, onApplied: (p) => events.push(p) });
    const r = scan(source);
    await expect(svc.applyToFile(PATH, { source, candidates: r.candidates })).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it('纯函数 apply 不触发任何发口（只读意图）', () => {
    const h = makeIO({ files: {} });
    const events: string[] = [];
    const svc = createSugarLiftApplyService({ io: h.io, log, onApplied: (p) => events.push(p) });
    const r = scan(source);
    svc.apply({ source, candidates: r.candidates });
    expect(events).toEqual([]);
  });
});
