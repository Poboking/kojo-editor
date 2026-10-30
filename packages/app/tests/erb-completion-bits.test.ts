/**
 * D7 · `.erb` **位补全 + 位名悬停**（`erb-completion-bits.ts` + `erb-bits` source）单测。
 *
 * Monaco 绑定刻意薄：桩 monaco（`CompletionItemKind.EnumMember`）+ 桩 model + 桩
 * `VariableSchema`（`lookup` 返回带 `bits` 的 `VariableInfo`），不引真实 monaco-editor 运行时。
 *
 * 三态可复跑（**不猜**是主命题）：
 * (a) 无表 → 零候选 + **恰一次**可见降级信号（且随装配句柄重建，无跨 install 泄漏）；
 * (b) 有桩表 → 四种原语（`GETBIT(` / `SETBIT ` / `CLEARBIT ` / `INVERTBIT `）第二实参坑出候选
 *     （label 展示位号 + 中文位名、documentation = 中文位名、kind = EnumMember、insertText = 位号），
 *     非位槽（普通函数第二实参 / 第一实参 / 无位表的变量）**不**出候选；
 *     位坑已有内容（含写成变量 `LOCAL`）**不**抢候选；
 * (b2) 三段式 `族:角色:名`（批⑧）：名字在**末段**（`TALENT:TARGET:性別` / `TCVAR:TARGET:随便`），
 *     `lookup` 只许收「族 + 单段名」（整段中段名是回归网）；`erbBitSlotOpen`（位置门 / 触发探针）
 *     与候选门共用同一条空判据；
 * (c) 切项目 / 重建表 → 候选刷新，无跨 install 泄漏（去重表随装配句柄创建，非模块级全局）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { VariableInfo, VariableSchema } from '@kojo/plugin-api';
import {
  ERB_COMPLETION_SOURCES,
  installErbCompletion,
  type ErbCompletionDegrade,
  type ErbCompletionTables,
} from '../src/monaco/erb-completion';
import { erbBitCompletionItems, erbBitHoverName, erbBitSlotOpen, findBitSlot } from '../src/monaco/erb-completion-bits';
import { resolveHoverName, installHover, type HoverTables } from '../src/monaco/kojo-hover';

/* ============================== 桩 monaco / model / schema ============================== */

const KIND = { EnumMember: 7 } as const;

function stubMonaco(): {
  monaco: typeof Monaco;
  registered: { languageId: string; provider: Monaco.languages.CompletionItemProvider }[];
} {
  const registered: { languageId: string; provider: Monaco.languages.CompletionItemProvider }[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: KIND,
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, registered };
}

const MONACO = stubMonaco().monaco;

/** 桩 model：`getValue` / `getLineContent` / `getWordUntilPosition`（复刻 Monaco 默认词法） */
function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const m = /[A-Za-z0-9_]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
  } as unknown as Monaco.editor.ITextModel;
}

/** 桩 schema：`CFLAG:1` 有位表（0 接吻 / 2 恋人）、`TFLAG:192` 有位表（1 成功）、其余查无 */
const BITS_CFLAG: ReadonlyArray<{ bit: number; label: string }> = [
  { bit: 0, label: '接吻' },
  { bit: 2, label: '恋人' },
];

/** 三段式桩：`TALENT:TARGET:性別` —— 名字表按**单段**索引（adapter `lookup(name, index)` 语义） */
const BITS_TALENT: ReadonlyArray<{ bit: number; label: string }> = [
  { bit: 0, label: '男性' },
  { bit: 1, label: '女性' },
];

/** 三段式桩：`TCVAR:TARGET:随便` —— 同单段索引语义 */
const BITS_TCVAR: ReadonlyArray<{ bit: number; label: string }> = [{ bit: 5, label: '随意' }];

