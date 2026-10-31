/**
 * `@kojo/erb-lang` 的**导出面清单**闸。
 *
 * 判据住包之后，导出面就是"插件与宿主能依赖什么"的契约：
 * - 多一个内部类型 = 有人开始依赖它 = 以后删它要破人；
 * - 少一个 = 消费方被迫去拔别人的 `src/`（那正是本包要消除的事）。
 *
 * 两条腿（缺一条就是假绿）：
 * 1. **值面**：真 `import` 后取 `Object.keys`（型面清单可能漂、值面不会）；
 * 2. **桶自证**：桶的运行时键必须**恰好**等于各值叶子之并集，防"桶里多 re-export
 *    了一枚没人知道的模块"。
 *
 * 子路径导出（`package.json` 的 `exports`）也在这里对拍：叶子缺任一，宿主与插件的
 * `@kojo/erb-lang/<leaf>` 立刻解析不到，而 tsc / vitest 的别名表**各配一份**、漏一处
 * 也只在特定通道红——清单是把那件事说死的地方。
 *
 * LAU-4 补全腿第二批（2026-10-31）：补全判据的六枚叶子（`completion-bits` /
 * `completion-context` / `completion-families` / `completion-item` / `completion-members` /
 * `completion-variables`）整块搬进常驻解析器插件 `@kojo/plugin-erb-parser`，本包只剩
 * 高亮 / 扩选两条腿——那两条的供方是**懒装载**的 `@kojo/plugin-erb-lang`，不占开机图，
 * 与"槽供方必须常驻"的补全腿不是同一种约束。
 *
 * LAU-1031-SIG（2026-10-31）：签名判据叶 `./signature` 进包（判据出宿主），供方同样是
 * **懒装载**的 `@kojo/plugin-erb-lang`（`erb-signatureHelp`）——与上面那条约束同形，
 * 开机图零进账。宿主 `monaco/kojo-signature.ts` 只留旧桥（kojo1）+ re-export。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as barrel from '../src/index.js';
import * as constants from '../src/constants.js';
import * as highlight from '../src/highlight.js';
import * as selectionRange from '../src/selection-range.js';
import * as signature from '../src/signature.js';

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

  it('signature 的运行时导出 = 清单（12 枚：判据 8 + 取表缝 3 + 窗口常量 1）', () => {
    expect(leafKeys(signature)).toEqual([
      // 取表缝（LAU-1031-SIG：宿主两张表的模块级登记表，范式照 @kojo/kojo-lang/adapter-source）
      'SIGNATURE_LOOKBACK_LINES',
      'describeCallSignature',
      'describeErbSignature',
      'erbSignatureAt',
      'erbSignatureNow',
      'erbSignatureSourceCount',
      'findCallSite',
      'findCallSiteAt',
      'registerErbSignatureSource',
      'resolveSignature',
      'resolveSignatureInText',
      'splitArguments',
    ]);
  });

  it('桶的运行时键 = 值叶子之并集', () => {
    const expected = new Set<string>([
      ...leafKeys(constants),
      ...leafKeys(highlight),
      ...leafKeys(selectionRange),
      ...leafKeys(signature),
    ]);
    expect(leafKeys(barrel)).toEqual([...expected].sort());
  });

  it('补全判据**已不在本包**（LAU-4 补全腿第二批：整块搬进 @kojo/plugin-erb-parser）', () => {
    // 反向钉：谁把补全判据塞回本包，桶里立刻多出 `erbCompletionGate` 一类键 ⇒ 这条红。
    expect(leafKeys(barrel)).not.toContain('erbCompletionGate');
    expect(leafKeys(barrel)).not.toContain('erbFamilyCandidates');
    expect(leafKeys(barrel)).not.toContain('erbMemberSlotAt');
  });

  it('package.json 的 exports 恰是桶 + 四枚叶子（宿主与插件按子路径引，漏一枚即解析不到）', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports?: Record<string, string> };
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([
      '.',
      './constants',
      './highlight',
      './selection-range',
      './signature',
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