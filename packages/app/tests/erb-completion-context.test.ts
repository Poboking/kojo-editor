/**
 * T6 · `.erb` 补全位置门 v2（`erbCompletionGate` 纯函数 + 白名单数据 + provider 接线）单测。
 *
 * 纯函数部分零 Monaco 依赖（行文本 + 列 → 门类）：九态判定顺序（串内/插值 → 位坑 → 指令记号 →
 * `@` 定义位 → CALL 名字位 → 标签位 → 变量位 → default）；接线部分用**桩 monaco**（同
 * `erb-completion.test.ts` 口径）钉住**按候选源白名单过滤**的终态：CALL / `@` / `#` / `[` 位
 * 不得出现系统函数（与项目函数同为 `Function` kind——旧口径按 kind 过滤漏掉的正是这一点）、
 * `JUMP` 位只出标签候选；门是**过滤**不是重排（各 source 的 sortText 语义原样）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import {
  DEF_RE,
  ERB_CALL_SLOT_BY_KEYWORD,
  ERB_CALL_STATEMENTS,
  ERB_GATE_SOURCE_WHITELIST,
  ERB_JUMP_KEYWORDS,
  erbCallKeywords,
  erbCompletionGate,
  erbInterpRegionAt,
  erbLabelSlot,
  type ErbCallSlotKind,
  type ErbCompletionGate,
} from '../src/monaco/erb-completion-context';
import { installErbCompletion } from '../src/monaco/erb-completion';

/** 用 `|` 标记光标处（1 基列 = 标记前的字符数 + 1） */
const gate = (marked: string) => erbCompletionGate(marked.replace('|', ''), marked.indexOf('|') + 1);

describe('erbCompletionGate（纯函数：行文本 + 列 → 门类）', () => {
  it('CALL 系语句名之后 → call-target（CALL / CALLL / CALLF，含缩进与前缀中段）', () => {
    expect(gate('CALL |')).toBe('call-target');
    expect(gate('CALL M_K|')).toBe('call-target');
    expect(gate('  CALLL FO|')).toBe('call-target');
    expect(gate('CALLF |FUNC(1)')).toBe('call-target');
  });

  it('第一个顶层逗号之后 = 实参位 → default（一层与多层实参同判；变量的实参另有变量门）', () => {
    expect(gate('CALL FOO, |')).toBe('default');
    expect(gate('CALL FOO, 1, |')).toBe('default');
    expect(gate('CALL M_KOJO, "文本", |')).toBe('default');
  });

  it('括号形态：名字段之后出现 `(`（`CALL(...)` / `CALLF FOO(...)`）→ 光标在表达式里 = default', () => {
    expect(gate('CALL(FOO|), 1')).toBe('default');
    expect(gate('CALLF FOO(1|0)')).toBe('default');
    expect(gate('CALLF FOO(|')).toBe('default');
  });

  it('CALLFORM 不在本门范围（\\b 挡长词）→ default；JUMP 家族归 label-target', () => {
    expect(gate('CALLFORM |')).toBe('default');
    expect(gate('CALLFOO|')).toBe('default');
    expect(gate('JUMP |')).toBe('label-target');
  });

  it('字符串内 → in-string（引号配平为奇；与 CALL 前缀无关）；K2-3 后 FORM 串**闭合插值区**改走 `interp-expr`（见下节）', () => {
    expect(gate('PRINTV "abc|')).toBe('in-string');
    expect(gate('CALL "a(b|')).toBe('in-string');
    expect(gate('PRINTFORM "%CALLNAME:MAS|TER%看到"')).toBe('interp-expr'); // 旧钉用例（K2-3 核心场景）：闭合 `%…%` 顶层区
    expect(gate('PRINTFORM "%CALLNAME:MAS|TER')).toBe('in-string'); // 单枚 `%` 未配对：未闭合区不算插值（宁少不错）
  });

  it('引号配平之后的 CALL 行：字符串已闭合 → 名字段照常 call-target', () => {
    expect(gate('CALL FOO, "文本"')).toBe('default'); // 逗号之后
    expect(gate('CALL M_K|')).toBe('call-target');
  });

  it('其余位置 → default（IF 行 / 行首 / 空行 / 非法列）', () => {
    expect(gate('IF A|')).toBe('default');
    expect(gate('PRINTL|')).toBe('default');
    expect(gate('|')).toBe('default');
    expect(erbCompletionGate('CALL FOO', 0)).toBe('default');
    expect(erbCompletionGate('CALL FOO', Number.NaN)).toBe('default');
  });

  it('复用先例件：括号内的逗号不算顶层（`CALL FOO(A, B)` 的逗号不切名字段）', () => {
    // `(` 在光标之前 → 表达式位 default；若逗号误判为顶层会得到同样的 default，
    // 但 `CALLF FOO(A, B` 未闭合形态里光标在括号内仍应 default（`(` 判据兜住）
    expect(gate('CALLF FOO(A, B|)')).toBe('default');
  });
});

