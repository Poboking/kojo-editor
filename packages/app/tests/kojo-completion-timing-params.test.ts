/**
 * KC-2b · `.kojo` 时机块头**命名参数**（键 + 取值联动）补全单测。
 *
 * 走**真实装配 seam**（`KOJO_COMPLETION_SOURCES` 里的 `kojo-face` source）取候选，
 * 桩 monaco / 桩 model / 桩 adapter 表（不引真实 monaco-editor 运行时）。覆盖：
 * - 分野令牌之后给**键**候选（`成否:` / `类型:` / `参数:`），`kind` = `Property`；
 * - 键之后给**取值**候选：`成否:` 取 adapter `successFlag.values`（公开面）、
 *   `类型:` 取该分野模板 `segments`（CJK-primary：有中文键即滤掉纯 ASCII 引擎令牌）、
 *   `参数:` 取语言层闭集 `TIMING_ARG_TOKENS` 派生的**中文主形** `实参` / `实参:2` / `实参$`；
 * - 隐藏英文别名 `args` 不进补全列表；前缀过滤；缺 `faceTable` / 块头已收尾 ⇒ 零候选。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoFaceTable } from '@kojo/plugin-api';
import {
  KOJO_COMPLETION_SOURCES,
  type CompletionSourceContext,
  type CompletionTables,
} from '../src/monaco/kojo-completion';
import { faceCompletionItems, timingNamedParamValueSlot } from '../src/monaco/kojo-completion-faces';

/* ============================== 桩 monaco / model / adapter 表 ============================== */

const KIND = { Property: 8, EnumMember: 7 } as const;

const MONACO = { languages: { CompletionItemKind: KIND } } as unknown as typeof Monaco;

/** 桩 model：`faceCompletionItems` 只读 `getLineContent`（其余字段仅为 ctx 形状完整） */
function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => ({
      word: '',
      startColumn: pos.column,
      endColumn: pos.column,
    }),
  } as unknown as Monaco.editor.ITextModel;
}

/**
 * 桩分野表：`初见`（无段、无成否）；`指令`（带 `com` 段 + 全局成否位协议）。
 * 转译器与宿主都不内建模板——表全由 adapter 侧声明（此处替身贴合生产形状）。
 */
const FACE_TABLE: KojoFaceTable = {
  faces: {
    初见: { template: 'M_KOJO_K{n}_HATSUMI' },
    指令: {
      template: 'M_KOJO{t}_MESSAGE_${com}_K{n}_{i}',
      // 贴合生产形状（eraTW adapter 的 `LOCALS_SEGMENTS`）：引擎令牌排在首位（缺省 / 投影用）、
      // 中文主形随后（CJK-primary 过滤后即补全面板所见）。
      segments: {
        com: {
          COM: 'COM',
          SCOM: 'SCOM',
          普通指令: 'COM',
          副指令: 'SCOM',
          自定指令: 'CUSTOM_COM',
          自定副指令: 'CUSTOM_SCOM',
        },
      },
    },
  },
  successFlag: { target: 'TFLAG:192', values: { 游戏判定: 0, 一定成功: 1, 一定失败: -1, 不执行: -2 } },
};

const FACE_SOURCE = KOJO_COMPLETION_SOURCES.find((s) => s.id === 'kojo-face')!;

/** 走 `kojo-face` source 取一轮候选（光标 = `column`，1-based） */
function provide(
  text: string,
  column: number,
  tables: CompletionTables = { faceTable: FACE_TABLE },
): Monaco.languages.CompletionItem[] {
  const position = { lineNumber: 1, column } as Monaco.Position;
  const ctx: CompletionSourceContext = {
    monaco: MONACO,
    model: modelOf(text),
    position,
    range: { startLineNumber: 1, endLineNumber: 1, startColumn: column, endColumn: column } as Monaco.IRange,
    tables,
  };
  return FACE_SOURCE.provide(ctx);
}

