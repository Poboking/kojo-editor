/**
 * COMPL-SHARED · 两套补全装配核并一 + 跨语言候选打通 的回归钉。
 *
 * 六条判据各钉一处，全部经**生产装配路径**（`createCompletionProvider` / `installKojoCompletion`），
 * 不测私有实现：
 *
 * ①**对拍**：两门语言喂**同一组候选源**，经各自的装配声明（`KOJO_COMPLETION_ASSEMBLY` /
 *   `ERB_COMPLETION_ASSEMBLY`）出货 ⇒ 结果逐字相同（label 序 + `sortText`），且等于**手算的**
 *   期望序（两侧一起错也算挂 ⇒ 不是恒真）；再反向验"先注册者胜"真的会换胜出者。
 * ②**跨语言候选**：`.kojo` 里写 `调用` / `函数` 补得到项目函数名（真实候选来自注入表，非空跑）。
 * ③**别名判据零回归**：`别名` 名照旧出货、`常量` 名新增出货；注释行 / 字符串内 / 全角形态
 *   三类伪声明一律**以解析器为准**（旧正则会把它们当声明）。
 * ④**缺源 fail-open**：源缺席 / 提供者抛错 / 外来词形未注入 ⇒ 不抛、不猜、候选照常，
 *   并发一次可见降级信号。
 * ⑤**声明判据的副作用**：注释 / 字符串 / 全角伪声明经**装配路径**也不进候选、真声明（`别名` +
 *   `常量`）进候选、注入通道真被消费、按版本记忆化（同版本零扫描）。
 * ⑥**并表后的源册形状**：两册源同用一枚 `CompletionSource` 协议，`requires` 只能指向共享表键，
 *   项目函数名一路两语言同键（断层不可复现）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoLibraryTable } from '@kojo/plugin-api';
import { ERB_COMPLETION_ASSEMBLY, ERB_COMPLETION_SOURCES, installErbCompletion } from '../src/monaco/erb-completion';
import { KOJO_COMPLETION_ASSEMBLY, KOJO_COMPLETION_SOURCES, installKojoCompletion } from '../src/monaco/kojo-completion';
import { kojoDeclarationsOf } from '../src/monaco/kojo-completion-declarations';
import { kojoFunctionNameSlot } from '../src/monaco/kojo-completion-functions';
import {
  createCompletionProvider,
  type CompletionAssembly,
  type CompletionDegrade,
  type CompletionSource,
  type CompletionTables,
} from '../src/monaco/completion-core';

/* ============================== 桩 ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: {
        Variable: 1,
        Keyword: 2,
        Operator: 3,
        Function: 4,
        Field: 5,
        Reference: 6,
        EnumMember: 7,
        Property: 8,
        Snippet: 9,
        Method: 10,
      },
      CompletionItemInsertTextRule: { None: 0, KeepWhitespace: 1, InsertAsSnippet: 4 },
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

function modelOf(text: string, versionId?: number): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  const stub: Record<string, unknown> = {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const m = /[A-Za-z0-9_]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
  };
  if (versionId !== undefined) stub.getVersionId = () => versionId;
  return stub as unknown as Monaco.editor.ITextModel;
}

function labels(items: readonly Monaco.languages.CompletionItem[]): string[] {
  return items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  column: number,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

/* ============================== ① 对拍：同一候选集合，两语言装配结果一致 ============================== */

/**
 * 同一组**语言无关**的候选源（label 故意重叠验"先注册者胜"；词形用 ASCII ⇒
 * 桩 model 的默认词法（`[A-Za-z0-9_]`）在两语言的位置判定下给出**同一个前缀**）。
 */