function schemaA(): VariableSchema {
  return {
    version: 'A',
    lookup: (name: string, index?: number | string): VariableInfo | undefined => {
      if (name === 'CFLAG' && String(index) === '1') {
        return { name: 'CFLAG', index: 1, description: '既成事実', bits: BITS_CFLAG };
      }
      if (name === 'TFLAG' && String(index) === '192') {
        return { name: 'TFLAG', index: 192, bits: [{ bit: 1, label: '成功' }] };
      }
      // 三段式 `族:角色:名`：查的是 ('TALENT', '性別')——中段 `TARGET` 不进表（整段 `TARGET:性別` 必然查不中）
      if (name === 'TALENT' && String(index) === '性別') {
        return { name: 'TALENT', index, description: '性別', bits: BITS_TALENT };
      }
      if (name === 'TCVAR' && String(index) === '随便') {
        return { name: 'TCVAR', index, description: '随便', bits: BITS_TCVAR };
      }
      // 家族级（裸族头）：无机读名表 ⇒ 只给变量名、无位表（复刻 adapter `lookup` 的缺省分支）
      if (name === 'CFLAG' && index === undefined) return { name: 'CFLAG' };
      return undefined;
    },
  } as unknown as VariableSchema;
}

/** 内容不同的第二张 schema（切表可辨；`CFLAG:1` 出另一组位名） */
function schemaB(): VariableSchema {
  return {
    version: 'B',
    lookup: (name: string, index?: number | string): VariableInfo | undefined =>
      name === 'CFLAG' && String(index) === '1'
        ? { name: 'CFLAG', index: 1, bits: [{ bit: 0, label: '别的' }] }
        : undefined,
  } as unknown as VariableSchema;
}

/* ============================== 纯函数 helper ============================== */

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 光标在行尾 */
function itemsOf(marked: string, schema?: VariableSchema | undefined): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const line = marked.replace('|', '');
  const column = (marker >= 0 ? marker : line.length) + 1;
  return erbBitCompletionItems(MONACO, modelOf(line), { lineNumber: 1, column } as Monaco.Position, schema);
}

function hoverAt(marked: string, schema?: VariableSchema | undefined) {
  return resolveHoverName(marked.replace('|', ''), marked.indexOf('|') + 1, { variableSchema: schema } as HoverTables);
}

/** 走 provider 取一轮候选（同步实现 → 桩里直接读建议数组） */
function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  column: number,
  lineNumber = 1,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text),
    { lineNumber, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

/* ============================== (a) 无表 → 零候选 + 恰一次信号 ============================== */

describe('D7 · 位补全 · 无表（fail-closed）', () => {
  it('schema 缺省 ⇒ 纯函数零候选（不猜、不抛）', () => {
    expect(itemsOf('SETBIT CFLAG:1, |', undefined)).toEqual([]);
    expect(itemsOf('GETBIT(CFLAG:1, |)', undefined)).toEqual([]);
    expect(erbBitHoverName('SETBIT CFLAG:1, 0', 16, undefined)).toBeUndefined();
  });

  it('provider：tables 空 ⇒ 该路零候选 + `erb-bits` 降级信号每轮恰一次', () => {
    const degrades: ErbCompletionDegrade[] = [];
    let tables: ErbCompletionTables = {};
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => tables, (d) => degrades.push(d));
    const provider = registered[0]!.provider;
    const bitDegrades = (): number => degrades.filter((d) => d.sourceId === 'erb-bits').length;

    expect(provide(provider, 'SETBIT CFLAG:1, ', 17).some((i) => i.kind === KIND.EnumMember)).toBe(false);
    expect(bitDegrades()).toBe(1);
    provide(provider, 'SETBIT CFLAG:1, ', 17);
    provide(provider, 'GETBIT(CFLAG:1, )', 17);
    expect(bitDegrades()).toBe(3); // 单轮内同一 (来源, 缺键) 只报一次；跨轮每轮各报一次

    // 去重表随装配句柄创建（非模块级全局）：重新 install 一遍仍报一次（不吞信号、不泄漏）
    const degrades2: ErbCompletionDegrade[] = [];
    const m2 = stubMonaco();
    installErbCompletion(m2.monaco, () => ({}), (d) => degrades2.push(d));
    provide(m2.registered[0]!.provider, 'SETBIT CFLAG:1, ', 17);
    expect(degrades2.filter((d) => d.sourceId === 'erb-bits')).toHaveLength(1);
  });

  it('requires 声明在册：`erb-bits` → variableSchema', () => {
    const byId = new Map(ERB_COMPLETION_SOURCES.map((s) => [s.id, s.requires]));
    expect(byId.get('erb-bits')).toBe('variableSchema');
  });
});

/* ============================== (b) 有桩表 → 四种原语位槽出候选 ============================== */

