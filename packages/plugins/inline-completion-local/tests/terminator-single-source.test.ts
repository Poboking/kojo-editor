/**
 * 名字槽**结束判据**的单一真源对拍（组长在 B 车道交付后补的一枚闸）。
 *
 * 来历：B 车道自己在 `src/slot-shape.ts` 的头注里报了这笔债——`NAME_TERMINATORS` 与
 * `erb-parser/scanner.ts::parseFunctionDefinition` 的五个分隔符是**逐字同一套**，但因为
 * 插件之间禁止交叉 import（铁律 3 / 审计 C），本包只能最小复写 + 注明出处。长期解是把
 * 这张表提到 `plugin-api`（先例 `erb-code-prefix.ts`，那枚就是为了同一件事进契约层的）；
 * 可开机图现在只剩 3 KB 余量，为一张五个字符的表再进一枚常驻模块不值当。
 *
 * 于是换一条不花钱的路：**把"复写会漂"这件事本身钉住**。漂移的表现很具体——幽灵文本
 * 多吃掉一截实参，或者该补的那一格不出字；两种都表现为"有时候对有时候不对"，没人会去查
 * 两张表。这条闸红的时候，报错直接指出是解析器那侧加了字符还是本包少写了字符。
 *
 * 口径三条：
 * - 这是**源码文本**对拍（`readFileSync`），不是模块 import——审计 C 拦的是 `import` 语句，
 *   跨包读源码做判据在测试侧是既有形态（`language-service-kinds.test.ts`、本包 `corpus.test.ts`
 *   都这么跨）；
 * - 判据是**单向包含 + 余集逐枚点名**：解析器的集必须 ⊆ 本包集（少一枚 = 本包会多吃字面），
 *   本包多出来的必须恰好是注释里声明过的那四枚"安全侧"（`\r` `\n` `；` `，`）——
 *   多出来不算错（只会让槽更短、更保守），**偷偷多出来**才算错；
 * - 解析器那行判据要是被改成非字面量形式（比如换成 `Set` 或正则），本闸**当场红**而不是
 *   静默通过：抽取函数对"没抽到五枚"直接抛错。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAME_TERMINATORS_FOR_TEST } from '../src/slot-shape';

/** 解析器那枚 `if (c === '(' || c === ',' …)` 的字符集（**唯一真源侧**） */
function parserDelimiters(): string[] {
  const src = readFileSync(
    fileURLToPath(new URL('../../erb-parser/src/scanner.ts', import.meta.url)),
    'utf8',
  );
  const line = src
    .split('\n')
    .find((l) => /c === '\('/.test(l));
  if (!line) {
    throw new Error(
      '对拍失效：`erb-parser/src/scanner.ts` 里找不到那行 `c === \'(\' || …` 的分隔符判据' +
        '（解析器改了写法？那就把本闸的抽取一起改掉，别让它静默绿灯）',
    );
  }
  const chars = [...line.matchAll(/c === '(.*?)'/g)].map((m) => {
    const raw = m[1] as string;
    // 源码里 `'\t'` 是**两个字符**（反斜杠 + t），必须还原成真制表符再比——
    // 首跑就是栽在这里：拿 `"\\t"` 去查集合，查到的是一枚漏写（红得对，但红因是抽取器）。
    if (raw.length === 2 && raw[0] === '\\') {
      const esc = { t: '\t', r: '\r', n: '\n' }[raw[1] as string];
      if (esc === undefined) throw new Error(`抽取器不认的转义：\\${raw[1]}`);
      return esc;
    }
    return raw;
  });
  if (chars.length < 5) throw new Error(`对拍失效：只从那一行抽出 ${chars.length} 枚分隔符，判据形状变了`);
  return chars;
}

/** 本包头注里**声明过**的"安全侧"补集（多它们是对的，多别的要问为什么） */
const DECLARED_SAFE_ADDITIONS = ['\r', '\n', '；', '，'];

describe('名字槽结束判据与 erb-parser 的分隔符表对拍', () => {
  const parser = parserDelimiters();

  it('解析器那五枚一枚都不许少（少了 = 幽灵文本会吃掉后面的实参）', () => {
    for (const ch of parser) {
      expect(NAME_TERMINATORS_FOR_TEST.has(ch), `本包漏了分隔符 ${JSON.stringify(ch)}`).toBe(true);
    }
  });

  it('本包多出来的必须恰好是声明过的那四枚安全侧（不许悄悄多）', () => {
    const extras = [...NAME_TERMINATORS_FOR_TEST].filter((ch) => !parser.includes(ch)).sort();
    expect(extras).toEqual([...DECLARED_SAFE_ADDITIONS].sort());
  });

  it('安全侧四枚的"只让槽更短"性质成立：它们都不是名字字符', () => {
    // 名字段落在这些字符上必须断开——否则"更保守"的说法就是假的（比如把 ; 当名字字符会连读）
    for (const ch of DECLARED_SAFE_ADDITIONS) {
      expect(NAME_TERMINATORS_FOR_TEST.has(ch)).toBe(true);
    }
    // 反过来钉一件没钉过的事：全角逗号/分号在解析器侧**不是**分隔符，所以作者用全角标点时
    // 本包会比解析器更早断开（安全侧），而解析器会把那一整串当一个名字——两处行为**故意**不同。
    expect(parser).not.toContain('，');
    expect(parser).not.toContain('；');
  });
});
