import { describe, expect, it } from 'vitest';

import { compileMonarch, driveLine, driveLexer, stubMonaco } from './monarch-harness';
import type { CompiledLexer, MonarchRule } from './monarch-harness';

/**
 * ERB-PAINT-21 批（2026-10-26）：基座补 `switchTo` / `goBack` 与「空 token 也照样转移」三条动作语义。
 *
 * 为什么要动基座：内联三元 `\@…?…#…\@` 的相位机（cond→true→false）必须**换态而不压栈**——
 * Monarch 的 `next: '@state'` 是 push，而闭合 `\@` 处需要"一次弹三层"，可 monarchLexer 没有那个动词
 * （实测 `monarchCompile.js::compileAction` L250-296 只抄 `token / next / bracket / goBack / switchTo /
 * log / nextEmbedded`，`{pop:n}` 不在词表里）。唯一合法表达就是 `switchTo`（`monarchLexer.js` L574-586
 * 的 `stack.switchTo(s) = create(this.parent, s)`）。
 *
 * 每条判据都对着 monaco-editor 同版本源码抄，并各带一条反向自证，防止"基座自洽、真 lexer 不同意"。
 */
describe('monarch-harness 的动作语义：switchTo / goBack / 空 token 转移', () => {
  it('switchTo 换栈顶**不压栈**：父栈逐字保留（后续 @pop 回到 root，不是回到被换掉的那层）', async () => {
    const lexer = await compileMonarch('probe-switchto', {
      tokenizer: {
        root: [
          [/a/, { token: 'x', next: '@p' }],
          [/[^a]+/, 'plain'],
        ],
        p: [[/b/, { token: 'y', switchTo: 'q' }], [/d/, { token: 'd-token', next: '@pop' }]],
        q: [[/c/, { token: 'z', next: '@pop' }]],
      },
    });
    const line = driveLexer(lexer, 'abcd');
    // 若 switchTo 被实现成 push，`c` 的 @pop 会退回 p，`d` 就发 `d-token`；发 plain 才证明是换层
    expect(line.map((e) => `${e.text}=${e.token}`)).toEqual([
      `a=x${lexer.tokenPostfix}`,
      `b=y${lexer.tokenPostfix}`,
      `c=z${lexer.tokenPostfix}`,
      `d=plain${lexer.tokenPostfix}`,
    ]);
  });

  it('switchTo 指向没有规则表的状态 ⇒ 抛（真实 lexer 在此同样抛，不许静默当普通态跑）', async () => {
    const lexer = await compileMonarch('probe-switchto-bad', {
      tokenizer: {
        root: [
          [/a/, { token: 'x', switchTo: 'nowhere' }],
          [/b/, 'plain'],
        ],
      },
    });
    expect(() => driveLexer(lexer, 'ab')).toThrow(/switchTo 指向没有规则表的状态 nowhere/);
  });

  it('同一条动作里 switchTo 与 next 都在 ⇒ 只有 switchTo 生效（抄 monarchLexer 的 else-if 优先级）', async () => {
    const lexer = await compileMonarch('probe-precedence', {
      tokenizer: {
        root: [
          [/a/, { token: 'x', switchTo: 's1', next: 's2' }],
          [/[^a]+/, 'plain'],
        ],
        s1: [[/b/, 'from-s1']],
        s2: [[/b/, 'from-s2']],
      },
    });
    expect(driveLexer(lexer, 'ab').map((e) => e.token)).toEqual([
      `x${lexer.tokenPostfix}`,
      `from-s1${lexer.tokenPostfix}`,
    ]);
  });

  it('空 token 的 `{ token: ”, next }` 照样转移（旧基座在这里把状态变化一起吞了）', async () => {
    const lexer = await compileMonarch('probe-empty-token', {
      tokenizer: {
        root: [
          [/a/, { token: '', next: '@s1' }],
          [/[^a]+/, 'plain'],
        ],
        s1: [[/b/, 'in-s1']],
      },
    });
    const line = driveLexer(lexer, 'ab');
    expect(line.map((e) => e.text)).toEqual(['b']); // 空 token 不发射（monarchLexer 的 group 分支同调）
    expect(line[0]!.token).toBe(`in-s1${lexer.tokenPostfix}`); // …但状态已经进 s1
  });

  it('goBack 回退游标：同一段文本能被后续规则重新吃（抄 L571-573 的 pos = max(0, pos-n)）', async () => {
    const lexer = await compileMonarch('probe-goback', {
      tokenizer: {
        root: [
          [/abc/, { token: 'x', goBack: 2 }],
          [/bc/, 'again'],
          [/z/, 'plain'],
        ],
      },
    });
    expect(driveLexer(lexer, 'abcz').map((e) => `${e.text}=${e.token}`)).toEqual([
      `abc=x${lexer.tokenPostfix}`,
      `bc=again${lexer.tokenPostfix}`,
      `z=plain${lexer.tokenPostfix}`,
    ]);
  });

  /** 反向自证：把编译产物里的 switchTo 抹掉＝模拟基座没实现这条动作 ⇒ 三相位轨迹必须变形 */
  it('自证：动作里不存在 switchTo 时，同样的 def 走不出第二相位（钉子有牙）', async () => {
    const def = {
      tokenizer: {
        root: [
          [/a/, { token: 'x', next: '@p' }],
          [/[^a]+/, 'plain'],
        ],
        p: [[/b/, { token: 'y', switchTo: 'q' }], [/d/, 'plain']],
        q: [[/c/, 'from-q']],
      },
    };
    const lexer = await compileMonarch('probe-selftest', def);
    const stripped = stripSwitchTo(lexer);
    // 真基座：b 换态到 q ⇒ c 发 from-q
    expect(driveLexer(lexer, 'abc').map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(driveLexer(lexer, 'abc').some((e) => e.token.startsWith('from-q'))).toBe(true);
    // 抹掉 switchTo：b 之后仍停在 p ⇒ `c` 没有规则 ⇒ 驱动器按 defaultToken 吃字符、不产 from-q
    expect(driveLexer(stripped, 'abc').some((e) => e.token.startsWith('from-q'))).toBe(false);
  });

  it('stubMonaco 与既有消费方零改动：只带 token 字符串 / next 的老动作逐字同旧', async () => {
    const { monaco, captured } = stubMonaco();
    expect(monaco.languages.getLanguages()).toEqual([]);
    const lexer = await compileMonarch('probe-legacy', {
      tokenizer: {
        root: [
          [/"/, { token: 'str', bracket: '@open', next: '@inner' }],
          [/[^"]+/, 'plain'],
        ],
        inner: [
          [/x/, 'xx'],
          [/"/, { token: 'str', bracket: '@close', next: '@pop' }],
        ],
      },
    });
    expect(captured.monarchs.size).toBe(0);
    expect(driveLexer(lexer, 'ay').map((e) => e.text)).toEqual(['ay']);
    const two = driveLine(lexer, '"x"');
    expect(two.emitted.map((e) => e.text)).toEqual(['"', 'x', '"']);
    expect(two.stack).toEqual(['root']);
  });
});

/** 深拷一层 tokenizer，把所有动作对象的 switchTo 摘掉（模拟"基座未实现该动作"） */
function stripSwitchTo(lexer: CompiledLexer): CompiledLexer {
  const tokenizer: Record<string, MonarchRule[]> = {};
  for (const [state, rules] of Object.entries(lexer.tokenizer)) {
    tokenizer[state] = rules.map((rule) => {
      const action = rule.action as { switchTo?: string } | null;
      if (action && typeof action === 'object' && 'switchTo' in action) {
        const clone = { ...action } as { switchTo?: string };
        delete clone.switchTo;
        return { ...rule, action: clone as MonarchRule['action'] };
      }
      return rule;
    });
  }
  return { ...lexer, tokenizer };
}