/* ============================== 缺陷 1 · 代码视野扫描（串内 / `;` 注释按状态推进） ============================== */

describe('缺陷 1 · 代码视野扫描（一次线性扫描按状态推进，不是先数引号再看分号）', () => {
  it('`;` 行注释里的孤立半角引号不再吃掉**同行代码位**（旧口径一票否决整轮）', () => {
    expect(gate('CALL M_K| ; 注："未闭合')).toBe('call-target');
    expect(gate('IF A| ; 注："未闭合')).toBe('default');
    expect(gate('CALL M_K| ; PRINT "a;b"')).toBe('call-target');
  });

  it('注释态本身 = 不给代码补全（复用 `in-string` 门态，不新增第四态）；无论注释里引号配平与否', () => {
    expect(gate('; 注："未闭合|')).toBe('in-string');
    expect(gate('; 引号倒是配平了""|')).toBe('in-string'); // 旧口径：偶数引号 ⇒ 误判成代码位、照样弹
    expect(gate('PRINTL 台词 ; 尾注：引号"没配对|')).toBe('in-string');
  });

  it('注释起点之前的一切照旧：`;` 只在普通态才算注释（串内的 `;` 只是一个字符）', () => {
    expect(gate('CALL FOO |;')).toBe('call-target'); // 光标还在代码位，`;` 在其后
    expect(gate('PRINT "a;b" |')).toBe('default'); // 串里的 `;` 不开注释（"先看分号"会误判 in-string）
    expect(gate('PRINT "a;b|')).toBe('in-string'); // 未闭合：到行尾都是串
  });

  it('Emuera `""` 转义 = 一个字面引号，消费两字符且不改串内/串外状态', () => {
    // 光标停在成对引号**中间**：旧口径数出偶数 ⇒ 误判「串外」并弹出代码补全
    expect(erbCompletionGate('PRINT "a""b"', 10)).toBe('in-string');
    expect(erbCompletionGate('PRINT "a""b"', 13)).toBe('default'); // 串已闭合，光标在串尾之后
    expect(gate('PRINT ""|')).toBe('default'); // 空串闭合 = 代码位
    expect(gate('PRINT "" |')).toBe('default');
  });

  it('Emuera `""` 转义（FORM 串形态）：串内仍 in-string、闭合引号之后 default', () => {
    expect(gate('PRINTFORMW "含"|""转义"的文字')).toBe('in-string');
    expect(gate('PRINTFORMW "含""转义|"的文字')).toBe('in-string');
    expect(gate('PRINTFORMW "含""转义"|的文字')).toBe('default'); // 第三个引号是闭合引号
  });
});

/* ============================== K2-3 · interp-expr（串内插值区放行门） ============================== */

