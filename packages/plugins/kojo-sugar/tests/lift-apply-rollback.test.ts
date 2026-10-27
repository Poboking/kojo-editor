/**
 * K2-PRE-REUSE 剩余项 ②：升糖回写链路的**写后回读失败 → 回滚到写前字节**。
 *
 * 缺陷形态（`08ac046d` 只修了 `compile.ts`）：`lift-apply.ts::applyLiftToFile` 写后
 * 回读不一致时**不回滚、不留半成品**——盘上留着与请求不符的字节，却只抛一条错误。
 * 两条写链路的口径必须逐字同源，故回滚/诊断一律复用 `compile.ts` 的同一份函数
 * （`readbackFailureDetail` → `rollbackToPreWrite` + `rollbackOutcome`），不抄第二份。
 *
 * 本文件用**假 io 端口**驱动（备份真存字节、可精确让回滚自身失败）：
 * - 回读不一致 / 回读抛错 ⇒ 回滚到写前字节（有备份写回、无备份删半成品）；
 * - 回滚自身失败 ⇒ **如实上文本**（`回滚失败（…）` + 手动兜底），绝不谎报成功；
 * - 回滚只动目标文件（旁挂/邻居零触碰）；成功路径零多余写。
 */

import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO, FileStat, Logger, SugarLiftApplyRequest } from '@kojo/plugin-api';
import { SugarApplyError } from '@kojo/plugin-api';
import { applyLiftToFile } from '../src/lift-apply';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const TARGET = '/proj/口上/x.kojo';
const NEIGHBOR = '/proj/口上/y.kojo';
const BAK = 'bak://';
const enc = (s: string) => new TextEncoder().encode(s);

/** 写前原文（任意既有字节；回滚判据就是它） */
const SRC = ['角色: 1', '时机 指令 1：', '\t甲。', ''].join('\n');
const ORIGINAL = enc(SRC);

/** 一条合法候选：第 3 行 `\t甲。` → `\t乙。` */
const REQUEST: SugarLiftApplyRequest = {
  source: SRC,
  candidates: [
    {
      kind: 'print-message',
      fromLine: 3,
      toLine: 3,
      sugarSource: '乙。',
      confidence: 'verified',
      roundTrip: { verified: true, originalText: '\t甲。', generatedText: '\t甲。' },
      reason: '测试替身',
    },
  ],
};

const bytesOf = (a: Record<string, Uint8Array>, p: string): number[] => [...(a[p] ?? new Uint8Array())];

/**
 * 假 `FileIO`（备份**真存字节**；故障注入点只覆盖本文件要证明的几条路径）。
 *
 * 写盘调用序 = ①用户写（`writes[0]`）②回滚写回（`writes[1]`，若有）——`rollbackWriteThrows`
 * 只打第二条，正是"回滚自身失败"。其余未接线的成员一律走到即红（不静默返回假成功）。
 */
