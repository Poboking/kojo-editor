/**
 * `.kojo` 结构化着色（B6）单测：判据 = 糖 AST 的节点身份（与大纲/折叠同一棵树）。
 *
 * 走**真解析器**（同 `folding.test.ts`：手搓 AST 证明不了"节点 `loc` 与源行对得上"）。
 * 钉死三件事：
 * 1. **声明位 vs 调用位两类色**（`函数` / `自定指令` 带 `declaration`，`调用` 不带）；
 * 2. **只读性来自右值形态**（规范 §3.1：只有 `别名 … = 变量` 可写；数字 / 角色 / 字符串 /
 *    条件与 `常量` 一律带 `readonly`）——不是宿主猜的；
 * 3. **词法面零触碰**：台词正文里出现的同名散文一条都不产（Monarch 已按台词着色）。
 * 列口径的断言一律把 span 切回原文比对（`cut`）——差一格这种事，写死数字会跟着实现一起错。
 */

import { describe, expect, it } from 'vitest';
import type { EditorSemanticTokenSpan, KojoFaceTable } from '@kojo/plugin-api';
import { createSugarTranspileService } from '../src/service';
import { kojoSemanticTokens } from '../src/semantic-tokens';
import { stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ faceTable: stubFaceTable() as KojoFaceTable });

const tokens = (source: string): EditorSemanticTokenSpan[] =>
  kojoSemanticTokens(svc().parse(source, { filePath: 'C:\\p\\a.kojo' }), source);

/** span 盖住的那串原文（列口径的终极判据） */
function cut(text: string, span: EditorSemanticTokenSpan): string {
  return text.split('\n')[span.line - 1]!.slice(span.startColumn - 1, span.endColumn - 1);
}

const declared = (span: EditorSemanticTokenSpan): boolean => span.modifiers?.includes('declaration') === true;

describe('kojoSemanticTokens · 声明位', () => {
  it('`函数 名字(形参)：`：名字带 `declaration`，形参进 `parameter`', () => {
    const source = '函数 计算伤害(次数, 倍率 = 2)：\n  返回 次数\n';
    const spans = tokens(source);
    const decl = spans.find((s) => s.tokenType === 'function' && declared(s))!;
    expect(cut(source, decl)).toBe('计算伤害');
    expect(spans.filter((s) => s.tokenType === 'parameter').map((p) => cut(source, p))).toEqual(['次数', '倍率']);
  });

  it('`自定指令 名字`：也是 `function` + `declaration`', () => {
    const source = '自定指令 摸摸头：\n  「嗯」\n';
    const decl = tokens(source).find((s) => s.tokenType === 'function' && declared(s))!;
    expect(cut(source, decl)).toBe('摸摸头');
  });

  it('`别名 X = 变量` 可写（不带 readonly）；`= 数字 / 角色 / 字符串` 只读', () => {
    const cases: [string, boolean][] = [
      ['别名 好感 = CFLAG:11:200\n', false],
      ['别名 计数 = 0\n', true],
      ['别名 那人 = 角色 15\n', true],
      ['别名 话 = "小露"\n', true],
    ];
    for (const [source, readonlyExpected] of cases) {
      const [decl] = tokens(source).filter((s) => s.tokenType === 'variable');
      expect(decl, source).toBeDefined();
      expect(cut(source, decl!)).toBe(source.slice('别名 '.length).split(' ')[0]!)
      expect(decl!.modifiers).toContain('declaration');
      expect(decl!.modifiers?.includes('readonly')).toBe(readonlyExpected);
    }
  });

  it('`常量 名字 = 1022`：`variable` + `declaration` + `readonly`（编译期展开，写了也不落盘）', () => {
    const source = '常量 雾雨旗标 = 1022\n';
    const [decl] = tokens(source);
    expect(cut(source, decl!)).toBe('雾雨旗标');
    expect(decl!.tokenType).toBe('variable');
    expect(decl!.modifiers).toEqual(['declaration', 'readonly']);
  });
});

describe('kojoSemanticTokens · 调用位', () => {
  it('`调用 名字(实参)`：`function` 且**不带** `declaration`（与定义两类色）', () => {
    const source = '时机 对话 1：\n  调用 计算伤害(3)\n';
    const spans = tokens(source);
    const call = spans.find((s) => s.tokenType === 'function' && !declared(s))!;
    expect(cut(source, call)).toBe('计算伤害');
  });

  it('嵌套块里的调用也收得到色（按形状遍历，不列 kind 表）', () => {
    const source = ['时机 对话 1：', '  如果 次数 > 0：', '    调用 计算伤害(3)', '  否则：', '    「无」', ''].join('\n');
    const calls = tokens(source).filter((s) => s.tokenType === 'function' && !declared(s));
    expect(calls.map((c) => [c.line, cut(source, c)])).toEqual([[3, '计算伤害']]);
  });
});

describe('kojoSemanticTokens · 词法面零触碰与降级', () => {
  it('台词正文里的同名散文不产 span（那是作者要读的文本，不是记号）', () => {
    const source = '函数 计算伤害(次数)：\n  「计算伤害 这四个字是台词」\n';
    expect(tokens(source).filter((s) => s.line === 2)).toEqual([]);
  });

  it('别名在条件里的**使用点**不画（糖节点只给条件原文，段内没有子记号区间 ⇒ 不猜列）', () => {
    const source = '别名 好感 = CFLAG:11:200\n时机 对话 1：\n  如果 好感 > 3：\n    「好」\n';
    expect(tokens(source).filter((s) => s.tokenType === 'variable').map((s) => s.line)).toEqual([1]);
  });

  it('空文档 → 空数组（认这个文件，但整篇没有结构才知道的名字）', () => {
    expect(tokens('')).toEqual([]);
  });

  it('名字与行文本对不上时不画（宁缺勿编）：改一份 AST 的名字，原文里找不到它 ⇒ 零产出', () => {
    const source = '函数 名字(次数)：\n  返回 1\n';
    const doc = svc().parse(source, { filePath: 'C:\\p\\a.kojo' });
    const tampered = JSON.parse(JSON.stringify(doc));
    tampered.topLevel[0].name = '不在原文里的名字';
    tampered.topLevel[0].params = []; // 形参那条腿也得废掉，否则它仍能在原文里定位到 `次数`
    expect(kojoSemanticTokens(tampered, source)).toEqual([]);
  });
});