function paritySources(): CompletionSource[] {
  const first: CompletionSource = {
    id: 'shared-first',
    provide({ monaco, range }): Monaco.languages.CompletionItem[] {
      const K = monaco.languages.CompletionItemKind.Keyword;
      return [
        { label: 'CALL_', kind: K, insertText: 'CALL_', range, sortText: '1_a' },
        { label: 'ZZZ', kind: K, insertText: 'ZZZ', range, sortText: '0_b' },
        { label: 'DUP', kind: K, insertText: 'DUP', detail: '前者', range, sortText: '1_c' },
      ];
    },
  };
  const second: CompletionSource = {
    id: 'shared-second',
    provide({ monaco, range }): Monaco.languages.CompletionItem[] {
      const K = monaco.languages.CompletionItemKind.Keyword;
      return [
        // 与 first 同 label ⇒ 去重必须"先注册者胜"（detail 不同，可判是谁胜出）
        { label: 'DUP', kind: K, insertText: 'DUP', detail: '后者', range, sortText: '9_x' },
        { label: 'CALL_A', kind: K, insertText: 'CALL_A', range, sortText: '0_a' },
        { label: 'AAA', kind: monaco.languages.CompletionItemKind.Variable, insertText: 'AAA', range, sortText: '3_y' },
      ];
    },
  };
  return [first, second];
}

/** 把同一组源分别挂到两门语言的**真实装配声明**上，跑同一处位置取候选 */
function provideBoth(assemblies: readonly CompletionAssembly[], text: string, column: number) {
  const tables: CompletionTables = {};
  return assemblies.map((assembly) => {
    const provider = createCompletionProvider(
      stubMonaco().monaco,
      { ...assembly, sources: paritySources() },
      () => tables,
    );
    return provider.provideCompletionItems(
      modelOf(text),
      { lineNumber: 1, column } as Monaco.Position,
      {} as Monaco.languages.CompletionContext,
      {} as Monaco.CancellationToken,
    ) as unknown as Monaco.languages.CompletionList;
  });
}

describe('COMPL-SHARED ① · 同一候选集合下两语言装配对拍', () => {
  const [kojo, erb] = provideBoth([KOJO_COMPLETION_ASSEMBLY, ERB_COMPLETION_ASSEMBLY], 'CALL_', 6);
  const kojoList = kojo!.suggestions;
  const erbList = erb!.suggestions;

  it('label 序 + sortText 逐字相同（合并 / 去重 / 排序只剩一份实现）', () => {
    expect(labels(kojoList)).toEqual(labels(erbList));
    expect(kojoList.map((i) => i.sortText)).toEqual(erbList.map((i) => i.sortText));
  });

  it('等于手算的期望序：前缀精确 > 前缀命中 > 其它，同档沿用 source 自带 sortText', () => {
    // 已输入 `CALL_` ⇒ 精确档(0) `CALL_`；命中档(1) `CALL_A`；其余进"其它"档(2) 并按 sortText 排
    expect(labels(kojoList)).toEqual(['CALL_', 'CALL_A', 'ZZZ', 'DUP', 'AAA']);
    expect(kojoList[0]!.sortText).toMatch(/^0\|/);
    expect(kojoList[1]!.sortText).toMatch(/^1\|/);
    expect(kojoList[2]!.sortText).toMatch(/^2\|/);
  });

  it('去重按 label、先注册者胜（胜出者的 detail 来自第一个源 ⇒ 不是恒真对拍）', () => {
    const hit = kojoList.find((i) => labels([i])[0] === 'DUP');
    expect(hit?.detail).toBe('前者');
  });

  it('反序注册 ⇒ 胜出者换人（证明胜出判据来自注册序，而不是两侧都写死）', () => {
    const tables: CompletionTables = {};
    const reversed = [...paritySources()].reverse();
    const assembly: CompletionAssembly = { ...KOJO_COMPLETION_ASSEMBLY, sources: reversed };
    const provider = createCompletionProvider(stubMonaco().monaco, assembly, () => tables);
    const out = provider.provideCompletionItems(
      modelOf('CALL_'),
      { lineNumber: 1, column: 6 } as Monaco.Position,
      {} as Monaco.languages.CompletionContext,
      {} as Monaco.CancellationToken,
    ) as unknown as Monaco.languages.CompletionList;
    expect(out.suggestions.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'DUP')?.detail).toBe('后者');
  });

  it('装配级上限两语言同一条（截断可见：候选数 = limit，不各自一套）', () => {
    const many: CompletionSource = {
      id: 'many',
      provide({ monaco, range }): Monaco.languages.CompletionItem[] {
        return Array.from({ length: 50 }, (_, i) => ({
          label: `名${String(i).padStart(3, '0')}`,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: `名${String(i).padStart(3, '0')}`,
          range,
        }));
      },
    };
    const run = (assembly: CompletionAssembly): number => {
      const provider = createCompletionProvider(stubMonaco().monaco, { ...assembly, sources: [many] }, () => ({}));
      const out = provider.provideCompletionItems(
        modelOf(''),
        { lineNumber: 1, column: 1 } as Monaco.Position,
        {} as Monaco.languages.CompletionContext,
        {} as Monaco.CancellationToken,
      ) as unknown as Monaco.languages.CompletionList;
      return out.suggestions.length;
    };
    expect(run(KOJO_COMPLETION_ASSEMBLY)).toBe(50);
    expect(run(ERB_COMPLETION_ASSEMBLY)).toBe(50);
  });
});