function makeIO(opts: {
  files: Record<string, Uint8Array>;
  /** 首写落盘口径：`ok` 照写；`stale` 不落盘；`corrupt` 落一段错字节（长度也不同） */
  writeMode?: 'ok' | 'stale' | 'corrupt';
  /** 首写抛错（写盘失败路径，不进回读） */
  writeThrows?: boolean;
  /** 回读目标抛错（写已落盘，只是读不回来） */
  targetReadThrows?: boolean;
  /** 回滚写回抛错（盘坏 / 越权恢复） */
  rollbackWriteThrows?: boolean;
  /** 回滚读备份抛错（备份不可读） */
  backupReadThrows?: boolean;
  /** 回滚删半成品抛错 */
  removeFileThrows?: boolean;
}) {
  const files = opts.files;
  const backups = new Map<string, Uint8Array>();
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const removes: string[] = [];
  const backupReads: string[] = [];
  let targetReads = 0;

  const notWired = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} 未接线（本夹具不该走到这里）`);
  };

  const io: FileIO = {
    readText: notWired('readText'),
    readTexts: notWired('readTexts'),
    readBytes: async (p) => {
      if (p.startsWith(BAK)) {
        backupReads.push(p);
        if (opts.backupReadThrows) throw new Error('备份读失败：设备未就绪');
        const b = backups.get(p);
        if (!b) throw new Error(`not found: ${p}`);
        return b;
      }
      if (p === TARGET) {
        targetReads++;
        if (opts.targetReadThrows) throw new Error('回读失败：设备未就绪');
      }
      const b = files[p];
      if (!b) throw new Error(`not found: ${p}`);
      return b;
    },
    readBytesMany: async (paths) => paths.map((p) => files[p] ?? null),
    writeText: notWired('writeText'),
    writeBytes: async (p, data) => {
      writes.push({ path: p, bytes: data });
      const first = writes.length === 1;
      if (!first && opts.rollbackWriteThrows) throw new Error('回滚写回失败：磁盘只读');
      if (first) {
        if (opts.writeThrows) throw new Error('disk full');
        if (opts.writeMode === 'stale') return; // 不落盘：回读仍是写前字节
        if (opts.writeMode === 'corrupt') {
          files[p] = new Uint8Array([0x00]); // 坏产物（长度也不同，便于断言读数）
          return;
        }
      }
      files[p] = data;
    },
    ensureDir: async () => {},
    // 独占创建（WS-01）：假 io 不跑新建链路，`false` = "没建"
    createFileExclusive: async () => false,
    createDirExclusive: async () => false,
    listDir: async (): Promise<DirEntry[]> => [],
    walkDir: async (): Promise<DirEntry[]> => [],
    exists: async (p) => files[p] !== undefined || Object.keys(files).some((k) => k.startsWith(`${p}/`)),
    stat: async (p): Promise<FileStat | null> =>
      files[p] ? { size: files[p]!.length, mtimeMs: 1, isDirectory: false } : null,
    statFiles: notWired('statFiles'),
    setWritableRoots: () => {},
    setAppWritableRoots: () => {},
    addAppWritableRoot: () => {},
    chooseWorkspaceRoot: notWired('chooseWorkspaceRoot'),
    isWritable: () => true,
    backup: async (p) => {
      const b = files[p];
      if (!b) return null;
      const path = `${BAK}${p}`;
      backups.set(path, b.slice()); // 写前快照（回滚的恢复源）
      return path;
    },
    listBackups: async () => [],
    restoreBackup: notWired('restoreBackup'),
    exportFile: notWired('exportFile'),
    appDataDir: async () => '/appdata',
    rename: notWired('rename'),
    copyFile: notWired('copyFile'),
    removeDir: notWired('removeDir'),
    removeFile: async (p) => {
      removes.push(p);
      if (opts.removeFileThrows) throw new Error('removeFile 失败：只读');
      delete files[p];
    },
    listTrash: async () => [],
    restoreFromTrash: notWired('restoreFromTrash'),
    purgeTrash: async () => 0,
    holdTrash: () => {},
  };
  return { io, files, writes, removes, backupReads, backups, targetReads: () => targetReads };
}

/** 拿到 rejection（断言类型/文本用；断言"应当抛"本身也算一条判据） */
async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('期望抛错，但调用成功了');
}

/** 断言错误是 `SugarApplyError` 并回显字段 */
function asApplyError(err: unknown): SugarApplyError {
  expect(err).toBeInstanceOf(SugarApplyError);
  return err as SugarApplyError;
}

/* ============================================================================ */
/* A. 回读不一致 → 回滚到写前字节                                               */
/* ============================================================================ */

describe('② 回读失败 → 回滚到写前状态（与 compileToFile 同一份实现）', () => {
  it('回读不一致（坏产物已落盘）→ 目标字节恢复为写前原文（逐字节）', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL }, writeMode: 'corrupt' });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/回读验证失败/);
    expect(err.message).toMatch(/已回滚到写前状态/);
    expect(err.message).toMatch(/原文件已从备份恢复/);
    // 盘上不再有半成品：写前字节逐字节回来
    expect(bytesOf(h.files, TARGET)).toEqual([...ORIGINAL]);
    // 回滚 = 读备份 + 写回目标（各一次）
    expect(h.backupReads).toHaveLength(1);
    expect(h.writes.map((w) => w.path)).toEqual([TARGET, TARGET]);
  });

  it('回读抛错（写已落盘、读不回来）→ 同样回滚到写前原文', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL }, targetReadThrows: true });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/无法重新读取文件/);
    expect(err.message).toMatch(/已回滚到写前状态/);
    expect(bytesOf(h.files, TARGET)).toEqual([...ORIGINAL]);
    // 中间态确实写过新字节（证明它真的"写后回滚"，不是压根没写）
    expect(h.writes).toHaveLength(2);
    expect(bytesOf({ x: h.writes[0]!.bytes }, 'x')).not.toEqual([...ORIGINAL]);
  });

  it('错误对象字段齐全：`targetPath` / `backupPath` / 消息里带备份位置（回滚了也要留线索）', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL }, writeMode: 'corrupt' });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.targetPath).toBe(TARGET);
    expect(err.backupPath).toBe(`${BAK}${TARGET}`);
    expect(err.message).toContain(`${BAK}${TARGET}`);
  });

  it('失败消息带字节读数（期望 / 实得，不吞原始差异）', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL }, writeMode: 'corrupt' });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/期望 \d+B，实得 1B/);
  });

  it('旁挂只回滚自身：同目录邻居文件零触碰，写只落目标', async () => {
    const neighbor = enc('角色: 1\n时机 指令 1：\n\t「邻居」\n');
    const h = makeIO({ files: { [TARGET]: ORIGINAL, [NEIGHBOR]: neighbor }, writeMode: 'corrupt' });
    await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST));
    expect(bytesOf(h.files, NEIGHBOR)).toEqual([...neighbor]);
    expect(bytesOf(h.files, TARGET)).toEqual([...ORIGINAL]);
    expect(h.writes.every((w) => w.path === TARGET)).toBe(true);
    expect(h.removes).toEqual([]);
  });
});

/* ============================================================================ */
/* B. 回滚自身失败 → 如实报错，不许谎报成功                                      */
/* ============================================================================ */

describe('② 回滚自身失败 · 如实上文本（绝不谎报"已回滚"）', () => {
  it('备份读不出 → `回滚失败（…）` + 手动兜底，且**不**出现"已回滚到写前状态"', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL }, writeMode: 'corrupt', backupReadThrows: true });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/回滚失败（备份读失败：设备未就绪）/);
    expect(err.message).toMatch(/原文件已备份于 .*请手动恢复/);
    expect(err.message).not.toContain('已回滚到写前状态');
    // 半成品如实留在盘上（不假装恢复）
    expect(bytesOf(h.files, TARGET)).toEqual([0x00]);
  });

  it('回滚写回失败（盘只读）→ 同样如实报，且备份位置照旧在', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL }, writeMode: 'corrupt', rollbackWriteThrows: true });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/回滚失败（回滚写回失败：磁盘只读）/);
    expect(err.message).toContain(`${BAK}${TARGET}`);
    expect(err.message).not.toContain('已回滚到写前状态');
  });

  it('无备份（目标写前不存在）+ 回读不一致 → 半成品被移除（写前状态 = 不存在）', async () => {
    const h = makeIO({ files: {}, writeMode: 'corrupt' });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/目标写前不存在，半成品已移除/);
    expect(h.removes).toEqual([TARGET]);
    expect(h.files[TARGET]).toBeUndefined();
  });

  it('无备份 + 移除半成品也失败 → `盘上可能残留半成品，请手动处理`', async () => {
    const h = makeIO({ files: {}, writeMode: 'corrupt', removeFileThrows: true });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/回滚失败（removeFile 失败：只读）/);
    expect(err.message).toMatch(/盘上可能残留半成品，请手动处理/);
    expect(err.message).not.toContain('已回滚到写前状态');
  });
});

/* ============================================================================ */
/* C. 成功路径：零多余写                                                         */
/* ============================================================================ */

describe('② 成功路径 · 零多余写（回读只是读）', () => {
  it('恰好一次写盘、一次回读、零回滚读写、零删除', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL } });
    const res = await applyLiftToFile({ io: h.io, log }, TARGET, REQUEST);
    expect(res.appliedCount).toBe(1);
    expect(res.backupPath).toBe(`${BAK}${TARGET}`);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.path).toBe(TARGET);
    expect(h.writes[0]!.bytes).toHaveLength(res.byteSize);
    expect(h.targetReads()).toBe(1); // 只有那次回读
    expect(h.backupReads).toEqual([]); // 没回滚就没读备份
    expect(h.removes).toEqual([]);
  });

  it('目标写前不存在 → 不备份、不回滚（`backupPath` 为 null，写一次）', async () => {
    const h = makeIO({ files: {} });
    const res = await applyLiftToFile({ io: h.io, log }, TARGET, REQUEST);
    expect(res.backupPath).toBeNull();
    expect(h.writes).toHaveLength(1);
    expect(h.backupReads).toEqual([]);
    expect(h.removes).toEqual([]);
  });

  it('写盘本身失败：不触发回读/回滚（备份已在位、原文件未被覆盖）', async () => {
    const h = makeIO({ files: { [TARGET]: ORIGINAL }, writeThrows: true });
    const err = asApplyError(await rejection(() => applyLiftToFile({ io: h.io, log }, TARGET, REQUEST)));
    expect(err.message).toMatch(/写盘失败：disk full/);
    expect(h.writes).toHaveLength(1); // 没有第二次（回滚）写
    expect(h.backupReads).toEqual([]);
    expect(bytesOf(h.files, TARGET)).toEqual([...ORIGINAL]);
  });
});
