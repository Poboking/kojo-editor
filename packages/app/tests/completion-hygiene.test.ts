/**
 * SH-6 · 补全候选「kind 闭集 + 零 emoji」跨 seam（`.kojo` / `.erb`）卫生守卫。
 *
 * ## 为什么本批不是「新造图标桥」
 *
 * 候选的图标由 Monaco 按 `CompletionItem.kind`（`monaco.languages.CompletionItemKind`）
 * 用内置**单色 codicon**自绘——宿主与插件都不自绘补全图标。宿主那枚「图标桥」
 * `UIPanelProps.renderIcon?: (name, size) => unknown`（`packages/plugin-api/src/slots.ts:36`）
 * **只作用于 `ui.panel` 面板贡献**，由 `packages/app/src/ui/PanelHost.tsx:24`
 * 实现为 `<Icon name={…} size={…} />`，在 :45 / :59 只转发给面板组件；两个补全 seam
 * （`kojo-completion.ts` / `erb-completion.ts`）**完全不碰 `renderIcon`**。
 * 故本批真形态 = 把「kind 正确 ⇒ Monaco 自动画单色图标」「候选文本零 emoji」
 * 钉成可回归守卫，**零生产代码改动**。
 *
 * Monaco 绑定刻意薄：桩 monaco（只给 `CompletionItemKind`）+ 桩 model + 桩 adapter 表，
 * 不引真实 monaco-editor 运行时；候选来自静态词表 / 桩表（纯数据）。
 * 桩 model 额外给 `getVersionId`（递增整数）——SH-3 记忆化会读 `model.getVersionId?.()`，
 * 缺字段会让标签路线静默返回 `[]` 造成假绿。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoFaceTable, VariableInfo, VariableSchema } from '@kojo/plugin-api';
import {
  KOJO_COMPLETION_SOURCES,
  type CompletionSourceContext,
  type CompletionTables,
} from '../src/monaco/kojo-completion';
import {
  ERB_COMPLETION_SOURCES,
  type ErbCompletionSourceContext,
  type ErbCompletionTables,
} from '../src/monaco/erb-completion';

/* ============================== 桩 monaco / model / adapter 表 ============================== */

/**
 * 桩 `CompletionItemKind` —— **恰为两 seam 实际用到的枚举闭集**：
 * kojo-lexicon 用 Variable / Keyword / Operator / Function；kojo-variable 用 Variable；
 * kojo-face 分野名 / 命名参数取值用 EnumMember、命名参数**键**用 Property；
 * erb-directives 用 Keyword；erb-variables 用 Variable / Field；
 * erb-functions / erb-system-functions 用 Function；erb-labels 用 Reference。
 */
const KIND = {
  Variable: 1,
  Keyword: 2,
  Operator: 3,
  Function: 4,
  Field: 5,
  Reference: 6,
  EnumMember: 7,
  Property: 8,
  Snippet: 9, // R4：kojo/erb 两 seam 的块头模板 / 控制流骨架
} as const;

const LEGAL_KINDS: ReadonlySet<number> = new Set<number>(Object.values(KIND));

function stubMonaco(): typeof Monaco {
  return { languages: { CompletionItemKind: KIND } } as unknown as typeof Monaco;
}

/** 桩 model：`getValue` / `getLineContent` / `getWordUntilPosition`（默认词法）+ `getVersionId` */
function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  let version = 0;
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const m = /[A-Za-z0-9_]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
    getVersionId: () => version++,
  } as unknown as Monaco.editor.ITextModel;
}

/** 最小 `VariableSchema` 桩：几个族各给若干索引名（枚举能力），其余族空（不猜）；
 *  `lookup('CFLAG', 1)` 额外给位表（D7 `erb-bits` source 的出货面）。 */
