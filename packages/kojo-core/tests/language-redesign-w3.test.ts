/**
 * W3 语言重构表面测试：方寸原生块 `【原生】…【/原生】` 与方寸表判别式去掉 `】` 的回归。
 */
import { describe, expect, it } from 'vitest';
import type { KojoFile } from '../src/ast.js';
import { lowerFile } from '../src/lower/index.js';
import { parseSource } from '../src/parser.js';
import { createFakeBackend } from './lower-fake-backend.js';

function parseOk(source: string): KojoFile {
  const file = parseSource(source);
  const errors = file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(errors, JSON.stringify(errors.map((e) => [e.code, e.message]))).toEqual([]);
  return file;
}

function linesOf(source: string): readonly string[] {
  const result = lowerFile(parseOk(source), { backend: createFakeBackend() });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(errors, JSON.stringify(errors.map((e) => [e.code, e.message]))).toEqual([]);
  return result.lines;
}

describe('W3：方寸原生块', () => {
  it('【原生】…【/原生】= @原生{ … } 同 lowering；块体 raw 不解析 2.0', () => {
    const newSrc = `【挂 指令 310】
【原生】
; raw comment
CALL HPH_PRINT "w"
IF X == 1
    CALL Y
ENDIF
【/原生】
> 之后。
`;
    const oldSrc = `# 机 指令 310
@原生{
    ; raw comment
    CALL HPH_PRINT "w"
    IF X == 1
        CALL Y
    ENDIF
}
> 之后。
`;
    expect(linesOf(newSrc)).toEqual(linesOf(oldSrc));
  });

  it('块体行不要求缩进，`}` 只作 raw 字符', () => {
    const lines = linesOf('【挂 指令 310】\n【原生】\nCALL X "}"\n\nCALL Y\n【/原生】\n');
    expect(lines).toEqual(linesOf('# 机 指令 310\n@原生{\n    CALL X "}"\n\n    CALL Y\n}\n'));
  });

  it('缺收口报 core/native/unclosed；空块报 core/native/empty', () => {
    expect(parseSource('【挂 指令 310】\n【原生】\nCALL X\n').diagnostics.map((d) => d.code)).toContain(
      'core/native/unclosed',
    );
    expect(parseSource('【挂 指令 310】\n【原生】\n【/原生】\n').diagnostics.map((d) => d.code)).toContain(
      'core/native/empty',
    );
  });
});

describe('W3：方寸表判别式', () => {
  it('【对照表 … 依据 表达式】的表达式不含 `】`，与旧写法同 lowering', () => {
    const newFile = parseOk(
      '【挂 指令 310】\n【设 外部计数 数 = 0 场景】\n【对照表 心情 依据 外部计数】\n    0..99 → 疏远\n    否 → 未知\n',
    );
    const table = newFile.decls.find((decl) => decl.kind === 'table');
    if (table?.kind === 'table') expect(table.subject.text).toBe('外部计数');

    const newLines = linesOf(
      '【挂 指令 310】\n【设 外部计数 数 = 0 场景】\n【对照表 心情 依据 外部计数】\n    0..99 → 疏远\n    否 → 未知\n',
    );
    const oldLines = linesOf(
      '# 机 指令 310\n# 设 外部计数 整数 = 0 场景\n# 对照表 心情 依据 外部计数\n    0..99 -> 疏远\n    否 -> 未知\n',
    );
    expect(newLines).toEqual(oldLines);
  });
});
