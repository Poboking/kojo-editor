import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { KOJO_COMPLETION_ASSEMBLY } from '../src/monaco/kojo-completion';
import { kojoCodePositionAt } from '../src/monaco/kojo-suggest-gate';

/**
 * QSUG-1 · `.kojo` 快建议代码门。
 *
 * 全局 `quickSuggestions` 打开后，台词 / 旁白行必须在 provider 侧整轮零候选；
 * 同时不能把"正在写代码"的瞬间（关键字前缀、块头参数位、`{}` 插值）误杀。
 * 句尾光标（`line.length + 1`）是绝大多数用例的真实位置。
 */
const atEnd = (line: string): boolean => kojoCodePositionAt(line, line.length + 1);

describe('kojoCodePositionAt：台词 / 旁白 / 注释不供', () => {
  it.each([
    ['纯旁白', '她今天心情很好'],
    ['自机台词', '你：今天天气不错'],
    ['角色台词', '她：「你好」'],
    ['心形台词', '心形 「今天真好」'],
    ['行内半角分号文本', '她说；不要'],
    ['整行注释', '; 这是注释'],
    ['台词里的调用字样', '她：调用 他'],
  ])('%s ⇒ false', (_name, line) => {
    expect(atEnd(line)).toBe(false);
  });

  it('台词 / 旁白里的 {…} 插值仍是代码位', () => {
    expect(atEnd('她：{她的')).toBe(true);
    expect(atEnd('心形 「{她的')).toBe(true);
    expect(atEnd('她说「{角色12的')).toBe(true);
  });
});

describe('kojoCodePositionAt：代码位 / 正在写关键字的瞬间', () => {
  it.each([
    ['空行', '   '],
    ['行首关键字前缀：如', '如'],
    ['行首关键字前缀：调', '调'],
    ['行首关键字前缀：设', '设'],
    ['英文别名前缀：if', 'if'],
    ['块头参数位：时机 指', '时机 指'],
    ['块头参数位：如果 好感度 ', '如果 好感度 '],
    ['调用名槽：调用 ', '调用 '],
    ['函数名槽：函数 ', '函数 '],
    ['分支值位：是 ', '是 '],
    ['赋值行', '她的心情 = 1'],
    ['文件头声明', '角色: 12'],
    ['原生直通行', 'CALL 名字'],
    ['$标签行', '$标签'],
    ['原生 @ 块', '@函数名'],
  ])('%s ⇒ true', (_name, line) => {
    expect(atEnd(line)).toBe(true);
  });

  it('只是像关键字但不是前缀的散文 ⇒ false', () => {
    expect(atEnd('她的心情')).toBe(false);
    expect(atEnd('她的心情 很好')).toBe(false);
    expect(atEnd('如果她走了')).toBe(false);
    expect(atEnd('她 如果')).toBe(false);
    expect(atEnd('你：')).toBe(false);
  });

  it('代码行里的字符串 / 注释仍清零', () => {
    expect(atEnd('调用 foo("文本')).toBe(false);
    expect(atEnd('调用 foo() ; 注释')).toBe(false);
  });
});

describe('KOJO_COMPLETION_ASSEMBLY.locate 接线', () => {
  function modelOf(line: string): Monaco.editor.ITextModel {
    return {
      getLineContent: () => line,
      getWordUntilPosition: (position: Monaco.Position) => ({
        word: '',
        startColumn: position.column,
        endColumn: position.column,
      }),
    } as unknown as Monaco.editor.ITextModel;
  }

  it('台词行整轮 undefined（连词表都不出货）', () => {
    const scale = KOJO_COMPLETION_ASSEMBLY.locate(
      undefined as unknown as typeof Monaco,
      modelOf('她今天心情很好'),
      { lineNumber: 1, column: 9 } as Monaco.Position,
    );
    expect(scale).toBeUndefined();
  });

  it('代码行照常给替换区间（行首关键字参数位）', () => {
    const location = KOJO_COMPLETION_ASSEMBLY.locate(
      undefined as unknown as typeof Monaco,
      modelOf('如果 获取'),
      { lineNumber: 1, column: 6 } as Monaco.Position,
    );
    expect(location).toBeDefined();
    expect(location!.range.startLineNumber).toBe(1);
  });
});