function fakeSchema(): VariableSchema {
  const table: Record<string, VariableInfo[]> = {
    CFLAG: [
      { name: '好感度', index: 1088, description: '角色好感度', source: 'primary' },
      { name: '恋慕度', index: 1089, description: '角色恋慕值', source: 'primary' },
    ],
    TALENT: [{ name: '恋慕', index: 3, description: '恋慕天赋', source: 'primary' }],
    MARK: [{ name: '恋人', index: 5, source: 'primary' }],
  };
  return {
    version: 'test',
    lookup: (name: string, index?: number | string) =>
      name === 'CFLAG' && String(index) === '1'
        ? {
            name: 'CFLAG',
            index: 1,
            description: '既成事实',
            bits: [
              { bit: 0, label: '接吻' },
              { bit: 2, label: '恋人' },
            ],
          }
        : undefined,
    names: (family: string) => table[family] ?? [],
  } as unknown as VariableSchema;
}

/** 项目内函数名（同一数组引用：前缀索引按数组身份记忆化；COMPL-SHARED 起两语言共用这一份注入表） */
const PROJECT_FNS: readonly string[] = ['M_KOJO_A', 'M_KOJO_B'];

const KOJO_TABLES: CompletionTables = {
  variableSchema: fakeSchema(),
  // COMPL-SHARED：项目函数名（与 `.erb` 同一份注入表）
  erbFunctionNames: () => PROJECT_FNS,
  faceTable: {
    faces: {
      初见: { template: 'M_KOJO_K{n}_HATSUMI' },
      指令: {
        template: 'M_KOJO{t}_MESSAGE_${com}_K{n}_{i}',
        segments: { com: { COM: 'COM', SCOM: 'SCOM' } },
      },
      // IX-1：计数器面（`indexKind: 'counter'` ⇒ 编号槽由 `kojo-counter` 源按计数器表出货）
      计数器: { template: 'M_KOJO{t}_MESSAGE_COUNTER_K{n}_{i}', indexKind: 'counter' },
    },
    // 成否位协议（键/取值联动的公开面；宿主据 `values` 给 `成否:` 取值候选）
    successFlag: { target: 'TFLAG:192', values: { 游戏判定: 0, 一定成功: 1 } },
  } as unknown as KojoFaceTable,
  // KC-3 指令名表（正向枚举 `names()` + 反查编号）；KC-4 库函数名表（正向枚举 + 反查原生名）
  instructionTable: {
    hasTable: true,
    lookupByName: (name: string) => ({ 摸屁股: 310, 告白: 705 } as Record<string, number>)[name],
    lookupByNo: () => undefined,
    names: () => ['摸屁股', '告白'],
  },
  // IX-1 计数器值域表（正向枚举 + 反查编号；编号槽补全的候选源）
  counterTable: {
    hasTable: true,
    lookupByName: (name: string) => ({ 偷看: 2, 色っぽい仕草: 20 } as Record<string, number>)[name],
    lookupByNumber: (no: number) => ({ 2: '偷看', 20: '色っぽい仕草' } as Record<number, string>)[no],
    names: () => ['偷看', '色っぽい仕草'],
  },
  libraryTable: {
    hasTable: true,
    lookupByName: (name: string) => ({ 心形: 'HPH_PRINT', 角色文本: 'CHARA_TEXT' } as Record<string, string>)[name],
    lookupByFunction: () => undefined,
    names: () => ['心形', '角色文本'],
  },
};

const ERB_TABLES: ErbCompletionTables = {
  variableSchema: fakeSchema(),
  erbFunctionNames: () => PROJECT_FNS,
  // 批⑮：本文件解析事实通道（erb-declared 出货用；labelsAt 缺省 undefined ⇒ erb-labels 走全文回退）
  erbFileFacts: { dimsOf: () => ['心情'], labelsAt: () => undefined },
};

/* ============================== 上下文构造（把桩喂给 seam 的 provide） ============================== */

const MONACO = stubMonaco();

function kojoCtx(text: string, column: number, lineNumber = 1): CompletionSourceContext {
  const model = modelOf(text);
  const position = { lineNumber, column } as Monaco.Position;
  const word = model.getWordUntilPosition(position);
  return {
    monaco: MONACO,
    model,
    position,
    range: {
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    } as Monaco.IRange,
    tables: KOJO_TABLES,
  };
}