/* ============================== ② 跨语言候选：`.kojo` 补到项目函数名 ============================== */

const PROJECT_FNS: readonly string[] = ['M_KOJO_NOTICE_甲', 'M_KOJO_NOTICE_乙', 'OTHER_FN'];

describe('COMPL-SHARED ② · `.kojo` 的项目函数名候选（真实候选，非空跑）', () => {
  const tables: CompletionTables = { erbFunctionNames: () => PROJECT_FNS };

  it('`调用 <前缀>` 位出货项目函数名（与 `.erb` 同一份表、同一个引擎）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => tables);
    const text = '调用 M_KOJO_NOTICE_';
    const items = provide(registered[0]!.provider, text, text.length + 1);
    expect(labels(items)).toContain('M_KOJO_NOTICE_甲');
    expect(labels(items)).toContain('M_KOJO_NOTICE_乙');
    expect(items.some((i) => i.insertText === 'OTHER_FN')).toBe(false); // 前缀不符 ⇒ 不进面
    const hit = items.find((i) => i.label === 'M_KOJO_NOTICE_甲');
    expect(hit!.kind).toBe(monaco.languages.CompletionItemKind.Function);
    expect(hit!.insertText).toBe('M_KOJO_NOTICE_甲'); // 只插名字：糖的调用形括号由作者决定
  });

  it('`函数 <前缀>` 定义位同样出货（自定义函数名也是项目函数名）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => tables);
    const text = '函数 M_KOJO_NOTICE_甲';
    expect(labels(provide(registered[0]!.provider, text, text.length + 1))).toContain('M_KOJO_NOTICE_甲');
  });

  it('英文隐藏别名参与位置判定（`call X` 一样出货）', () => {
    const text = '\tcall M_KOJO_';
    const slot = kojoFunctionNameSlot(text, text.length + 1);
    expect(slot).not.toBeNull();
    expect(slot!.prefix).toBe('M_KOJO_');
  });

  it('位置不符不给：正文行 / 字符串内 / 注释内 / 光标越过槽右界（四例各钉，一律 null）', () => {
    expect(kojoFunctionNameSlot('她：<调用 一个词>', 12)).toBeNull();
    expect(kojoFunctionNameSlot('调用 "M_KOJO_', 12)).toBeNull();
    expect(kojoFunctionNameSlot('; 调用 M_KOJO_', 12)).toBeNull();
    expect(kojoFunctionNameSlot('调用 甲(1, 2)', 12)).toBeNull();
  });

  it('项目函数名候选可二次回表（中文名 + 调用签名走与 `.erb` 同一份详情构造）', () => {
    const protocol = { slotsFor: (name: string) => (name === 'M_KOJO_NOTICE_甲' ? [{ index: 0, kind: 'int' as const, label: '编号' }] : null) };
    const libraryTable: KojoLibraryTable = {
      hasTable: true,
      lookupByName: () => undefined,
      lookupByFunction: (fn) => (fn === 'M_KOJO_NOTICE_甲' ? '公告甲' : undefined),
    };
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({ ...tables, callProtocol: protocol, libraryTable }));
    const provider = registered[0]!.provider;
    const text = '调用 M_KOJO_NOTICE_甲';
    const item = provide(provider, text, text.length + 1).find((i) => i.label === 'M_KOJO_NOTICE_甲')!;
    const resolved = provider.resolveCompletionItem!(item, {} as Monaco.CancellationToken) as Monaco.languages.CompletionItem;
    const doc = (resolved.documentation as { value: string } | undefined)?.value ?? '';
    expect(doc).toContain('项目函数');
    expect(doc).toContain('中文名 公告甲');
    expect(doc).toContain('调用签名 `M_KOJO_NOTICE_甲(ARG:0 编号)`');
    // 非括号调用形态 ⇒ 绝不被 snippet 化
    expect(resolved.insertText).toBe('M_KOJO_NOTICE_甲');
    expect(resolved.insertTextRules).toBeUndefined();
  });
});