describe('K2-3 · interp-expr（FORM 串内**闭合插值区**：`%…%` / `{…}` / `\\@…\\@`）', () => {
  it('闭合 `%…%` 顶层区 → interp-expr（缺陷 ③ 核心场景；紧贴开分隔符也算区内）', () => {
    expect(gate('PRINTFORM "%|CALLNAME:MASTER%"')).toBe('interp-expr');
    expect(gate('PRINTFORM "%a|%b"')).toBe('interp-expr');
    expect(gate('PRINTFORMW "{条件?真#假|}"')).toBe('interp-expr');
  });
  it('花括号条件段与内联三元 `\\@…?…#…\\@`（condition-extractor inline.ts 同字形）→ interp-expr', () => {
    expect(gate('PRINTFORML "今天{CF|}心情"')).toBe('interp-expr');
    expect(gate('PRINTFORML "{CFLAG:TARGET:|}是"')).toBe('interp-expr');
    expect(gate('PRINTFORM "\\@CFLAG:好|?是#否\\@"')).toBe('interp-expr');
    // 光标嵌在 `\@…\@` 区内（`%…%` 与之互斥不另计区，靠外区放行——记号配对口径同 inline.ts）
    expect(gate('PRINTFORMW "\\@A?%CALLNAME:MAS|TER%#否\\@"')).toBe('interp-expr');
  });
  it('未闭合区不算插值（保守口径）：单枚 `%` / 未合 `{` / 未合 `\\@` / 配对后悬尾一枚 → in-string', () => {
    expect(gate('PRINTFORML "{CF|')).toBe('in-string'); // `{` 未闭合
    expect(gate('PRINTFORML "{CF|"')).toBe('in-string'); // 串闭合但 `{` 未闭合
    expect(gate('PRINTFORM "\\@CFLAG:好|?是#否')).toBe('in-string'); // 无收尾 `\@`
    expect(gate('PRINTFORM "%a%b|%c"')).toBe('in-string'); // 第三枚 `%` 悬空：光标在闭合区之外、下一开记号之前
  });
  it('非串视角不问插值：串外 `{…}` 走原门链；注释尾巴 `;` 之后照旧 in-string', () => {
    expect(gate('X = {A|}')).toBe('default');
    expect(gate('PRINTL 台词 ; "{a|}"')).toBe('in-string');
  });
  it('区内括号不打断花括号区（`{(A)}` 仍是顶层 `{}` 区）；串内取模形态的单枚 `%` 不构成区', () => {
    expect(gate('PRINTFORM "{(A|))}"')).toBe('interp-expr');
    expect(gate('PRINTFORM "A = 100 % 3|!"')).toBe('in-string');
  });
  it('`""` 转义不吞插值判据：转义串段内闭合 `%…%` 照样 interp-expr', () => {
    expect(gate('PRINTFORMW "含""转义""%CF|}%尾"')).toBe('interp-expr');
  });
  it('函数实参括号**不取消**插值资格（真语料 CASINO 形；与 inline.ts 深度口径的有意分歧）', () => {
    // 规格夹具出处：CASINO/駒草の賭場.ERB 原样行——整条 `@"…"` 挂在 `COLORMESSAGE(` 的实参括号里，
    // 旧版把 findTopLevel 的括号深度抄来当"顶层"守卫 ⇒ 串内 `\@…\@` 被判非顶层、in-string 零候选。
    const casino = '\tCALL COLORMESSAGE(@"%\\@ プール > 0 ? ＋ # － \\@%{ABS(プール)}枚", 表示色, 1, 1)';
    // 光标 = `\@` 开字形之后一列（1 基列 25，即语义面 cond.column+3）：区内
    expect(erbInterpRegionAt(casino, 25)).toBe(true);
    expect(erbCompletionGate(casino, 25)).toBe('interp-expr');
    // 同形极简回归：`(…)` 里只有一层调用括号的 `%…%` 照样放行
    expect(gate('CALL FOO("名前%CFL|AG%"')).toBe('interp-expr');
    // `{…}` 区内仍是表达式视野（分歧 2 保留）：花括号未闭合时区内 `%` 不另成区
    expect(gate('PRINTFORM "{A %B|%"')).toBe('in-string');
  });
  it('串未闭合而 `%…%` 自身配对 ⇒ 照算插值区（区判据优先于行破损）；右闭记号尾后一列含、再越一列不含', () => {
    // 作者真实打字序：先写 `%A%` 再补收尾引号——光标紧贴右闭 `%` 之后那一刻最需要候选
    const broken = '\tPRINTFORM "%A%B';
    expect(erbInterpRegionAt(broken, 16)).toBe(true); // col0=15：紧贴闭 `%`（开 12 / 闭 14）尾后一列 = hi，含
    expect(erbCompletionGate(broken, 16)).toBe('interp-expr');
    expect(erbInterpRegionAt(broken, 17)).toBe(false); // col0=16：再越过尾后一格（`B` 之后、行尾），不含
    expect(erbInterpRegionAt(broken, 14)).toBe(true); // col0=13：紧贴开 `%` 之后一列 = lo，含
    expect(erbInterpRegionAt(broken, 13)).toBe(false); // col0=12：停在开记号之前（串文本位），不含
    // `\@…\@` 双字符字形同口径：闭字形（占 15-16）尾后一列（col0=17 = hi）含，再越一格不含
    const at = '\tPRINTFORM "\\@a\\@x';
    expect(erbInterpRegionAt(at, 18)).toBe(true);
    expect(erbInterpRegionAt(at, 19)).toBe(false);
  });
});