function erbCtx(text: string, column: number, lineNumber = 1): ErbCompletionSourceContext {
  const model = modelOf(text);
  const position = { lineNumber, column } as Monaco.Position;
  const word = model.getWordUntilPosition(position);
  // 桩 range 对齐真 seam 的口径：生产侧 `ERB_COMPLETION_ASSEMBLY.locate` 传的是
  // `erbTokenRange`（token 起始列向前吞并 `#` / `[`）。少了这一步，`#D` 位的前缀会被切
  // 成 `D`，行首源按全记号前缀收窄时 `#DIM*` 被误滤 ⇒ 假红（不是被测代码的问题）。
  const line = text.split('\n')[lineNumber - 1] ?? '';
  let startColumn = word.startColumn;
  while (startColumn > 1 && (line[startColumn - 2] === '#' || line[startColumn - 2] === '[')) startColumn--;
  return {
    monaco: MONACO,
    model,
    position,
    range: {
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn,
      endColumn: word.endColumn,
    } as Monaco.IRange,
    tables: ERB_TABLES,
  };
}

/** 每 seam 的遍历场景（每 source 给一个「能出货」的位置） */
const KOJO_SCENARIOS: ReadonlyArray<readonly [string, CompletionSourceContext]> = [
  ['kojo-lexicon', kojoCtx('别名 心 = 角色 3\n', 2)],
  // R4 块头模板：行首（token 之前只有空白）才有候选
  ['kojo-snippet', kojoCtx('如果', 1)],
  ['kojo-variable', kojoCtx('{她的好感', 5)],
  ['kojo-face', kojoCtx('时机 初', 5)],
  // KC-2b：分野令牌之后给命名参数键（Property）；键之后给取值（EnumMember）
  ['kojo-face', kojoCtx('时机 初见 ', 7)],
  ['kojo-face', kojoCtx('时机 指令 310 类型: ', 15)],
  ['kojo-face', kojoCtx('时机 指令 310 成否: ', 15)],
  ['kojo-face', kojoCtx('时机 指令 310 参数: ', 15)],
  // KC-3 指令名：`时机 <分野> <编号令牌位>` 的编号槽
  ['kojo-instruction', kojoCtx('时机 指令 摸屁股', 8)],
  // IX-1 计数器名：`时机 <计数器分野> <编号令牌位>` 的编号槽（按面分流到计数器表）
  ['kojo-counter', kojoCtx('时机 计数器 偷看', 8)],
  // KC-4 库函数名：表达式标识符位（调用形）
  ['kojo-library', kojoCtx('心形(', 3)],
  // COMPL-SHARED：项目函数名（`调用` / `函数` 的名字槽，与 `.erb` 同一份注入表）
  ['kojo-functions', kojoCtx('调用 M_KOJO', 10)],
];

const ERB_SCENARIOS: ReadonlyArray<readonly [string, ErbCompletionSourceContext]> = [
  ['erb-directives', erbCtx('#D', 3)], // 行首全表
  ['erb-directives', erbCtx('IF A', 5)], // 行中关键字子集
  // R4 控制流骨架：行首才有候选
  ['erb-snippet', erbCtx('IF', 3)],
  ['erb-variables', erbCtx('CFLAG:', 7)], // 二段式
  ['erb-variables', erbCtx('CFLAG:TARGET:', 14)], // 三段式
  ['erb-functions', erbCtx('CALL M_KOJO', 11)], // 调用位
  ['erb-labels', erbCtx('@F\n$TARGET_ONE\n\tGOTO $TA', 10, 3)], // 跳转位
  ['erb-system-functions', erbCtx('IF A', 5)], // 表达式位
  ['erb-bits', erbCtx('SETBIT CFLAG:1, ', 17)], // 位槽（位号 + 中文位名）
  ['erb-families', erbCtx('PRINTFORML CF', 14)], // 行中族头位（CF → CFLAG）
  ['erb-declared', erbCtx('PRINTFORML 心', 13)], // 行中裸名位（#DIM 声明名，桩 facts 给 心情）
  // ERB-COMPLETE-MEMBER：点号成员位（`M_KOJO.` ⇒ 名录同族成员 `M_KOJO_A` / `M_KOJO_B`）
  ['erb-members', erbCtx('M_KOJO.', 8)],
];