describe('D7 · 位补全 · 四种原语位槽（有表）', () => {
  const line = (head: string): string => `${head} CFLAG:1, `;

  it('`GETBIT(` 表达式形第二实参坑出候选（label = 位号 + 中文位名）', () => {
    const items = itemsOf('GETBIT(CFLAG:1, |)', schemaA());
    expect(labels(items)).toEqual(['0 接吻', '2 恋人']);
    const first = items.find((i) => labels([i])[0] === '0 接吻')!;
    expect(first.kind).toBe(KIND.EnumMember);
    expect(first.insertText).toBe('0');
    expect(first.documentation).toBe('接吻'); // documentation 展示 label
    expect(first.detail).toBe('CFLAG:1');
  });

  it('`SETBIT ` / `CLEARBIT ` / `INVERTBIT ` 语句形逗号之后出候选', () => {
    for (const kw of ['SETBIT', 'CLEARBIT', 'INVERTBIT'] as const) {
      const items = itemsOf(`${line(kw)}|`, schemaA());
      expect(labels(items), kw).toEqual(['0 接吻', '2 恋人']);
    }
  });

  it('位号可为变量/有内容 ⇒ 不抢候选；位坑非空一律不出', () => {
    expect(itemsOf('SETBIT CFLAG:1, |LOCAL', schemaA())).toEqual([]); // 坑里已是变量
    expect(itemsOf('SETBIT CFLAG:1, |0', schemaA())).toEqual([]); // 坑里已有内容
    expect(itemsOf('GETBIT(CFLAG:1, 0|)', schemaA())).toEqual([]); // 已写完整位号
  });

  it('非位槽一律不出：普通函数第二实参 / 第一实参 / 无位表的变量 / 无逗号', () => {
    expect(itemsOf('RAND(1, |)', schemaA())).toEqual([]); // 普通函数第二实参不是位
    expect(itemsOf('GETBIT(|CFLAG:1, 0)', schemaA())).toEqual([]); // 第一实参坑
    expect(itemsOf('SETBIT OTHER:9, |', schemaA())).toEqual([]); // 该变量无位表
    expect(itemsOf('SETBIT CFLAG:1|', schemaA())).toEqual([]); // 逗号之前
  });

  it('注释行 / 字符串内不认（不猜）', () => {
    expect(itemsOf('; SETBIT CFLAG:1, |', schemaA())).toEqual([]);
    expect(itemsOf('PRINTL "SETBIT CFLAG:1, |"', schemaA())).toEqual([]);
  });

  it('provider 端到端：桩表下位槽出货（kind = EnumMember）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ variableSchema: schemaA() }) as ErbCompletionTables);
    const items = provide(registered[0]!.provider, 'SETBIT CFLAG:1, ', 17);
    expect(items.some((i) => typeof i.label === 'string' && i.label === '0 接吻')).toBe(true);
    expect(items.find((i) => i.label === '0 接吻')!.kind).toBe(KIND.EnumMember);
  });
});

/* ============================== 三段式 `族:角色:名`（批⑧） ============================== */

describe('D7 · 位补全 · 三段式 `族:角色:名`（名字在末段）', () => {
  it('`GETBIT(TALENT:TARGET:性別, |)`：中段角色表达式不进表，末段名查中位表', () => {
    const items = itemsOf('GETBIT(TALENT:TARGET:性別, |)', schemaA());
    expect(labels(items)).toEqual(['0 男性', '1 女性']);
    expect(items[0]!.detail).toBe('TALENT:TARGET:性別'); // detail 仍是引用原文（不改写作者输入）
  });

  it('`SETBIT TCVAR:TARGET:随便, |` 出候选；与两段式对拍逐字一致', () => {
    const three = itemsOf('SETBIT TCVAR:TARGET:随便, |', schemaA());
    const two = itemsOf('SETBIT TCVAR:随便, |', schemaA());
    expect(labels(three)).toEqual(['5 随意']);
    // 对拍：三段式 ≡ 两段式（候选内容 / 插入文本逐字一致；range 的列号随行文长度不同，不比）
    expect(labels(three)).toEqual(labels(two));
    expect(three.map((i) => i.insertText)).toEqual(two.map((i) => i.insertText));
    expect(labels(itemsOf('GETBIT(TALENT:性別, |)', schemaA()))).toEqual(['0 男性', '1 女性']);
  });

  it('查表契约（adapter 单段语义）：`lookup` 只收「族 + 单段末段名」；裸族头 ⇒ index 缺省', () => {
    const calls: Array<[string, number | string | undefined]> = [];
    const rec = {
      version: 'rec',
      lookup: (name: string, index?: number | string): VariableInfo | undefined => {
        calls.push([name, index]);
        return schemaA().lookup(name, index);
      },
    } as unknown as VariableSchema;

    itemsOf('GETBIT(TALENT:TARGET:性別, |)', rec);
    expect(calls).toContainEqual(['TALENT', '性別']);
    // 旧缺陷（整段 `TARGET:性別` 当索引）的回归网：索引永不含冒号
    expect(calls.every(([, idx]) => idx === undefined || !String(idx).includes(':'))).toBe(true);

    calls.length = 0;
    expect(itemsOf('SETBIT CFLAG, |', rec)).toEqual([]); // 裸族头：家族级无机读名表 ⇒ 零候选（不猜）
    expect(calls).toEqual([['CFLAG', undefined]]);
  });
});