/* ============================== 门 v2 · 名字位单源（def-slot / directive-token / 标签位 / 变量位 / 位坑） ============================== */

describe('门 v2 · def-slot（行首 `@名字` 定义位）', () => {
  it('行首 `@名字` → def-slot（含缩进 / 全角缩进 / 光标紧贴 `@`）', () => {
    expect(gate('@foo|')).toBe('def-slot');
    expect(gate('  @M_K|')).toBe('def-slot');
    expect(gate('　@M_K|')).toBe('def-slot'); // 全角缩进走 BLANK_CLASS_STR 单源
    expect(gate('@|')).toBe('def-slot');
    expect(gate('　@FUNC_COM|')).toBe('def-slot');
  });

  it('`@` 之后越出名字槽（进了实参）或混入非名字字符 → 不算 def-slot', () => {
    expect(gate('@M_KOJO_MESSAGE(ARGS|')).toBe('default');
    expect(gate('@M_KO%JO|')).toBe('default');
  });

  it('单源 `DEF_RE`：行首空白 + `@`（与候选源共用同一份）', () => {
    expect(DEF_RE.test('@')).toBe(true);
    expect(DEF_RE.test('\u3000@A')).toBe(true);
    expect(DEF_RE.test('X@A')).toBe(false);
  });
});

describe('门 v2 · directive-token（行首 `#…` / `[…]` 记号位）', () => {
  it('行首 `#` / `[` 记号位 → directive-token（token 起点之前全空白）', () => {
    expect(gate('#DI|')).toBe('directive-token');
    expect(gate('#|')).toBe('directive-token');
    expect(gate('[SKIP|')).toBe('directive-token');
    expect(gate('  [SKIPSTART|')).toBe('directive-token');
    expect(gate('　#DIM|')).toBe('directive-token');
  });

  it('行中 `#` / `[`（token 之前有代码）→ 不算 directive-token', () => {
    expect(gate('PRINT #DI|')).toBe('default');
    expect(gate('PRINTL [SKIP|')).toBe('default');
  });
});

describe('门 v2 · label-target（跳转家族目标位；与解析器 JUMP_FAMILY 实名对齐）', () => {
  it('`JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO` 之后 → label-target（含 `SIF … : GOTO` 行内形态）', () => {
    expect(gate('JUMP |')).toBe('label-target');
    expect(gate('GOTO |')).toBe('label-target');
    expect(gate('TRYJUMP |')).toBe('label-target');
    expect(gate('TRYGOTO |')).toBe('label-target');
    expect(gate('SIF x : GOTO |')).toBe('label-target');
    expect(gate('  GOTO $L|')).toBe('label-target');
    expect(gate('SIF x ：TRYGOTO |')).toBe('label-target'); // 全角冒号算分隔
    expect(gate('GOTO　|')).toBe('label-target'); // 全角空白算关键字后分隔（旧 `[ \t]+` 不认）
  });

  it('复合词 / 非跳转家族词不误触；`CALL GOTO |` 仍归 call-target（直系调用门在先）', () => {
    expect(gate('GOTOX |')).toBe('default');
    expect(gate('TRYCGOTO |')).toBe('default');
    expect(gate('CALL GOTO |')).toBe('call-target');
  });

  it('`erbLabelSlot` 单源导出：名字段区间跳过可选 `$`、右界吃满标签字符', () => {
    expect(erbLabelSlot('GOTO ALPHA', 9)).toEqual({ start: 5, end: 10, prefix: 'ALP' }); // 光标在 ALP 之后
    expect(erbLabelSlot('GOTO $ALPHA', 10)).toEqual({ start: 6, end: 11, prefix: 'ALP' }); // `$` 留在区间外
    expect(erbLabelSlot('GOTOX AL', 8)).toBeNull();
    expect(erbLabelSlot('PRINTL AL', 9)).toBeNull();
  });
});

