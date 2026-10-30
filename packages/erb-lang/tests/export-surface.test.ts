/**
 * `@kojo/erb-lang` 的**导出面清单**闸。
 *
 * 判据住包之后，导出面就是"插件与宿主能依赖什么"的契约：
 * - 多一个内部类型 = 有人开始依赖它 = 以后删它要破人；
 * - 少一个 = 消费方被迫去拔别人的 `src/`（那正是本包要消除的事）。
 *
 * 两条腿（缺一条就是假绿）：
 * 1. **值面**：真 `import` 后取 `Object.keys`（型面清单可能漂、值面不会）；
 * 2. **桶自证**：桶的运行时键必须**恰好**等于两个值叶子之并集，防"桶里多 re-export
 *    了一枚没人知道的模块"。
 *
 * 子路径导出（`package.json` 的 `exports`）也在这里对拍：三枚叶子缺任一，宿主与插件的
 * `@kojo/erb-lang/<leaf>` 立刻解析不到，而 tsc / vitest 的别名表**各配一份**、漏一处
 * 也只在特定通道红——清单是把那件事说死的地方。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as barrel from '../src/index.js';
import * as completionBits from '../src/completion-bits.js';
import * as completionFamilies from '../src/completion-families.js';
import * as completionItem from '../src/completion-item.js';
import * as completionContext from '../src/completion-context.js';
import * as completionVariables from '../src/completion-variables.js';
import * as constants from '../src/constants.js';
import * as highlight from '../src/highlight.js';
import * as selectionRange from '../src/selection-range.js';

const leafKeys = (mod: Record<string, unknown>): string[] => Object.keys(mod).sort();

describe('@kojo/erb-lang 导出面', () => {
  it('constants 的运行时导出 = 清单（1 枚：认 ERB 请求的语言 id 清单）', () => {
    expect(leafKeys(constants)).toEqual(['ERB_LANGUAGE_IDS']);
  });

  it('highlight 的运行时导出 = 清单（5 枚；判据入口 + 结构事实 + 两枚字符/词工具）', () => {
    expect(leafKeys(highlight)).toEqual([
      'erbCodeViewOf',
      'erbDocumentHighlights',
      'erbStructureOf',
      'erbWordAt',
      'isErbNameChar',
    ]);
  });

  it('selection-range 的运行时导出 = 清单（2 枚：对齐版 + 过滤版）', () => {
    expect(leafKeys(selectionRange)).toEqual([
      'erbSelectionRangeAt',
      'erbSelectionRangeChainsAt',
    ]);
  });

  it('completion-bits 的运行时导出 = 清单（5 枚：位槽扫描 + 空槽判据）', () => {
    expect(leafKeys(completionBits)).toEqual([
      'erbBitSlotOpen',
      'erbBitSlotRegionBlank',
      'findBitSlot',
      'matchingParen',
      'topLevelComma',
    ]);
  });

  it('completion-families 的运行时导出 = 清单（3 枚：族头候选 + 裸标识符名位 + sigil 排除集）', () => {
    expect(leafKeys(completionFamilies)).toEqual([
      'ERB_SIGIL_BEFORE',
      'erbDeclaredNameSlot',
      'erbFamilyCandidates',
    ]);
  });

  it('completion-item 只有类型（零运行时导出，桶里不多出任何键）', () => {
    expect(leafKeys(completionItem)).toEqual([]);
  });

  it('completion-variables 的运行时导出 = 清单（3 枚：段解析 + 两侧的面）', () => {
    expect(leafKeys(completionVariables)).toEqual([
      'erbVariableContextAt',
      'erbVariableReferenceSlotAt',
      'erbVariableSlotAt',
    ]);
  });

  it('completion-context 的运行时导出 = 清单（13 枚：九态门 + 语句表 + 名字槽 + 标签位 + 白名单）', () => {
    expect(leafKeys(completionContext)).toEqual([
      'DEF_RE',
      'ERB_CALL_SLOT_BY_KEYWORD',
      'ERB_CALL_STATEMENTS',
      'ERB_GATE_SOURCE_WHITELIST',
      'ERB_JUMP_KEYWORDS',
      'NAME_CHAR_RE',
      'erbCallKeywords',
      'erbCallStatementRe',
      'erbCodeViewOf',
      'erbCompletionGate',
      'erbInterpRegionAt',
      'erbLabelSlot',
      'parseErbNameSlot',
    ]);
  });

  it('桶的运行时键 = 值叶子之并集', () => {
    // `erbCodeViewOf` 在 `completion-context` 与 `highlight` 各有一枚（同名不同判据：
    // 前者"到光标为止的视野"、后者"整行视野"）——桶按名去重后恰好一份，集合语义不受影响。
    const expected = new Set<string>([
      ...leafKeys(completionBits),
      ...leafKeys(completionFamilies),
      ...leafKeys(completionItem),
      ...leafKeys(completionContext),
      ...leafKeys(completionVariables),
      ...leafKeys(constants),
      ...leafKeys(highlight),
      ...leafKeys(selectionRange),
    ]);
    expect(leafKeys(barrel)).toEqual([...expected].sort());
  });

  it('package.json 的 exports 恰是桶 + 五枚叶子（宿主与插件按子路径引，漏一枚即解析不到）', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports?: Record<string, string> };
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([
      '.',
      './completion-bits',
      './completion-context',
      './completion-families',
      './completion-item',
      './completion-variables',
      './constants',
      './highlight',
      './selection-range',
    ]);
  });

  it('三档高亮的口径与契约同名同值域（供方原样搬运，不在这里造第四种写法）', () => {
    const kinds = new Set(
      highlight
        .erbDocumentHighlights(
          ['@F()', '    CALL F()', '    PRINTL F'].join('\n'),
          { line: 1, column: 2 },
        )
        .map((hit) => hit.kind),
    );
    expect([...kinds].sort()).toEqual(['read', 'text', 'write']);
  });
});