function labels(items: readonly Monaco.languages.CompletionItem[]): string[] {
  return items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

/** 光标落在 `text` 末尾（column = 长度 + 1） */
const atEnd = (text: string): number => text.length + 1;

/** 用 `|` 标记光标取一轮候选（列 = 标记位 + 1；line = 去掉标记后的整行） */
function provideAt(marked: string): Monaco.languages.CompletionItem[] {
  const column = marked.indexOf('|') + 1;
  return provide(marked.replace('|', ''), column);
}

/* ============================== 1. 命名参数**键**候选 ============================== */

describe('KC-2b · 命名参数键候选（kind = Property）', () => {
  it('分野令牌之后给全部已验证键：成否 / 类型 / 参数（顺序即键表声明序）', () => {
    const items = provide('时机 初见 ', atEnd('时机 初见 '));
    expect(labels(items)).toEqual(['成否', '类型', '参数']);
    expect(items.every((i) => i.kind === KIND.Property)).toBe(true);
  });

  it('键候选 `insertText` 带 `: `（半角冒号 + 空格），便于接着写取值', () => {
    const items = provide('时机 初见 ', atEnd('时机 初见 '));
    const chengfou = items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === '成否')!;
    expect(chengfou.insertText).toBe('成否: ');
    expect(chengfou.detail).toBe('时机命名参数');
  });

  it('已输入前缀过滤：`时机 初见 成` → 只给 `成否`', () => {
    const items = provide('时机 初见 成', atEnd('时机 初见 成'));
    expect(labels(items)).toEqual(['成否']);
  });

  it('隐藏英文别名 `args` 不进补全列表（规范 §4.1 中英不对等展示）', () => {
    const items = provide('时机 初见 ', atEnd('时机 初见 '));
    expect(labels(items)).not.toContain('args');
  });
});

/* ============================== 2. 取值联动（成否 / 类型 / 参数） ============================== */

describe('KC-2b · 取值联动（kind = EnumMember）', () => {
  it('`成否: ` → adapter `successFlag.values`（契约公开面）的全部取值', () => {
    const items = provide('时机 指令 310 成否: ', atEnd('时机 指令 310 成否: '));
    expect(labels(items)).toEqual(['游戏判定', '一定成功', '一定失败', '不执行']);
    expect(items.every((i) => i.kind === KIND.EnumMember)).toBe(true);
    expect(items[0]!.detail).toBe('成否 取值');
  });

  it('`类型: ` → 该分野模板 `segments` 的中文主形（指令 → 普通指令 / 副指令 / 自定指令 / 自定副指令）', () => {
    const items = provide('时机 指令 310 类型: ', atEnd('时机 指令 310 类型: '));
    expect(labels(items)).toEqual(['普通指令', '副指令', '自定指令', '自定副指令']);
  });

  it('`类型: ` 在无该段的分野（初见）→ 零候选（不猜）', () => {
    expect(provide('时机 初见 类型: ', atEnd('时机 初见 类型: '))).toEqual([]);
  });

  it('`参数: ` → 语言层闭集 `TIMING_ARG_TOKENS` 派生的**中文主形** `实参` / `实参:2` / `实参$`（多值拼接不做）', () => {
    const items = provide('时机 指令 310 参数: ', atEnd('时机 指令 310 参数: '));
    expect(labels(items)).toEqual(['实参', '实参:2', '实参$']);
  });

  it('取值前缀过滤：`成否: 游` → 只给 `游戏判定`', () => {
    const items = provide('时机 指令 310 成否: 游', atEnd('时机 指令 310 成否: 游'));
    expect(labels(items)).toEqual(['游戏判定']);
  });

  it('多命名参数同头（`成否: 游戏判定 类型: `）→ 值区按键识别，给 `类型:` 取值', () => {
    const items = provide('时机 指令 310 成否: 游戏判定 类型: ', atEnd('时机 指令 310 成否: 游戏判定 类型: '));
    expect(labels(items)).toEqual(['普通指令', '副指令', '自定指令', '自定副指令']);
  });
});