describe('门 v2 · variable-slot（变量引用末段；族头白名单 = ENGINE_VARIABLE_FAMILIES）', () => {
  it('二段 / 三段变量引用末段 → variable-slot（行首与行中都算）', () => {
    expect(gate('CFLAG:性|')).toBe('variable-slot');
    expect(gate('CFLAG:TARGET:性|')).toBe('variable-slot');
    expect(gate('IF CFLAG:性| > 1')).toBe('variable-slot');
    expect(gate('CFLAG:|')).toBe('variable-slot');
  });

  it('非白名单族 / 族头内 / 数字开头末段 → 不认', () => {
    expect(gate('FOO:性|')).toBe('default');
    expect(gate('CFLAG|')).toBe('default');
    expect(gate('CFLAG:12|')).toBe('default');
  });
});

describe('门 v2 · bit-slot（位坑开着且空；判据 = erbBitSlotOpen 同源）', () => {
  it('四种位原语的第二实参坑（空）→ bit-slot', () => {
    expect(gate('GETBIT(HOLD, |)')).toBe('bit-slot');
    expect(gate('SETBIT CFLAG:1, |')).toBe('bit-slot');
    expect(gate('CLEARBIT CFLAG:1,\t|')).toBe('bit-slot');
    expect(gate('INVERTBIT TFLAG:192, |')).toBe('bit-slot');
  });

  it('坑内有内容 / 非位原语 → 不算 bit-slot', () => {
    expect(gate('GETBIT(HOLD, 2|)')).toBe('default');
    expect(gate('SETBIT CFLAG:1, 0|')).toBe('default');
    expect(gate('RAND(1, |)')).toBe('default'); // 普通函数第二实参不是位
  });
});

/* ============================== 缺陷 2 · 门与候选源共用同一张语句表 ============================== */

describe('缺陷 2 · 调用位单源（ERB_CALL_STATEMENTS 一张表；门按槽种类分流）', () => {
  it('`TRYCALL` 是直系调用 ⇒ 进门（旧口径门给 default、源出函数名 ⇒ 整张关键字表混进来）', () => {
    expect(gate('TRYCALL |')).toBe('call-target');
    expect(gate('TRYCALL M_KOJ|')).toBe('call-target');
    expect(gate('  TRYCALL M_KOJO, |')).toBe('default'); // 顶层逗号规则同样适用
    expect(gate('　TRYCALL M_K|')).toBe('call-target'); // 全角缩进走 BLANK_CLASS_STR 单源
  });

  it('`*FORM*` 全族不进门（参数是表达式）；`JUMP` 家族归 label-target（不再混进函数名门）', () => {
    expect(gate('TRYCALLFORM |')).toBe('default');
    expect(gate('TRYCALLFORMF |')).toBe('default');
    expect(gate('TRYCCALLFORM |')).toBe('default');
    expect(gate('TRYJUMP |')).toBe('label-target');
  });

  it('清单本身：`func` 槽集合 + 每句的门类按槽携带（func→call-target / label→label-target / form→default）', () => {
    expect(erbCallKeywords(['func'])).toEqual(['TRYCALL', 'CALLF', 'CALLL', 'CALL']);
    expect(ERB_CALL_STATEMENTS.every((s) => ERB_CALL_SLOT_BY_KEYWORD.get(s.kw) === s.slot)).toBe(true);
    const bySlot: Record<ErbCallSlotKind, ErbCompletionGate> = {
      func: 'call-target',
      label: 'label-target',
      form: 'default',
    };
    for (const s of ERB_CALL_STATEMENTS) {
      expect(gate(`${s.kw} |`)).toBe(bySlot[s.slot]);
    }
  });

  it('标签家族与解析器实名对齐（JUMP_FAMILY）：清单 `label` 槽集合 = ERB_JUMP_KEYWORDS', () => {
    expect(ERB_JUMP_KEYWORDS).toEqual(['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO']);
    const labelKws = ERB_CALL_STATEMENTS.filter((s) => s.slot === 'label').map((s) => s.kw);
    expect([...labelKws].sort()).toEqual([...ERB_JUMP_KEYWORDS].sort());
  });
});