/* ============================== ③ 别名判据并回解析器：零回归 ============================== */

describe('COMPL-SHARED ③ · 声明名判据 = 解析器（注释 / 字符串 / 全角各钉）', () => {
  const namesOf = (text: string): string[] =>
    kojoDeclarationsOf(modelOf(text, 1), undefined).map((d) => d.name);

  it('普通 `别名` 声明照旧出货（旧正则可见集零回归）', () => {
    expect(namesOf('别名 心 = 角色 3\n如果\n')).toContain('心');
  });

  it('`常量` 声明新增出货（旧正则不认 `常量`，判据分叉就此消失）', () => {
    expect(namesOf('常量 上限值 = 5\n')).toContain('上限值');
  });

  it('注释行里的 `别名` 不算声明（旧正则 `^\\s*` 会把它当声明 ⇒ 以解析器为准）', () => {
    expect(namesOf('; 别名 假声明 = 角色 1\n')).toEqual([]);
  });

  it('字符串内的 `别名` 文本不算声明', () => {
    expect(namesOf('她：「别名 假声明 = 角色 1」\n')).toEqual([]);
  });

  it('全角空格分隔的声明照样认（旧正则 `\s` 也认 ⇒ 零回归）', () => {
    expect(namesOf('别名　全角隔 = 角色 3\n')).toContain('全角隔');
  });

  it('全角等号形态**以解析器为准**：补出来的名字必须就是转译器认的那个名字', () => {
    // `别名 Y ＝ 角色 3` 里 `＝` 不是糖的赋值记号 ⇒ 解析器把整段当名字（并因此不会把 `Y` 认成别名）。
    // 旧正则给 `Y` ⇒ 补全产出一个转译器根本不认的假候选（"补得上、编译炸"）。判据并回 parser 后
    // 这类形态不再伪出货：名字与转译器同一口径。
    const names = namesOf('别名 Y ＝ 角色 3\n');
    expect(names).not.toContain('Y');
    expect(names).toEqual(['Y ＝ 角色 3']);
  });

  it('时机块体内的 `别名` 行不算声明（旧正则全文扫会误收）', () => {
    expect(namesOf('时机 事件 摸：\n  别名 块内名 = 角色 3\n')).toEqual([]);
  });

  it('表上给了注入扫描器 ⇒ 用它（宿主可把内核那一枚服务实例递进来，本层不再自取）', () => {
    const out = kojoDeclarationsOf(modelOf('别名 心 = 角色 3\n', 7), () => [{ name: '注入名', kind: 'alias' }]);
    expect(out.map((d) => d.name)).toEqual(['注入名']);
  });

  it('注入的扫描器抛错 ⇒ 该路零候选 + 不抛（fail-open，不猜）', () => {
    const out = kojoDeclarationsOf(modelOf('别名 心 = 角色 3\n', 8), () => {
      throw new Error('解析器缺席');
    });
    expect(out).toEqual([]);
  });
});

/* ============================== ⑤ 声明判据的**副作用**（走真实装配路径，不是只测扫描器） ============================== */