/* ============================== 3. fail-closed / 收尾 / 回归 ============================== */

describe('KC-2b · fail-closed / 收尾 / 回归', () => {
  it('缺 `faceTable` → 零候选（fail-closed，不崩不猜）', () => {
    const text = '时机 初见 成否: ';
    expect(faceCompletionItems(MONACO, modelOf(text), { lineNumber: 1, column: atEnd(text) } as Monaco.Position, undefined)).toEqual([]);
  });

  it('块头已收尾（`成否: 游戏判定：`）→ 该位置零候选', () => {
    const text = '时机 指令 310 成否: 游戏判定：';
    expect(provide(text, atEnd(text))).toEqual([]);
  });

  it('块头已收尾（`初见：`）→ 分野位置亦零候选', () => {
    expect(provide('时机 初见：', atEnd('时机 初见：'))).toEqual([]);
  });

  it('回归：分野位置 `时机 初` 仍给 `初见`（kind = EnumMember）', () => {
    const items = provide('时机 初', atEnd('时机 初'));
    const hit = items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === '初见');
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe(KIND.EnumMember);
    expect(hit!.detail).toBe('M_KOJO_K{n}_HATSUMI');
  });
});

/* ============ 新增：块头空白口径与转译器对齐（全角空格 U+3000 也是空白） ============ */

const FW = '　'; // 全角空格 U+3000：`时机　指令　310　成否: 游戏判定：` 这类写法 lexer 是能编译的

describe('KC-2b · 全角空格形态（键 / 取值联动照出）', () => {
  it('`时机` 后全角分隔 ⇒ 键候选全量（`时机　初见 `）', () => {
    const text = `时机${FW}初见 `;
    const items = provide(text, atEnd(text));
    expect(labels(items)).toEqual(['成否', '类型', '参数']);
    expect(items.every((i) => i.kind === KIND.Property)).toBe(true);
  });

  it('全角缩进 + 前缀过滤（`　时机 初见 成`）→ 只给 `成否`', () => {
    const text = `${FW}时机 初见 成`;
    expect(labels(provide(text, atEnd(text)))).toEqual(['成否']);
  });

  it('块头整串全角分隔 ⇒ 取值联动照出（`时机　指令　310　成否: `）', () => {
    const text = `时机${FW}指令${FW}310${FW}成否:${FW}`;
    const items = provide(text, atEnd(text));
    expect(labels(items)).toEqual(['游戏判定', '一定成功', '一定失败', '不执行']);
    expect(items[0]!.detail).toBe('成否 取值');
  });

  it('全角分隔 + 取值前缀（`时机　指令　类型: 副`）→ 只给 `副指令`', () => {
    const text = `时机${FW}指令${FW}类型: 副`;
    expect(labels(provide(text, atEnd(text)))).toEqual(['副指令']);
  });

  it('全角空格 + 块头已收尾（`时机　初见：`）→ 零候选（与半角同判）', () => {
    const text = `时机${FW}初见：`;
    expect(provide(text, atEnd(text))).toEqual([]);
  });

  it('回归不变：半角写法（`时机 初见 成否: `）取值全量', () => {
    const text = '时机 初见 成否: ';
    expect(labels(provide(text, atEnd(text)))).toEqual(['游戏判定', '一定成功', '一定失败', '不执行']);
  });
});

/* ============ 新增：块头冒号语义（键冒号 vs 块冒号，收口以光标列为界；⑦ 缺陷） ============ */

const RANGE_LINE_1 = { startLineNumber: 1, endLineNumber: 1 } as const;

