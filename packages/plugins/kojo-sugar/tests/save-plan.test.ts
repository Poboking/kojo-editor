/**
 * S7 批验收：保存目标推导 + 保存前置检查（`planSave`）。
 *
 * 覆盖三节：
 * - **目标推导**（`resolveSugarTarget`：`.kojo` → 同目录同基名 `.ERB`，非 `.kojo` 归空）；
 * - **全角空格**（`fullwidthSpaceLines`：`U+3000` 行号，全角标点不计入）；
 * - **前置检查**（`planSave`：三件一并、`blocked` 语义、失败原因闭集、只告警不阻断）。
 *
 * 目标推导与全角空格都是**语言层纯函数**（契约层单一真源），此处直接对
 * `@kojo/plugin-api` 断言；`planSave` 走真实转译器（adapter 表由 support 注入）。
 */

import { describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE, fullwidthSpaceLines, resolveSugarTarget } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 可通过转译的合法文档 */
const VALID = '角色: 12\n时机 指令 310：\n    「呀。」\n';
/** 含 error 诊断的文档（保留代词作别名 → alias-name-conflict） */
const ERRORS = '角色: 12\n别名 她 = CFLAG:1\n时机 指令 310：\n    「呀。」\n';

/* ============================================================================ */
/* 一、目标推导 resolveSugarTarget                                               */
/* ============================================================================ */

describe('resolveSugarTarget · 同目录换扩展名（.kojo → .ERB）', () => {
  it('基本形式：基名与目录原样保留，扩展名大小写归一为 .ERB', () => {
    expect(resolveSugarTarget('D:/kojo/M_KOJO_K49_指令.kojo')).toBe('D:/kojo/M_KOJO_K49_指令.ERB');
  });

  it('扩展名大小写不敏感（.KOJO / .Kojo 均可）', () => {
    expect(resolveSugarTarget('/a/b/c.KOJO')).toBe('/a/b/c.ERB');
    expect(resolveSugarTarget('/a/b/c.Kojo')).toBe('/a/b/c.ERB');
  });

  it('分隔符一律保留原样（Windows 反斜杠不被改写）', () => {
    expect(resolveSugarTarget('D:\\kojo\\個人口上\\M_KOJO_K49_指令.kojo')).toBe(
      'D:\\kojo\\個人口上\\M_KOJO_K49_指令.ERB',
    );
  });

  it('相对路径同样可用（不要求绝对路径）', () => {
    expect(resolveSugarTarget('fixtures/sugar/sample-310.kojo')).toBe('fixtures/sugar/sample-310.ERB');
  });

  it('非 .kojo 后缀 → null（原生 .ERB / .bak / 无扩展名）', () => {
    expect(resolveSugarTarget('D:/kojo/A.ERB')).toBeNull();
    expect(resolveSugarTarget('D:/kojo/A.kojo.bak')).toBeNull();
    expect(resolveSugarTarget('D:/kojo/A')).toBeNull();
  });

  it('空 / 缺省路径 → null', () => {
    expect(resolveSugarTarget('')).toBeNull();
  });

  it('纯函数：重复调用结果一致（不触达磁盘、无副作用）', () => {
    const p = 'D:/kojo/M_KOJO_K49_指令.kojo';
    expect(resolveSugarTarget(p)).toBe(resolveSugarTarget(p));
  });
});

/* ============================================================================ */
/* 二、全角空格 fullwidthSpaceLines                                              */
/* ============================================================================ */

describe('fullwidthSpaceLines · U+3000 行号（1 基，升序）', () => {
  it('契约常量：FULLWIDTH_SPACE 即 U+3000', () => {
    expect(FULLWIDTH_SPACE).toBe('\u3000');
    expect(FULLWIDTH_SPACE.codePointAt(0)).toBe(0x3000);
  });

  it('行内任一位置出现即计入（非仅行首）', () => {
    expect(fullwidthSpaceLines('甲\n乙\u3000丙\n丁\n戊\u3000')).toEqual([2, 4]);
  });

  it('一行多个也只记一次（按行去重）', () => {
    expect(fullwidthSpaceLines('\u3000\u3000\u3000')).toEqual([1]);
  });

  it('全角标点（、。！）不算全角空格', () => {
    expect(fullwidthSpaceLines('甲、乙。丙！')).toEqual([]);
  });

  it('空串 → 空数组', () => {
    expect(fullwidthSpaceLines('')).toEqual([]);
  });
});

/* ============================================================================ */
/* 三、前置检查 planSave                                                          */
/* ============================================================================ */

describe('planSave · 三件一并（目标 + 转译 + 全角空格告警）', () => {
  it('合法文档：目标推导正确、未阻断、产物非空、无告警', () => {
    const plan = svc().planSave({ source: VALID, sourcePath: 'D:/kojo/M_KOJO_K49_指令.kojo' });
    expect(plan.sourcePath).toBe('D:/kojo/M_KOJO_K49_指令.kojo');
    expect(plan.erbPath).toBe('D:/kojo/M_KOJO_K49_指令.ERB');
    expect(plan.blocked).toBe(false);
    expect(plan.blockedReason).toBeUndefined();
    expect(plan.transpile.erb).toContain('@M_KOJO_MESSAGE_COM_K12_310');
    expect(plan.fullwidthSpaceLines).toEqual([]);
  });

  it('全角空格：**只告警不阻断**（blocked 仍为 false，告警行照出）', () => {
    const src = '角色: 12\n时机 指令 310：\n    「呀。」\u3000\n';
    const plan = svc().planSave({ source: src, sourcePath: 'D:/kojo/a.kojo' });
    expect(plan.blocked).toBe(false);
    expect(plan.blockedReason).toBeUndefined();
    expect(plan.fullwidthSpaceLines).toEqual([3]);
  });

  it('目标推导结果与源路径同源（plan.erbPath 即 resolveSugarTarget(sourcePath)）', () => {
    const plan = svc().planSave({ source: VALID, sourcePath: 'D:/kojo/k.kojo' });
    expect(plan.erbPath).toBe(resolveSugarTarget('D:/kojo/k.kojo'));
  });

  it('源非 .kojo：目标归空 → blocked，原因 source-not-kojo', () => {
    const plan = svc().planSave({ source: VALID, sourcePath: 'D:/kojo/A.ERB' });
    expect(plan.erbPath).toBeNull();
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReason).toBe('source-not-kojo');
  });

  it('转译产 error：blocked，原因 transpile-error（目标仍照常推导）', () => {
    const plan = svc().planSave({ source: ERRORS, sourcePath: 'D:/kojo/a.kojo' });
    expect(plan.erbPath).toBe('D:/kojo/a.ERB');
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReason).toBe('transpile-error');
    expect(plan.transpile.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('既非 .kojo 又转译报错：原因优先 source-not-kojo（无目标即无落盘）', () => {
    const plan = svc().planSave({ source: ERRORS, sourcePath: 'D:/kojo/A.ERB' });
    expect(plan.erbPath).toBeNull();
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReason).toBe('source-not-kojo');
  });

  it('纯函数：不读盘不写盘（同源同路径两次调用结果一致）', () => {
    const req = { source: VALID, sourcePath: 'D:/kojo/a.kojo' };
    const a = svc().planSave(req);
    const b = svc().planSave(req);
    expect(a.erbPath).toBe(b.erbPath);
    expect(a.blocked).toBe(b.blocked);
    expect(a.transpile.erb).toBe(b.transpile.erb);
  });
});