interface Collected {
  readonly sourceId: string;
  readonly item: Monaco.languages.CompletionItem;
}

function collectKojo(): Collected[] {
  const out: Collected[] = [];
  for (const [id, ctx] of KOJO_SCENARIOS) {
    const source = KOJO_COMPLETION_SOURCES.find((s) => s.id === id)!;
    for (const item of source.provide(ctx)) out.push({ sourceId: id, item });
  }
  return out;
}

function collectErb(): Collected[] {
  const out: Collected[] = [];
  for (const [id, ctx] of ERB_SCENARIOS) {
    const source = ERB_COMPLETION_SOURCES.find((s) => s.id === id)!;
    for (const item of source.provide(ctx)) out.push({ sourceId: id, item });
  }
  return out;
}

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

function kojoSrc(id: string): (typeof KOJO_COMPLETION_SOURCES)[number] {
  return KOJO_COMPLETION_SOURCES.find((s) => s.id === id)!;
}
function erbSrc(id: string): (typeof ERB_COMPLETION_SOURCES)[number] {
  return ERB_COMPLETION_SOURCES.find((s) => s.id === id)!;
}
function find(items: readonly Monaco.languages.CompletionItem[], label: string) {
  return items.find((i) => labelText(i.label) === label);
}

/* ============================== emoji 检测（纯函数） ============================== */

/**
 * 常见 emoji 区段：`\u{1F000}-\u{1FAFF}`（Emoji / 补充符号）、`\u{2600}-\u{27BF}`
 * （杂项符号 + Dingbats）、`\u{2B00}-\u{2BFF}`、变体选择符 `\u{FE0F}`。
 *
 * `\u{2190}-\u{21FF}`（箭头块）**只在后随 `\u{FE0F}`（emoji 呈现）时才算**——
 * 裸箭头是排版字符：`erb-system-functions` 的文档用 `↔`（U+2194）做「英 ↔ 中」对照，
 * 那是纯文本，不该被误判为 emoji。中文全角标点（`：`/`（）`/`「」`/`。`/`、`）
 * 均不在上述区段内。
 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]|[\u{2190}-\u{21FF}]\u{FE0F}/u;

function hasEmoji(text: string): boolean {
  return typeof text === 'string' && EMOJI_RE.test(text);
}

/** 把候选的一个文本字段（可能是 string / `{label}` / `{value}`）拆成可检字符串 */
function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') {
    const out: string[] = [];
    const obj = value as Record<string, unknown>;
    if (typeof obj.label === 'string') out.push(obj.label);
    if (typeof obj.value === 'string') out.push(obj.value);
    return out;
  }
  return [];
}

/* ============================== 1. kind 闭集守卫 ============================== */

describe('SH-6 · kind 闭集守卫（漏设 kind ⇒ Monaco 画不出图标）', () => {
  it('桩 CompletionItemKind 覆盖两 seam 实际用到的全部枚举（≥ 六个必需 + EnumMember + Property）', () => {
    for (const req of ['Variable', 'Keyword', 'Operator', 'Function', 'Field', 'Reference'] as const) {
      expect(KIND).toHaveProperty(req);
    }
    expect(KIND).toHaveProperty('EnumMember'); // kojo-face 分野名 / 命名参数取值
    expect(KIND).toHaveProperty('Property'); // KC-2b kojo-face 命名参数键
  });

  it('每个候选都有 kind（≠ undefined）且落在合法闭集内', () => {
    const all = [...collectKojo(), ...collectErb()];
    expect(all.length).toBeGreaterThan(0);
    for (const { sourceId, item } of all) {
      expect(item.kind, `${sourceId} 的候选「${labelText(item.label)}」缺 kind`).toBeDefined();
      expect(
        LEGAL_KINDS.has(item.kind as number),
        `${sourceId} 的候选「${labelText(item.label)}」kind=${String(item.kind)} 越出闭集`,
      ).toBe(true);
    }
  });

  it('两 seam 实际用到的 kind 并集非空且落在闭集内', () => {
    const used = new Set<number>([...collectKojo(), ...collectErb()].map((c) => c.item.kind as number));
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(LEGAL_KINDS.has(k)).toBe(true);
  });
});