describe('KC-2b · 块头冒号语义（收尾冒号在光标后不再全程清场）', () => {
  it('F1 `时机 指令 310 成否: 游戏|判定：` → 成否取值候选按前缀给（块冒号在光标之后 = 未收口）', () => {
    const items = provideAt('时机 指令 310 成否: 游戏|判定：');
    expect(labels(items)).toEqual(['游戏判定']);
    // 替换区间止于值令牌编辑面：不吃行尾块冒号（覆盖 `游戏判定`，冒号留在原地）
    expect(items[0]!.range).toEqual({ ...RANGE_LINE_1, startColumn: 15, endColumn: 19 });
  });

  it('F2 行尾块冒号之后（`…游戏判定：|`）→ faces 源零候选（已收口）', () => {
    expect(provideAt('时机 指令 310 成否: 游戏判定：|')).toEqual([]);
  });

  it('F5 `时机 指令 310 成否：|`（全角键冒号紧贴）→ 取值候选在，空插入点区间', () => {
    const items = provideAt('时机 指令 310 成否：|');
    expect(labels(items)).toEqual(['游戏判定', '一定成功', '一定失败', '不执行']);
    expect(items[0]!.range).toEqual({ ...RANGE_LINE_1, startColumn: 14, endColumn: 14 });
  });

  it('F6 `时机 指令 310 成否:|`（半角键冒号紧贴）→ 取值候选在', () => {
    expect(labels(provideAt('时机 指令 310 成否:|'))).toEqual(['游戏判定', '一定成功', '一定失败', '不执行']);
  });

  it('值令牌**内嵌**冒号不算收口（`参数: 实参:2` 顶格写值的回归面）→ 值候选照给', () => {
    expect(labels(provideAt('时机 指令 310 参数: 实参:2|'))).toEqual(['实参:2']);
  });

  it('行尾一枚 `实参:` 按解析器口径就是块头终止符（strip 后值 = `实参`）⇒ 已收口零候选', () => {
    expect(provideAt('时机 指令 310 参数: 实参:|')).toEqual([]);
  });
});

/* ============ 新增：取值位探针 timingNamedParamValueSlot（触发链用，签名定死 boolean） ============ */

describe('KC-2b · 取值位探针 timingNamedParamValueSlot（与候选源同判据）', () => {
  function probeAt(marked: string): boolean {
    const column = marked.indexOf('|') + 1;
    return timingNamedParamValueSlot(marked.replace('|', ''), column);
  }

  it('命中：刚敲完键冒号（`成否:|` / `成否：|` / `参数:|`）与值令牌内 / 空插入点', () => {
    expect(probeAt('时机 指令 310 成否:|')).toBe(true);
    expect(probeAt('时机 指令 310 成否：|')).toBe(true);
    expect(probeAt('时机 指令 310 参数:|')).toBe(true);
    expect(probeAt('时机 指令 310 成否: |')).toBe(true);
    expect(probeAt('时机 指令 310 成否: 游|')).toBe(true);
  });

  it('不命中：键编辑位 / 编号位 / 分野段内 / 已收口 / 非时机行', () => {
    expect(probeAt('时机 指令 310 成|否: 游戏判定：')).toBe(false);
    expect(probeAt('时机 指令 310 成否|: ')).toBe(false);
    expect(probeAt('时机 指令 310 |')).toBe(false);
    expect(probeAt('时机 指令 |')).toBe(false);
    expect(probeAt('时机 指令 310 成否: 游戏判定：|')).toBe(false);
    expect(probeAt('她点了|点头。')).toBe(false);
  });

  it('探针命中 ⇒ 候选源同位置非空（触发链"弹了有货"契约）', () => {
    for (const marked of [
      '时机 指令 310 成否:|',
      '时机 指令 310 成否：|',
      '时机 指令 310 参数:|',
      '时机 指令 310 成否: 游|',
    ]) {
      expect(probeAt(marked)).toBe(true);
      expect(provideAt(marked).length).toBeGreaterThan(0);
    }
  });
});