/* ============================== 白名单数据（装配层按 sourceId 过滤的唯一数据源） ============================== */

describe('ERB_GATE_SOURCE_WHITELIST（门 → 只留这些 source）', () => {
  it('六个白名单门逐门断言（门 → 单源）', () => {
    expect(ERB_GATE_SOURCE_WHITELIST['call-target']).toEqual(new Set(['erb-functions']));
    expect(ERB_GATE_SOURCE_WHITELIST['def-slot']).toEqual(new Set(['erb-functions']));
    expect(ERB_GATE_SOURCE_WHITELIST['label-target']).toEqual(new Set(['erb-labels']));
    expect(ERB_GATE_SOURCE_WHITELIST['variable-slot']).toEqual(new Set(['erb-variables']));
    expect(ERB_GATE_SOURCE_WHITELIST['bit-slot']).toEqual(new Set(['erb-bits']));
    expect(ERB_GATE_SOURCE_WHITELIST['directive-token']).toEqual(new Set(['erb-directives']));
  });

  it('`default` / `in-string` / `interp-expr` 不设名单（缺键 = 不过滤）；键集恰好 = 六个白名单门', () => {
    expect(ERB_GATE_SOURCE_WHITELIST['default']).toBeUndefined();
    expect(ERB_GATE_SOURCE_WHITELIST['in-string']).toBeUndefined();
    // K2-3：`interp-expr` **刻意不加新项**——契约口径 = "走 default 的白名单"（不过滤的表达式
    // 候选全集）；给它配一份名单就是把 default 抄成第二份真相。
    expect(ERB_GATE_SOURCE_WHITELIST['interp-expr']).toBeUndefined();
    expect(Object.keys(ERB_GATE_SOURCE_WHITELIST).sort()).toEqual([
      'bit-slot',
      'call-target',
      'def-slot',
      'directive-token',
      'label-target',
      'variable-slot',
    ]);
  });
});

/* ============================== provider 接线（桩 monaco） ============================== */

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, Field: 5, Reference: 6, Method: 7 },
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

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

const PROJECT_FNS: readonly string[] = ['M_KOJO_A', 'M_KOJO_B'];

