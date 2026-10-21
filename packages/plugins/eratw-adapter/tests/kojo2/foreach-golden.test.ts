/**
 * eraTW `@巡` **全链 golden**（K2-FOREACH 接线）：`.kojo2` → `ERATW_GAME_ADAPTER`
 * （`foreachCollections` = `ERATW_FOREACH_DECLARATIONS`）→ `createEratwEmitBackend`
 * 的真实 `program.forEachLoop` → ERB 逐字节。
 *
 * 钉住的东西：
 * - `FOR`/`NEXT` 骨架、元素取法（数组 `名:(下标)`）、角色号 `下标 + base`、
 *   `{名}` 的 `CALLNAME:(角色号)` 派生——**全部在 adapter 的 foreach-emit 里**；
 * - `#DIM`/`#DIMS` 声明按 core 的槽类型事实落（int → #DIM，string → #DIMS）；
 * - 绑定名在循环体内改写、出体失效；$# @织/$# 机 wrapper 契约不变。
 */
import { describe, expect, it } from 'vitest';

import type { KojoExprText } from '@kojo/kojo-core';
import { createKojo2TranspileService } from '@kojo/plugin-kojo-sugar';

import { ERATW_GAME_ADAPTER } from '../../src/kojo2/index.js';
import { createEratwEmitBackend } from '../../src/kojo2/backend.js';

/** 确定性表达式端口：core 已把绑定名换成隐藏槽，这里只透传源文本 */
function compileExpression(expr: KojoExprText): string {
  return expr.text;
}

function service() {
  return createKojo2TranspileService({
    adapter: ERATW_GAME_ADAPTER,
    backend: createEratwEmitBackend({ compileExpression, charNo: '12' }),
  });
}

const SOURCE = [
  '# 视 灵梦',
  '# 机 初见',
  '# 变量 队伍状态 字符串[4]',
  '@巡 队伍',
  '    ? {角} >= 2',
  '        灵梦：「{名}，轮到你了。」',
  '@巡 队伍状态',
  '    > 第{下标 + 1}位：{值}。',
  '> 都结束了。',
].join('\n');

describe('eraTW @巡：全链 golden（.kojo2 → ERB 逐字节）', () => {
  it('角色集合 + 数组两条索引循环的真实产物逐字节', () => {
    const result = service().transpile({ source: SOURCE, filePath: 'kojo2-foreach.kojo2' });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.erb).toBe(EXPECTED_ERB);
    expect(result.sourceMap.lineCount).toBe(result.erb.split('\n').length - 1);
  });

  it('空集合（常量长度 0）⇒ `FOR i, 0, 0` 零轮（不先跑一轮空体）', () => {
    const source = [
      '# 视 灵梦',
      '# 机 初见',
      '# 常量 零 整数 = 0',
      '# 变量 空表 整数[零]',
      '@巡 空表',
      '    > 不该出现。',
    ].join('\n');
    const result = service().transpile({ source, filePath: 'kojo2-foreach-empty.kojo2' });

    expect(result.ok).toBe(true);
    const lines = result.erb.slice(0, -1).split('\n');
    const forLine = lines.find((line) => line.trimStart().startsWith('FOR '));
    expect(forLine).toBe('    FOR __kojo_foreach_5_i, 0, 0');
    // 循环体照常排（零轮不会执行），但绝不多出"先跑一轮"的守卫
    expect(result.erb).not.toContain('IF __kojo_foreach_5_i');
  });

  it('嵌套 `@巡`：槽名按各自块头行号、缩进逐层累加（外层绑定在内层仍可见）', () => {
    const source = [
      '# 视 灵梦',
      '# 机 初见',
      '# 变量 状态 字符串[2]',
      '@巡 队伍',
      '    @巡 状态',
      '        > {名}/{值}',
    ].join('\n');
    const result = service().transpile({ source, filePath: 'kojo2-foreach-nested.kojo2' });

    expect(result.ok).toBe(true);
    const lines = result.erb.slice(0, -1).split('\n');
    const start = lines.findIndex((line) => line.trimStart() === 'FOR __kojo_foreach_4_i, 0, CHARANUM - 1');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + 8)).toEqual([
      '    FOR __kojo_foreach_4_i, 0, CHARANUM - 1',
      '        __kojo_foreach_4_e = __kojo_foreach_4_i + 1',
      '        __kojo_foreach_4_n = CALLNAME:(__kojo_foreach_4_e)',
      '        FOR __kojo_foreach_5_i, 0, 2',
      '            __kojo_foreach_5_e = 状态:(__kojo_foreach_5_i)',
      // `/` 是格式串元字符 → core 的唯一编码器转义成 `\/`（既有口径，不是本次改动）
      String.raw`            PRINTFORMW %__kojo_foreach_4_n%\/%__kojo_foreach_5_e%`,
      '        NEXT',
      '    NEXT',
    ]);
  });

  it('未声明集合 fail-closed：error、零字节、零 ERB 关键字', () => {
    const source = ['# 视 灵梦', '# 机 初见', '@巡 不存在', '    > 一'].join('\n');
    const result = service().transpile({ source, filePath: 'kojo2-foreach-bad.kojo2' });

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/expr/unknown-symbol']);
    expect(result.diagnostics[0]?.message).toContain('队伍');
  });
});

/* ============================== golden ============================== */

/**
 * 期望 ERB（**逐字节**）：`# 机 初见` wrapper（口上函数 `M_KOJO_ENCOUNTER_K12` + 伴生 `_1`
 * + 五个 `@巡` 隐藏槽的 `#DIM/#DIMS` + 記入チェック信封）→ 两条索引循环 → 收尾行。
 *
 * 关键事实：
 * - `FOR <下标>, 0, <长度>` 结束值不含：角色集合是 `CHARANUM - 1`，数组是声明长度 4；
 * - 数组元素取法 `队伍状态:(下标)`（Emuera 数组下标语法），角色号 = `下标 + 1`；
 * - `{名}` = `CALLNAME:(角色号)`（adapter 的 nameAccessor 事实）；
 * - 绑定名在体内已换槽（`__kojo_foreach_*`），出体后的 `都结束了。` 不受影响。
 */
const EXPECTED_ERB = String.raw`;kojo2: # 机 初见
@M_KOJO_ENCOUNTER_K12
CALL M_KOJO_ENCOUNTER_K12_1
RETURN RESULT

@M_KOJO_ENCOUNTER_K12_1
#DIM __kojo_foreach_4_i
#DIM __kojo_foreach_4_e
#DIMS __kojo_foreach_4_n
#DIM __kojo_foreach_7_i
#DIMS __kojo_foreach_7_e
;-------------------------------------------------
;記入チェック（=0, 非表示、1, 表示）
LOCAL = 1
;-------------------------------------------------
IF LOCAL
    FOR __kojo_foreach_4_i, 0, CHARANUM - 1
        __kojo_foreach_4_e = __kojo_foreach_4_i + 1
        __kojo_foreach_4_n = CALLNAME:(__kojo_foreach_4_e)
        SIF __kojo_foreach_4_e >= 2
        PRINTFORMW %__kojo_foreach_4_n%，轮到你了。
    NEXT
    FOR __kojo_foreach_7_i, 0, 4
        __kojo_foreach_7_e = 队伍状态:(__kojo_foreach_7_i)
        PRINTFORMW 第%__kojo_foreach_7_i + 1%位：%__kojo_foreach_7_e%。
    NEXT
    PRINTFORMW 都结束了。
ENDIF
RETURN 1
`;
