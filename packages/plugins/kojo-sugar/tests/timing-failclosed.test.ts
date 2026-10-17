/**
 * 回归：时机块的两条 fail-closed 判据。
 *
 * - MEDIUM（`成否:` 落在没有 success 模板的分野）：旧实现 `spec.success?.template ?? template`
 *   回退到**主模板** ⇒ 同一个函数头发两遍、引擎撞「重复定义」，诊断还把成因说反
 *   （说成"同一编号写了两遍"）。现在只在**该面自带 success 模板**时生成成否函数；
 *   否则报 `face-table-missing`（error）且不产成否函数（主函数照常）。
 * - MEDIUM（段块与普通语句混排）：旧实现先推包装函数（`@…` / `CALL …_1` / `RETURN RESULT`）
 *   再检查混排——产物留下一个调用不存在 `_1` 的**半成品包装壳**。判据必须前置到
 *   任何 `em.push` 之前：整个时机一条字节都不产。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('MED·4 `成否:` 在无 success 模板的分野：不重复生成，报 face-table-missing', () => {
  // 初见 面在 adapter 表里没有 success 模板（只有 `指令` 有）。
  const src = '角色: 12\n时机 初见 成否: 一定成功：\n\t「呀。」\n';

  it('主函数只出现一次（不再叠一个同名的"成否函数"）', () => {
    const { erb } = t(src);
    expect(count(erb, '@M_KOJO_ENCOUNTER_K12\n')).toBe(1);
    expect(erb.match(/^@M_KOJO_ENCOUNTER_K12$/gm)).toHaveLength(1);
    expect(erb).not.toContain('_SUCCESS_');
    expect(erb).not.toContain('TFLAG:192');
  });

  it('报 face-table-missing（error），且不再误报 function-name-duplicate', () => {
    const diags = t(src).diagnostics;
    expect(diags.some((d) => d.code === 'face-table-missing' && d.severity === 'error')).toBe(true);
    expect(diags.some((d) => d.code === 'function-name-duplicate')).toBe(false);
  });

  it('planSave 被阻断（error 级），不会写出重复定义的文件', () => {
    expect(svc().planSave({ source: src, sourcePath: '/proj/a.kojo' }).blocked).toBe(true);
  });

  it('有 success 模板的 `指令` 面：成否函数照常生成（回归）', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 指令 310 成否: 一定成功：\n\t「呀。」\n');
    expect(diagnostics).toEqual([]);
    expect(erb).toContain('@M_KOJO_SUCCESS_COM_K12_310');
    expect(erb).toContain('TFLAG:192 = 1');
    // 主函数与成否函数各一份
    expect(count(erb, '@M_KOJO_MESSAGE_COM_K12_310')).toBe(2); // 包装 + `_1`
  });
});

describe('MED·5 段块混排：包装壳一字节都不留（不再调用不存在的 `_1`）', () => {
  const src = '角色: 12\n时机 指令 310：\n\t若 NOWEX:噴乳：\n\t\t「甲」\n\t「乙」\n';

  it('产物为空（无 `@…` / `CALL …_1` / `RETURN RESULT` 半成品）', () => {
    const { erb, diagnostics } = t(src);
    expect(erb.trim()).toBe('');
    expect(erb).not.toContain('@M_KOJO');
    expect(erb).not.toContain('_1');
    expect(erb).not.toContain('RETURN RESULT');
    expect(diagnostics.some((d) => d.code === 'section-mixed' && d.severity === 'error')).toBe(true);
  });

  it('纯段块（无混排）仍正常产段信封（回归）', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 指令 310：\n\t若 NOWEX:噴乳：\n\t\t「甲」\n');
    expect(diagnostics).toEqual([]);
    expect(erb).toContain('@M_KOJO_MESSAGE_COM_K12_310_1');
    expect(erb).toContain('IF LOCAL && NOWEX:噴乳');
  });
});
