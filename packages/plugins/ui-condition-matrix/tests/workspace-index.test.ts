/**
 * 工作区包索引（workspace-index）单测。
 *
 * 钉三件：
 * ① ERB 方言文件原样进两份索引（显示 / 抽取坐标一致）；
 * ② `.kojo1` 先转译：抽取索引用生成行号 + `texts` 覆盖表，显示索引折回源行；
 * ③ 编译 error 的 `.kojo1` 整文件跳过并留在 `problems`（不产半成品、不静默）。
 */

import { describe, expect, it } from 'vitest';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { buildWorkspaceIndex, isWorkspaceMatrixSourceName } from '../src/workspace-index';

const sugar = createSugarTranspileService({ faceTable: createEratwFaceTable() });
const deps = { parseText: parseErbText, sugar };

const ERB_TEXT = [
  '@M_KOJO_MESSAGE_COM_K1_1()',
  'IF CFLAG:2 >= 500',
  'PRINTFORM 「你好」',
  'ENDIF',
  '',
].join('\n');

const KOJO_TEXT = ['角色: 1', '口上: 少女之梦', '时机 指令 310：', '    「呀……！」', ''].join('\n');

/** 带 error 诊断的源：表达式 `当` 缺 `否则`（sugar 编译错误口径） */
const BAD_KOJO = ['; 缺否则', '角色: 12', '', '时机 指令 311：', '    变量 = 当 TFLAG:193：', '        是 1 -> 10', ''].join('\n');

describe('workspace-index', () => {
  it('源文件判定：.kojo1 与 ERB 方言（大小写不敏感），其它忽略', () => {
    expect(isWorkspaceMatrixSourceName('a.kojo1')).toBe(true);
    expect(isWorkspaceMatrixSourceName('B.KOJO1')).toBe(true);
    expect(isWorkspaceMatrixSourceName('C.ERB')).toBe(true);
    expect(isWorkspaceMatrixSourceName('D.erm')).toBe(true);
    expect(isWorkspaceMatrixSourceName('notes.txt')).toBe(false);
  });

  it('ERB 方言：两份索引同坐标，文本原文进覆盖表', () => {
    const bundle = buildWorkspaceIndex([{ path: 'D:/ws/pack/A.ERB', text: ERB_TEXT }], deps);

    expect(bundle.erbFiles).toBe(1);
    expect(bundle.kojoFiles).toBe(0);
    expect(bundle.problems).toEqual([]);
    const fn = bundle.displayIndex.files.get('D:/ws/pack/A.ERB')!.functions[0]!;
    expect(fn.startLine).toBe(1);
    expect(fn.startLine).toBe(bundle.extractIndex.files.get('D:/ws/pack/A.ERB')!.functions[0]!.startLine);
    expect(bundle.texts.get('D:/ws/pack/A.ERB')).toBe(ERB_TEXT);
    expect(bundle.displayIndex.byName.defsOf(fn.normalizedName)).toHaveLength(1);
  });

  it('.kojo1：抽取坐标为生成行、显示坐标折回源行，生成文本进覆盖表', () => {
    const path = 'D:/ws/pack/M_KOJO_K1_口上.kojo1';
    const bundle = buildWorkspaceIndex([{ path, text: KOJO_TEXT }], deps);

    expect(bundle.problems).toEqual([]);
    expect(bundle.kojoFiles).toBe(1);
    const display = bundle.displayIndex.files.get(path)!;
    const extract = bundle.extractIndex.files.get(path)!;
    expect(display.functions.length).toBeGreaterThan(0);
    expect(extract.functions.length).toBe(display.functions.length);

    const generatedText = bundle.texts.get(path)!;
    expect(generatedText).toContain('@M_KOJO_');
    expect(extract.functions[0]!.startLine).toBeGreaterThan(0);
    // 显示索引的行号必须落在源文件内（生成行号在源里可能远超行数）
    for (const fn of display.functions) {
      expect(fn.startLine).toBeGreaterThanOrEqual(1);
      expect(fn.startLine).toBeLessThanOrEqual(KOJO_TEXT.split('\n').length);
    }
  });

  it('编译 error 的 .kojo1：整文件跳过并进 problems，其余文件照常', () => {
    const bad = 'D:/ws/pack/bad.kojo1';
    const good = 'D:/ws/pack/good.ERB';
    const bundle = buildWorkspaceIndex(
      [
        { path: bad, text: BAD_KOJO },
        { path: good, text: ERB_TEXT },
      ],
      deps,
    );

    expect(bundle.kojoFiles).toBe(0);
    expect(bundle.erbFiles).toBe(1);
    expect(bundle.displayIndex.files.has(bad)).toBe(false);
    expect(bundle.extractIndex.files.has(bad)).toBe(false);
    expect(bundle.texts.has(bad)).toBe(false);
    expect(bundle.problems).toHaveLength(1);
    expect(bundle.problems[0]).toContain('bad.kojo1');
    expect(bundle.displayIndex.files.has(good)).toBe(true);
  });

  it('没有语法糖服务：.kojo1 记 problem，ERB 不受影响', () => {
    const path = 'D:/ws/pack/A.kojo1';
    const bundle = buildWorkspaceIndex(
      [
        { path, text: KOJO_TEXT },
        { path: 'D:/ws/pack/B.ERB', text: ERB_TEXT },
      ],
      { parseText: parseErbText },
    );
    expect(bundle.kojoFiles).toBe(0);
    expect(bundle.erbFiles).toBe(1);
    expect(bundle.problems[0]).toContain('语法糖服务不可用');
  });
});