describe('COMPL-SHARED ⑤ · 声明候选经装配路径的副作用（注释 / 字符串 / 全角 / `常量`）', () => {
  /** 在 `tables` 上装一轮 provider，取行 1 第 `column` 列的候选 label 集 */
  function labelsAt(text: string, column: number, tables: CompletionTables = {}): string[] {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => tables);
    return labels(provide(registered[0]!.provider, text, column));
  }

  it('注释行里的 `别名` 声明**不进候选**（旧正则在这里会伪出货 ⇒ 现以解析器为准）', () => {
    const at = labelsAt('; 别名 假声明 = 角色 1\n;', 14);
    expect(at).not.toContain('假声明');
    expect(at.length).toBeGreaterThan(0); // 词表路照旧（不是空跑换来的"干净"）
  });

  it('字符串内的 `别名` 文本不进候选', () => {
    expect(labelsAt('她："别名 假声明串 = 角色 1"', 20)).not.toContain('假声明串');
  });

  it('全角等号形态不进候选（转译器不认这个名字 ⇒ 补得上也必须编译得过）', () => {
    const at = labelsAt('别名 Y ＝ 角色 3\n', 1);
    expect(at).not.toContain('Y');
  });

  it('真声明进候选：`别名` 与新增的 `常量` 两路（detail 区分类别）', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({}));
    const items = provide(registered[0]!.provider, '别名 心 = 角色 3\n常量 上限值 = 5\n', 1);
    expect(items.find((i) => i.label === '心')?.detail).toBe('别名（本文件）');
    expect(items.find((i) => i.label === '上限值')?.detail).toBe('常量（本文件）');
  });

  it('宿主注入的扫描器**真的被消费**（表上给了就不走缺省实例 ⇒ W6 语言服务槽那条通道有效）', () => {
    const at = labelsAt('别名 心 = 角色 3\n', 1, { kojoDeclarations: () => [{ name: '注入名', kind: 'alias' }] });
    expect(at).toContain('注入名');
    expect(at).not.toContain('心');
  });

  it('按 model 版本记忆化：同版本重扫零成本，版本一变即复扫（防"每击键全篇解析"回潮）', () => {
    let version = 1;
    let scans = 0;
    const model = {
      getValue: () => '别名 心 = 角色 3\n',
      getLineContent: () => '别名 心 = 角色 3',
      getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
      getVersionId: () => version,
    } as unknown as Monaco.editor.ITextModel;
    const names = () => {
      scans++;
      return [{ name: '心', kind: 'alias' as const }];
    };
    expect(kojoDeclarationsOf(model, names)).toEqual([{ name: '心', kind: 'alias' }]);
    kojoDeclarationsOf(model, names);
    expect(scans).toBe(1); // 同版本：复用缓存，扫描器一次都不进
    version = 2;
    kojoDeclarationsOf(model, names);
    expect(scans).toBe(2); // 版本一变：复扫（否则新写的别名补不出来）
  });

  it('扫描失败的版本不进缓存（解析器随后就位 ⇒ 下一击键自然恢复，不静默留空）', () => {
    let version = 1;
    const model = {
      getValue: () => '别名 心 = 角色 3\n',
      getVersionId: () => version,
    } as unknown as Monaco.editor.ITextModel;
    expect(kojoDeclarationsOf(model, () => {
      throw new Error('解析器缺席');
    })).toEqual([]);
    version = 2;
    expect(kojoDeclarationsOf(model, () => [{ name: '心', kind: 'alias' }])).toEqual([{ name: '心', kind: 'alias' }]);
    version = 3;
    expect(kojoDeclarationsOf(model, () => [{ name: '心', kind: 'alias' }])).toEqual([{ name: '心', kind: 'alias' }]);
  });
});

/* ============================== ⑥ 并表后的源册形状（同一 `CompletionSource` 协议，无语言分支） ============================== */

describe('COMPL-SHARED ⑥ · 两册候选源形状一致（并表的可断言面）', () => {
  it('每个源都有 id + provide；`requires` 只许指向共享表的键', () => {
    const keys = new Set<string>([
      'dictionary',
      'variableSchema',
      'faceTable',
      'instructionTable',
      'counterTable',
      'libraryTable',
      'callProtocol',
      'erbFunctionNames',
      'kojoForms',
      'kojoDeclarations',
    ]);
    for (const source of [...ERB_COMPLETION_SOURCES, ...KOJO_COMPLETION_SOURCES]) {
      expect(source.id.length).toBeGreaterThan(0);
      expect(typeof source.provide).toBe('function');
      if (source.requires !== undefined) expect(keys.has(source.requires)).toBe(true);
    }
  });

  it('项目函数名一路两语言同键（`.kojo` 不存在"有表无源"的断层）', () => {
    const kojo = KOJO_COMPLETION_SOURCES.find((s) => s.id === 'kojo-functions');
    const erb = ERB_COMPLETION_SOURCES.find((s) => s.id === 'erb-functions');
    expect(kojo!.requires).toBe(erb!.requires);
    expect(kojo!.requires).toBe('erbFunctionNames');
  });
});