/* ============================== 2. 零 emoji 守卫 ============================== */

describe('SH-6 · 零 emoji 守卫（宿主层候选文本）', () => {
  it('hasEmoji 正反例自测（真候选集口径：全角标点 / 文本箭头不得误伤）', () => {
    expect(hasEmoji('😀')).toBe(true); // 1F600
    expect(hasEmoji('✨')).toBe(true); // 2728
    expect(hasEmoji('☑')).toBe(true); // 2611
    expect(hasEmoji('↩️')).toBe(true); // 箭头 + 变体选择符 = emoji 呈现
    expect(hasEmoji('：（）「」。、！？')).toBe(false); // 中文全角标点
    expect(hasEmoji('CFLAG:1088')).toBe(false);
    expect(hasEmoji('**GETBIT** ↔ 系统函数')).toBe(false); // 裸箭头 = 排版字符，非 emoji
    expect(hasEmoji('好感度')).toBe(false);
    expect(hasEmoji('M_KOJO_K{n}_HATSUMI')).toBe(false);
  });

  it('全部候选的 label / insertText / detail / documentation 无 emoji 码点', () => {
    const all = [...collectKojo(), ...collectErb()];
    expect(all.length).toBeGreaterThan(0);
    let hits = 0;
    for (const { sourceId, item } of all) {
      const fields: Array<[string, unknown]> = [
        ['label', item.label],
        ['insertText', item.insertText],
        ['detail', item.detail],
        ['documentation', item.documentation],
      ];
      for (const [name, raw] of fields) {
        for (const text of textsOf(raw)) {
          if (hasEmoji(text)) {
            hits++;
            throw new Error(`${sourceId} 候选「${labelText(item.label)}」.${name} 含 emoji：${text}`);
          }
        }
      }
    }
    expect(hits).toBe(0);
  });
});

/* ============================== 3. kind 语义映射（设计意图钉死） ============================== */