describe('T6 · provider 接线（门是过滤不是重排）', () => {
  const { monaco, registered } = stubMonaco();
  installErbCompletion(monaco, () => ({ erbFunctionNames: () => PROJECT_FNS }));
  const provider = registered[0]!.provider;
  const kind = monaco.languages.CompletionItemKind;

  it('CALL 名字段：只给函数名形态候选（Function），关键字 / 指令 / 标签全被门滤掉', () => {
    const items = provide(provider, 'CALL M_K', 8);
    expect(items.length).toBeGreaterThan(0);
    expect(items.find((i) => labelText(i.label) === 'M_KOJO_A')).toBeDefined();
    for (const item of items) {
      expect([kind.Function, kind.Method]).toContain(item.kind);
    }
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(false);
  });

  it('缺陷 2 端到端（v2）：CALL 位只出 `erb-functions`——系统函数（同为 Function kind）不得混入', () => {
    const items = provide(provider, 'CALL ', 6);
    expect(items.some((i) => labelText(i.label) === 'GETBIT')).toBe(false);
    expect(items.map((i) => labelText(i.label)).sort()).toEqual([...PROJECT_FNS].sort());
  });

  it('缺陷 2 端到端（v2）：`@` 定义位只出项目函数名（系统函数 / 行中关键字不得混入）', () => {
    const items = provide(provider, '@M_K', 5);
    expect(items.map((i) => labelText(i.label)).sort()).toEqual(['M_KOJO_A', 'M_KOJO_B']);
    expect(items.every((i) => i.kind === kind.Function)).toBe(true);
  });

  it('缺陷 2 端到端（v2）：`#` / `[` 记号位只出指令候选（系统函数被门滤掉）', () => {
    const hash = provide(provider, '#DI', 4);
    expect(hash.some((i) => labelText(i.label) === 'GETBIT')).toBe(false);
    expect(hash.some((i) => labelText(i.label) === '#DIM')).toBe(true);
    const bracket = provide(provider, '[SKIP', 6);
    expect(bracket.some((i) => labelText(i.label) === 'GETBIT')).toBe(false);
    expect(bracket.some((i) => labelText(i.label) === '[SKIPSTART]')).toBe(true);
  });

  it('JUMP / GOTO 位只出标签候选（旧 pin「JUMP 位出函数名」本批有意变更：解析器把 JUMP 目标当标签）', () => {
    const items = provide(provider, 'JUMP \n$LOOP', 6);
    expect(items.map((i) => labelText(i.label))).toEqual(['LOOP']);
    for (const item of items) expect(item.kind).toBe(kind.Reference);
    const goto = provide(provider, 'GOTO \n$LOOP', 6);
    expect(goto.map((i) => labelText(i.label))).toEqual(['LOOP']);
  });

  it('其余位置维持现行为：`IF A` 行中照旧出关键字 + 系统函数（不因门收窄）', () => {
    const items = provide(provider, 'IF A', 5);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(true);
    expect(items.some((i) => labelText(i.label) === 'GETBIT')).toBe(true);
  });

  it('字符串内（非插值位）：零候选——未闭合 `%` / 未闭合引号都不放行（K2-3 保守口径）', () => {
    expect(provide(provider, 'PRINTV "abc', 12)).toEqual([]);
    expect(provide(provider, 'PRINTFORM "%CALLNAME:MAS', 25)).toEqual([]);
  });

  it('K2-3 端到端：串内闭合 `{…}` 区拿到表达式候选（旧口径一票否决零候选）', () => {
    const items = provide(provider, 'PRINTFORML "今天{CF}心情"', 18);
    expect(items.length).toBeGreaterThan(0);
    const labels = items.map((i) => labelText(i.label));
    expect(labels).toContain('ELSE'); // interp-expr = default 口径不过滤
    expect(labels).not.toContain('#DIM'); // 行首限定候选仍不进串
    expect(labels).not.toContain('[SKIPSTART]');
  });

  it('实参位维持现行为：`CALL FOO, ` 之后关键字照常出（门只认名字段）', () => {
    const items = provide(provider, 'CALL FOO, ', 11);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(true);
  });

  it('排序语义不动：门内候选的排名仍按 前缀精确 > 前缀命中 > 其它', () => {
    const items = provide(provider, 'CALL M_KOJO', 12); // 前缀 `M_KOJO` 精确命中 M_KOJO_A/B 同档
    const labels = items.map((i) => labelText(i.label));
    expect(labels.indexOf('M_KOJO_A')).toBeLessThan(labels.length);
    expect(labels.indexOf('M_KOJO_B')).toBe(labels.indexOf('M_KOJO_A') + 1); // 同档按名序，未被门重排
  });

  it('缺陷 2 端到端：`TRYCALL` 名字段同样只给函数名候选（门与源同一张表 ⇒ 关键字表不再混进来）', () => {
    const items = provide(provider, 'TRYCALL M_K', 11);
    expect(items.some((i) => labelText(i.label) === 'M_KOJO_A')).toBe(true);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(false);
    for (const item of items) expect([kind.Function, kind.Method]).toContain(item.kind);
  });

  it('缺陷 1 端到端：注释位零候选，同行（注释之前）的代码位照常进门', () => {
    expect(provide(provider, '; 注："未闭合', 10)).toEqual([]); // 旧口径：孤立引号把整轮杀掉，方向却对不上理由
    const items = provide(provider, 'CALL M_K ; 注："未闭合', 9);
    expect(items.some((i) => labelText(i.label) === 'M_KOJO_A')).toBe(true);
    expect(items.some((i) => i.kind === kind.Keyword)).toBe(false);
  });
});