/* ============================== erbBitSlotOpen（位置门 / 触发探针） ============================== */

describe('D7 · erbBitSlotOpen（位槽且第二实参坑纯空白）', () => {
  it('位槽 + 空坑 ⇒ true（四种原语；光标可落在坑内任意处，含行尾）', () => {
    expect(erbBitSlotOpen('GETBIT(CFLAG:1, )', 'GETBIT(CFLAG:1, '.length + 1)).toBe(true);
    expect(erbBitSlotOpen('SETBIT CFLAG:1, ', 17)).toBe(true);
    expect(erbBitSlotOpen('CLEARBIT CFLAG:1,\t', 18)).toBe(true);
    expect(erbBitSlotOpen('INVERTBIT TFLAG:192, ', 22)).toBe(true);
  });

  it('非位槽 / 坑内有内容（位号或变量）/ 注释行 ⇒ false', () => {
    expect(erbBitSlotOpen('RAND(1, )', 9)).toBe(false); // 普通函数第二实参不是位
    expect(erbBitSlotOpen('SETBIT CFLAG:1', 15)).toBe(false); // 无逗号
    expect(erbBitSlotOpen('SETBIT CFLAG:1, 0', 17)).toBe(false); // 已有位号
    expect(erbBitSlotOpen('SETBIT CFLAG:1, LOCAL', 17)).toBe(false); // 写成变量
    expect(erbBitSlotOpen('; SETBIT CFLAG:1, ', 17)).toBe(false); // 注释行
  });

  it('与候选门同源（同一条空判据）：有位表时 open ⟺ 必出货；非 open ⇒ 恒空', () => {
    for (const marked of [
      'GETBIT(CFLAG:1, |)',
      'SETBIT CFLAG:1, |',
      'SETBIT CFLAG:1, |0',
      'SETBIT CFLAG:1, |LOCAL',
      '; SETBIT CFLAG:1, |',
      'RAND(1, |)',
    ]) {
      const marker = marked.indexOf('|');
      const line = marked.replace('|', '');
      expect(itemsOf(marked, schemaA()).length > 0, marked).toBe(erbBitSlotOpen(line, marker + 1));
    }
    // 反方向：open 只答「是不是空位槽」，不答「有没有表」——无位表的变量 open=true 但零候选
    expect(erbBitSlotOpen('SETBIT OTHER:9, ', 16)).toBe(true);
    expect(itemsOf('SETBIT OTHER:9, |', schemaA())).toEqual([]);
  });
});

/* ============================== (c) 切表 / 重建 → 刷新，无泄漏 ============================== */

describe('D7 · 位补全 · 切项目 / 表重建（候选刷新）', () => {
  it('同一装配句柄：切 schema → 候选随新表变化（现取、无缓存旧表）', () => {
    let tables: ErbCompletionTables = {};
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => tables, () => undefined);
    const provider = registered[0]!.provider;
    const out = (): string[] => labels(provide(provider, 'SETBIT CFLAG:1, ', 17));

    tables = { variableSchema: schemaA() };
    expect(out()).toContain('0 接吻');
    tables = { variableSchema: schemaB() };
    expect(out()).toContain('0 别的');
    expect(out()).not.toContain('0 接吻');
    tables = { variableSchema: schemaA() };
    expect(out()).toContain('0 接吻');
    expect(out()).not.toContain('0 别的');
  });
});