/* ============================== ④ 缺源 fail-open ============================== */

describe('COMPL-SHARED ④ · 缺源不抛不猜（降级可见一次）', () => {
  it('外来词形未注入：`.erb` 该行零候选 + 恰一次降级信号；注入即出货', () => {
    const degrades: CompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ kojoForms: undefined }), (d) => degrades.push(d));
    const provider = registered[0]!.provider;
    expect(() => provide(provider, 'IF A', 5)).not.toThrow();
    expect(labels(provide(provider, 'IF A', 5))).not.toContain('如果');
    expect(degrades.filter((d) => d.sourceId === 'erb-kojo-forms')).toHaveLength(1);

    const injected = stubMonaco();
    installErbCompletion(injected.monaco, () => ({
      kojoForms: () => [{ label: '如果', detail: '.kojo 词形' }],
    }));
    const hit = provide(injected.registered[0]!.provider, 'IF A', 5).find((i) => i.label === '如果');
    expect(hit?.detail).toBe('.kojo 词形');
    // 外来词形排在本语言候选之后（`9_` 组），不与本方言争位
    const all = labels(provide(injected.registered[0]!.provider, 'IF A', 5));
    expect(all.indexOf('IF')).toBeLessThan(all.indexOf('如果'));
  });

  it('项目函数名提供者缺席：`.kojo` 该行零候选 + 恰一次降级；其余源照常出货', () => {
    const degrades: CompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({}), (d) => degrades.push(d));
    const items = provide(registered[0]!.provider, '调用 M_KOJO', 11);
    expect(items.some((i) => i.label === 'M_KOJO_NOTICE_甲')).toBe(false);
    expect(degrades.filter((d) => d.sourceId === 'kojo-functions')).toHaveLength(1);
    expect(degrades.find((d) => d.sourceId === 'kojo-functions')!.missing).toBe('erbFunctionNames');
    // 同一次装配内重复请求不再刷屏（去重表随句柄创建）
    provide(registered[0]!.provider, '调用 M_KOJO', 11);
    expect(degrades.filter((d) => d.sourceId === 'kojo-functions')).toHaveLength(1);
  });

  it('提供者求值抛错 ⇒ 该路零候选 + 降级可见，整轮不崩', () => {
    const degrades: CompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(
      monaco,
      () => ({
        erbFunctionNames: () => {
          throw new Error('索引在途');
        },
      }),
      (d) => degrades.push(d),
    );
    expect(() => provide(registered[0]!.provider, '调用 M_KOJO', 11)).not.toThrow();
    expect(provide(registered[0]!.provider, '调用 M_KOJO', 11).length).toBeGreaterThan(0); // 词表源照旧
    expect(degrades.filter((d) => d.sourceId === 'kojo-functions')).toHaveLength(1);
  });

  it('声明扫描缺席（桩 model 无 `getValue` 之外的字段）⇒ 不抛，别名路自然落空', () => {
    const bare = { getLineContent: () => '', getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }) };
    expect(() => kojoDeclarationsOf(bare as unknown as Monaco.editor.ITextModel, undefined)).not.toThrow();
  });
});

/* ============================== 并表证明（编译期：两侧表名即同一类型） ============================== */

describe('COMPL-SHARED · 两套 Tables 并一（类型层证明）', () => {
  it('`ErbCompletionTables` 与共享 `CompletionTables` 互换无需断言（同一张表）', () => {
    const shared: CompletionTables = { erbFunctionNames: () => PROJECT_FNS };
    const erbTables: CompletionTables = shared;
    expect(erbTables.erbFunctionNames?.()).toEqual(PROJECT_FNS);
    // 源册并一后仍各自存在，但源类型同源（同一 `CompletionSource` 形状）
    expect(ERB_COMPLETION_SOURCES.every((s) => typeof s.provide === 'function')).toBe(true);
  });
});
