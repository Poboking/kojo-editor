/**
 * 预处理条件块 `[IF xxx]` / `[IF_DEBUG]` / `[IF_NDEBUG]` … `[ENDIF]` 的配对体检。
 *
 * 语法事实（Era Wiki `Emuera/exfunc` §4.3–4.9、`Emuera/ERH` §プリプロセッサ）：
 * - `[IF XXX]` / `[ELSEIF XXX]` / `[ELSE]` / `[ENDIF]` 按"宏 XXX 是否 `#DEFINE`"分支；
 * - `[IF_DEBUG]` / `[IF_NDEBUG]` 按调试模式分支，**与 `[IF XXX]` 共用同一枚 `[ENDIF]`**；
 * - 被裁掉的那一支**可以合法不配平**（引擎裁剪后才编译）⇒ 体检必须用独立栈，
 *   不能把它并进 ERB 控制流那张栈，否则一条正确写法会刷出两条假缺陷。
 *
 * 本文件还钉住"两处落地同一份语言事实"（插件侧 `structure.ts` 与语言包
 * `erb-syntax-tree/src/index.ts` 的折叠配对）——对拍表不一致即红。
 */
import { describe, expect, it } from 'vitest';
import { checkControlFlowStructure, checkPreprocStructure, preprocRoleOf } from '../src/structure';
// 语言包走相对路径：插件不得依赖语言包（audit C），但**测试**要能把两处判据对拍起来
import { preprocRoleOf as preprocRoleOfLanguage } from '../../../erb-syntax-tree/src/index';

const lines = (...rows: string[]): string => rows.join('\n');

describe('preprocRoleOf · 三种角色与严格等值判据', () => {
  it('开块三形：`[IF XXX]` / `[IF_DEBUG]` / `[IF_NDEBUG]`（大小写不敏感）', () => {
    for (const s of ['[IF XXX]', '[IF 口上]', '[IF_DEBUG]', '[IF_NDEBUG]', '[if xxx]', '[If_Debug]']) {
      expect(preprocRoleOf(s), s).toBe('open');
    }
  });

  it('分支两形与收尾一形', () => {
    expect(preprocRoleOf('[ELSEIF XXX]')).toBe('branch');
    expect(preprocRoleOf('[ELSE]')).toBe('branch');
    expect(preprocRoleOf('[ENDIF]')).toBe('close');
  });

  it('非标记一律不认：`[IF]` 无宏名 / 带尾巴 / 别的方括号行', () => {
    for (const s of ['[IF]', '[ENDIF] 尾巴', '[SKIPSTART]', '[RANDOMIZE]', '[[跳蛋]]', '[IF_DEBUG] 注']) {
      expect(preprocRoleOf(s), s).toBeNull();
    }
  });

  it('对拍：语言包（折叠配对）与本插件（波浪线）同一份判据', () => {
    const samples = [
      '[IF XXX]', '[IF 口上]', '[IF_DEBUG]', '[IF_NDEBUG]', '[if xxx]', '[If_Debug]',
      '[ELSEIF XXX]', '[ELSE]', '[else]', '[ENDIF]', '[endif]',
      '[IF]', '[ENDIF] 尾巴', '[SKIPSTART]', '[RANDOMIZE]', '[[跳蛋]]', '[IF_DEBUG] 注',
      'IF X', 'ENDIF', '', '[IF_DEBUGX]', '[IF_DEBUG X]',
    ];
    for (const s of samples) expect(preprocRoleOfLanguage(s), s).toBe(preprocRoleOf(s));
  });
});

describe('checkPreprocStructure · 配对体检', () => {
  it('配平的块零发现（含 `[IF XXX]` + 分支 + 调试位两形）', () => {
    const text = lines(
      '[IF XXX]',
      'PRINTL A',
      '[ELSEIF YYY]',
      'PRINTL B',
      '[ELSE]',
      'PRINTL C',
      '[ENDIF]',
      '[IF_DEBUG]',
      'PRINTL D',
      '[ENDIF]',
      '[IF_NDEBUG]',
      'PRINTL E',
      '[ENDIF]',
    );
    expect(checkPreprocStructure(text)).toEqual([]);
  });

  it('未闭合：报在开块行，closer = `[ENDIF]`，修复点在文末（💡 补回走既有 unclosed-open 通道）', () => {
    const text = lines('@F', '[IF_DEBUG]', 'PRINTL A', 'RETURN');
    const issues = checkPreprocStructure(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'unclosed-open',
      line: 2,
      statement: '[IF_DEBUG]',
      closer: '[ENDIF]',
      fixBeforeLine: 5,
    });
  });

  it('孤儿 `[ENDIF]`：orphan-close；无主 `[ELSE]` / `[ELSEIF]`：orphan-branch', () => {
    expect(checkPreprocStructure('[ENDIF]')[0]).toMatchObject({ kind: 'orphan-close', line: 1, statement: '[ENDIF]' });
    expect(checkPreprocStructure('[ELSE]')[0]).toMatchObject({ kind: 'orphan-branch', line: 1, statement: '[ELSE]' });
    expect(checkPreprocStructure('[ELSEIF XXX]')[0]).toMatchObject({
      kind: 'orphan-branch',
      line: 1,
      statement: '[ELSEIF XXX]',
    });
  });

  it('停用区里的标记不算（引擎不编译那段）', () => {
    const text = lines('[SKIPSTART]', '[IF_DEBUG]', '[ENDIF]', '[ENDIF]', '[SKIPEND]');
    expect(checkPreprocStructure(text)).toEqual([]);
  });

  it('嵌套：内层先收，外层未收只报外层', () => {
    const text = lines('[IF XXX]', '[IF_DEBUG]', 'PRINTL A', '[ENDIF]');
    const issues = checkPreprocStructure(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'unclosed-open', line: 1, statement: '[IF XXX]' });
  });
});

describe('与控制流体检合并：独立栈，互不污染', () => {
  it('被裁支不配平是合法的：`[IF_DEBUG]` 里开 IF、`[ENDIF]` 之后才 ENDIF ⇒ 零发现', () => {
    const text = lines(
      '@F',
      '[IF_DEBUG]',
      'IF FLAG:1',
      'PRINTL A',
      '[ENDIF]',
      'ENDIF',
      'RETURN',
    );
    expect(checkControlFlowStructure(text)).toEqual([]);
  });

  it('两族问题同时存在时按行归并（不是两段拼接）', () => {
    const text = lines('[IF XXX]', 'IF FLAG:1', 'PRINTL A');
    const issues = checkControlFlowStructure(text);
    expect(issues.map((i) => [i.kind, i.line])).toEqual([
      ['unclosed-open', 1], // 预处理块未闭合
      ['unclosed-open', 2], // IF 未闭合
    ]);
  });
});