/* ============================== findBitSlot（解析面钉死） ============================== */

describe('D7 · findBitSlot（只认四原语第二实参坑）', () => {
  it('表达式形：返回变量引用 + 第二实参区间', () => {
    const lineText = 'GETBIT(CFLAG:1, )';
    expect(findBitSlot(lineText, lineText.indexOf(')') + 1)).toEqual({
      variableRef: 'CFLAG:1',
      regionStart: lineText.indexOf(',') + 1,
      regionEnd: lineText.indexOf(')'),
    });
  });

  it('语句形：区间延伸到行尾', () => {
    const lineText = 'INVERTBIT TFLAG:192, ';
    expect(findBitSlot(lineText, lineText.length + 1)).toEqual({
      variableRef: 'TFLAG:192',
      regionStart: lineText.indexOf(',') + 1,
      regionEnd: lineText.length,
    });
  });

  it('嵌套括号里的逗号不算顶层逗号 / 光标在别处 / 无括号 ⇒ null', () => {
    expect(findBitSlot('SETBIT CFLAG:(A + 1), ', 25)?.variableRef).toBe('CFLAG:(A + 1)');
    expect(findBitSlot('SETBIT CFLAG:1', 15)).toBeNull();
    expect(findBitSlot('GETBIT CFLAG:1', 15)).toBeNull(); // GETBIT 缺括号 ⇒ 不认
  });
});

/* ============================== 位名悬停 ============================== */

describe('D7 · 位名悬停（只读、查不到不显示）', () => {
  it('`GETBIT(CFLAG:1, 2)` 位号上 → 中文位名「恋人」', () => {
    const hit = hoverAt('GETBIT(CFLAG:1, |2)', schemaA());
    expect(hit?.name).toBe('恋人');
    expect(hit?.kind).toContain('位号');
    expect(hit?.startColumn).toBe('GETBIT(CFLAG:1, '.length + 1);
  });

  it('`SETBIT TFLAG:192, 1` 位号上 → 「成功」', () => {
    expect(hoverAt('SETBIT TFLAG:192, |1', schemaA())?.name).toBe('成功');
  });

  it('三段式 `TALENT:TARGET:性別` 位号悬停（与补全共用同一 resolveBits，自动受益）', () => {
    const hit = hoverAt('GETBIT(TALENT:TARGET:性別, |1)', schemaA());
    expect(hit?.name).toBe('女性');
    expect(hit?.kind).toContain('位号');
    expect(hit?.startColumn).toBe('GETBIT(TALENT:TARGET:性別, '.length + 1);
    expect(hoverAt('GETBIT(TCVAR:TARGET:随便, |5)', schemaA())?.name).toBe('随意');
  });

  it('负例：非位槽 / 表内无该位号 / 位坑是变量 / 无表 一律不显示', () => {
    expect(hoverAt('RAND(1, |2)', schemaA())).toBeUndefined();
    expect(hoverAt('GETBIT(CFLAG:1, |1)', schemaA())).toBeUndefined(); // CFLAG:1 无位 1
    expect(hoverAt('GETBIT(CFLAG:1, |LOCAL)', schemaA())).toBeUndefined();
    expect(hoverAt('GETBIT(CFLAG:1, |2)')).toBeUndefined(); // schema 缺省
  });

  it('ERB 悬停已进槽：`installHover` 只为 kojo1 注册（旧桥不再挂 ERB）', () => {
    const hoverRegs: Monaco.languages.HoverProvider[] = [];
    const hoverMonaco = {
      languages: {
        registerHoverProvider: (_lang: string, provider: Monaco.languages.HoverProvider): Monaco.IDisposable => {
          hoverRegs.push(provider);
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installHover(hoverMonaco, () => ({ variableSchema: schemaA() }) as HoverTables);
    // ERB-PARITY G1（2026-10-31）：ERB 的悬停判据搬进插件、由槽供方作答，
    // 旧桥这台安装器只剩 kojo1 那门；位名内容的判据由本文件其余用例直接驱动。
    expect(hoverRegs).toHaveLength(1);
  });
});