describe('SH-6 · kind 语义映射（当前设计意图）', () => {
  it('kojo-lexicon：别名 → Variable；保留代词 / 关键字 → Keyword', () => {
    const items = kojoSrc('kojo-lexicon').provide(kojoCtx('别名 心 = 角色 3\n', 2));
    expect(find(items, '心')!.kind).toBe(KIND.Variable); // 本文件别名
    expect(find(items, '她')!.kind).toBe(KIND.Keyword); // 保留代词
    expect(find(items, '如果')!.kind).toBe(KIND.Keyword); // 中文主形关键字
  });

  it('kojo-lexicon：运算符 → Operator；系统函数 → Function', () => {
    const items = kojoSrc('kojo-lexicon').provide(kojoCtx('别名 心 = 角色 3\n', 2));
    expect(find(items, '等于')!.kind).toBe(KIND.Operator);
    expect(find(items, '不在')!.kind).toBe(KIND.Operator); // NOTIN 归运算符组
    expect(find(items, '获取标记')!.kind).toBe(KIND.Function);
  });

  it('kojo-variable：插值内变量名 → Variable', () => {
    const items = kojoSrc('kojo-variable').provide(kojoCtx('{她的好感', 5));
    expect(find(items, '好感度')!.kind).toBe(KIND.Variable);
  });

  it('kojo-face：时机分野名 → EnumMember', () => {
    const items = kojoSrc('kojo-face').provide(kojoCtx('时机 初', 5));
    expect(find(items, '初见')!.kind).toBe(KIND.EnumMember);
  });

  it('kojo-face：命名参数**键** → Property；键**取值** → EnumMember（KC-2b）', () => {
    const keys = kojoSrc('kojo-face').provide(kojoCtx('时机 初见 ', 7));
    expect(find(keys, '成否')!.kind).toBe(KIND.Property);
    const values = kojoSrc('kojo-face').provide(kojoCtx('时机 指令 310 成否: ', 15));
    expect(find(values, '游戏判定')!.kind).toBe(KIND.EnumMember);
  });

  it('kojo-instruction：编号槽中文指令名 → EnumMember；kojo-library：库函数调用位 → Function', () => {
    const ins = kojoSrc('kojo-instruction').provide(kojoCtx('时机 指令 摸屁股', 8));
    expect(find(ins, '摸屁股')!.kind).toBe(KIND.EnumMember);
    const lib = kojoSrc('kojo-library').provide(kojoCtx('心形(', 3));
    expect(find(lib, '心形')!.kind).toBe(KIND.Function);
  });

  it('erb-directives：指令 / 关键字 → Keyword', () => {
    const head = erbSrc('erb-directives').provide(erbCtx('#D', 3));
    expect(find(head, '#DIM')!.kind).toBe(KIND.Keyword);
    const mid = erbSrc('erb-directives').provide(erbCtx('IF A', 5));
    expect(find(mid, 'ELSE')!.kind).toBe(KIND.Keyword);
  });

  it('erb-variables：二段式（CFLAG:）→ Variable；三段式（CFLAG:TARGET:）→ Field', () => {
    const seg2 = erbSrc('erb-variables').provide(erbCtx('CFLAG:', 7));
    expect(find(seg2, '好感度')!.kind).toBe(KIND.Variable);
    const seg3 = erbSrc('erb-variables').provide(erbCtx('CFLAG:TARGET:', 14));
    expect(find(seg3, '好感度')!.kind).toBe(KIND.Field);
  });

  it('erb-functions / erb-system-functions → Function；erb-labels → Reference', () => {
    const fns = erbSrc('erb-functions').provide(erbCtx('CALL M_KOJO', 11));
    expect(find(fns, 'M_KOJO_A')!.kind).toBe(KIND.Function);
    const sys = erbSrc('erb-system-functions').provide(erbCtx('IF A', 5));
    expect(find(sys, 'GETBIT')!.kind).toBe(KIND.Function);
    const labels = erbSrc('erb-labels').provide(erbCtx('@F\n$TARGET_ONE\n\tGOTO $TA', 10, 3));
    expect(find(labels, 'TARGET_ONE')!.kind).toBe(KIND.Reference);
  });
});

/* ============================== 4. 满表遍历（证明不是空跑） ============================== */

describe('SH-6 · 满表遍历（读数：不是空跑）', () => {
  it('两 seam 遍历到的候选 item 总数足够，且每个 source 均有出货', () => {
    const kojo = collectKojo();
    const erb = collectErb();
    // eslint-disable-next-line no-console
    console.log(`[SH-6] kojo items=${kojo.length} erb items=${erb.length} total=${kojo.length + erb.length}`);
    expect(kojo.length).toBeGreaterThan(20); // 别名+代词+关键字+运算符+系统函数 ≥ 20
    expect(erb.length).toBeGreaterThan(20); // 行首全表 + 表达式系统函数 ≥ 20
    const kojoIds = new Set(kojo.map((c) => c.sourceId));
    const erbIds = new Set(erb.map((c) => c.sourceId));
    // 文档词源（QSUG-2）在本桩里不注开关（`wordBasedSuggestions` 缺席 = 不供），
    // 出货另由 `document-words.test.ts` 覆盖；其余 source 每路都必须真出货。
    for (const s of KOJO_COMPLETION_SOURCES) {
      if (s.id === 'kojo-words') continue;
      expect(kojoIds.has(s.id)).toBe(true);
    }
    for (const s of ERB_COMPLETION_SOURCES) {
      if (s.id === 'erb-words') continue;
      expect(erbIds.has(s.id)).toBe(true);
    }
  });
});
