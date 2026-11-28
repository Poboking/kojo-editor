/**
 * ERB 引擎报错文案契约闸（ERBDIAG-ERATW）。
 *
 * 守住五件事：
 * 1. **生成产物的输入指纹**：`tools/data/error-texts.yaml` 的 sha256 必须等于产物头记的那枚
 *    ——输入被改了没重跑生成器，当场红。
 * 2. **双向对账**：快照 104 条 id ⇄ 运行时表键集完全相等（不漏条、不留孤儿）。
 * 3. **逐字照抄**：`zhs` / `args` / `status` 与快照逐条相符——文案是玩家见过的引擎原话，
 *    编辑器改写一个标点都算背弃"可搜到"这条判据。
 * 4. **占位符自洽**：`{0}`…`{args-1}` 连续无洞（否则运行时按序号替换会错位）。
 * 5. **覆盖归档**：每一条引擎报错要么有 kojo 对应诊断（`consumed`，写明落点），
 *    要么进 `not-covered` 台账并写明为何——**新增一条引擎报错而不归档即红**，
 *    防"引擎有的检查，kojo 悄悄没有"。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERB_ENGINE_ERROR_TEXTS, formatEngineErrorText } from '@kojo/plugin-api';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const INPUT = path.join(ROOT, 'tools', 'data', 'error-texts.yaml');
const TARGET = path.join(ROOT, 'packages', 'plugin-api', 'src', 'erb.ts');

interface SnapshotEntry {
  readonly id: string;
  readonly args: string;
  readonly status: string;
  readonly zhs: string;
  readonly ja: string;
  readonly en: string;
  readonly used_at: string;
}

/**
 * 读快照（`- id:` 起条目、4 空格缩进的 `键: 值`、`|-` 起块后 6 空格续行）。
 *
 * 为什么测试自己解析而不 import 生成器：生成器是脚本不是模块；且这里刻意用**另一种
 * 写法**再解一遍，两份实现对不上就说明解析口径本身有歧义——那正是要先解决的事。
 */
function readSnapshot(): SnapshotEntry[] {
  const lines = readFileSync(INPUT, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const out: SnapshotEntry[] = [];
  let cur: Record<string, string> | null = null;
  let block: string | null = null;
  for (const ln of lines) {
    const head = /^\s*-\s*id:\s*(\S+)\s*$/.exec(ln);
    if (head) {
      if (cur) out.push(cur as unknown as SnapshotEntry);
      cur = { id: head[1]! };
      block = null;
      continue;
    }
    if (!cur) continue;
    const kv = /^\s{4}([a-z_0-9]+):\s*(.*)$/.exec(ln);
    if (kv) {
      if (kv[2] === '|-') {
        block = kv[1]!;
        cur[block] = '';
      } else {
        cur[kv[1]!] = kv[2]!;
        block = null;
      }
      continue;
    }
    if (block !== null && /^\s{6}/.test(ln)) {
      cur[block] += (cur[block] ? '\n' : '') + ln.slice(6);
    }
  }
  if (cur) out.push(cur as unknown as SnapshotEntry);
  return out;
}

const SNAPSHOT = readSnapshot();

/** 一条引擎报错的处置：要么 kojo 已产出对应诊断，要么写明为何不覆盖。 */
interface Disposition {
  /** `consumed` = kojo 有对应检查；`not-covered` = 尚无（理由必须具体到相位/能力） */
  readonly kind: 'consumed' | 'not-covered';
  /** consumed = 落点与诊断码；not-covered = 缺什么能力，不许写"暂不支持"这类空话 */
  readonly where: string;
  readonly ids: readonly string[];
}

/**
 * 覆盖归档（**这是本闸的实质产出**：一张"引擎会报什么 / kojo 管不管"的对账表）。
 *
 * 分族而不是逐条写 104 行理由：同族条目的判据是同一条相位缺口，逐条复制理由只会
 * 让台账变成噪音，反而看不出还缺哪一块。
 */
const DISPOSITIONS: readonly Disposition[] = [
  {
    kind: 'consumed',
    where:
      '`plugins/erb-parser/src/builtins.ts` 的 `engineText(...)`：文案逐字取本表，' +
      '编辑器只在原文后追加定位说明；诊断码 `ERB_BUILTIN_ARGS`',
    ids: ['TooManyFuncArgs', 'NotEnoughArgs', 'ArgsNotNeeded', 'ArgsNotFitExpr'],
  },
  {
    kind: 'consumed',
    where:
      '`plugins/erb-parser/src/structure.ts` 的 `checkControlFlowStructure` / ' +
      '`checkPreprocStructure` ⇒ 码 `erb.unclosed-open` / `erb.orphan-close` / ' +
      '`erb.orphan-branch`。覆盖面比引擎更细：引擎把这些语句收进几枚通用键，' +
      'kojo 按具体语句给动作提示（补哪一行、删哪一行），故不复述引擎原文',
    ids: [
      'OutsideSelectcase',
      'InvalidElse',
      'UnexpectedEndif',
      'InstructionNotClosed',
      'UnexpectedEndselect',
      'MissingCorresponding',
      'MissingTryc',
      'UnexpectedEndcatch',
      'UnexpectedDatalist',
      'UnexpectedEndlist',
      'MissingPrintdataStrdata',
      'MissingTrycalllist',
      'MissingNoskip',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '缺**词法相位**：需复刻 `LexicalAnalyzer` 的 token 流（含 `EvilMask` 宏展开与 ' +
      '`[[]]` 二重方括号）。kojo 的 `plugin-api/src/erb-lexical.ts` 只做行/串/续行的' +
      '粗切，没有 token 级相位；在此之上补字符级判据会与 `[SKIPSTART]`、`@"` 续行、' +
      '`%…%` 变量记号大面积互相误报',
    ids: [
      'MacroOverLimit',
      'UnexpectedFullWidthSpace',
      'UnexpectedCharacter',
      'EmptyTwoSBrackets',
      'MissingTwoSBrackets',
      'CanNotRenameKey',
      'CanNotInterpretSharpLine',
      'InvalidCharacterAfterInstruction1',
      'InvalidCharacterAfterInstruction2',
      'Use2EqualToAssign',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '缺**逐命令的 ArgumentBuilder 表**（`ArgumentBuilder.cs` 家族：每条命令各自声明参数' +
      '形态与省略位）。kojo 目前只建了 `exmeth` 内建**表达式**的签名表，语句位的命令表' +
      '（`OpcodeTable` 那 400+ 条）还没搬——这是 F 族里最大的一块欠账',
    ids: [
      'Instruction',
      'MissingArg',
      'NotEnoughArguments',
      'TooManyArg',
      'CanNotRecognizeArg',
      'IncorrectArg',
      'ArgIsNotVariable',
      'ArgIsConst',
      'WrongFormat',
      'MissingArgAfterComma',
      'ArgIsNotRequired',
      'ExtraCharacterAfterArg',
      'IgnoreArgBecauseNotInt',
      'OmittedArg1',
      'OmittedArg2',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '缺**变量维度/类型的静态判定**：维度真值（`dim` / `kind`）已随 `ERB_ENGINE_NAMES`' +
      '就位，但还没有消费它的检查器，也没有**全部**变量的实时维度推演（`#DIM` 作者声明与' +
      '引擎内建声明要合成一张表）。这是 F 族里数据已齐、只差判据的一块',
    ids: [
      'ZeroDVarHasArg',
      'MissingVarArg',
      'GetSizeDimError',
      'GetSizeCharaVarWithoutDim',
      'GetSize0DCharaVar',
      'GetSizeNonExistDim',
      'CallCharaVarAsVar',
      'IsUsableOnly1DVar',
      'IsNotVar',
      'IsNotInt',
      'IsNotStr',
      'SetStrToInt',
      'SetIntToStr',
      'VarNameAlreadyUsed',
      'VarStartedHalfDigit',
      'EmptyRefVar',
      'CanNotOmitRefArg',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '**运行时求值**才发生（除零、字符串与负数相乘、XML 解析失败、调用加载期失败的函数）。' +
      '静态能证明的只有常量折叠那一小撮，收益远低于误报风险——编辑器不该假装能替引擎跑一遍',
    ids: [
      'AbnormalPrint',
      'AbnormalPrintdata',
      'DivideByZero',
      'MultiplyNegativeToStr',
      'Multiply10kToStr',
      'XmlGetError',
      'XmlGetPathError',
      'CalledFailedFunc',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '**数组下标越界**：判据是运行时的下标值（`X:ARG` 这类），静态无法定值。' +
      '能静态判的只有"常量字面量下标 > 声明尺寸"，而真语料里这种写法近乎为零',
    ids: [
      'OoRCharaVarArg',
      'OoRInstructionArg',
      'OoRVarArg',
      'OoRCharaVar',
      'OoRArrayShift',
      'OoRArrayRemove',
      'OoRArraySort',
      'OoRPickupcharaArg',
      'OoRSavecharaArg',
      'OoRCvarsetArg',
      'ArgIsOoRBit',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '**逐命令参数范围/可用性**：与 ArgumentBuilder 族同源（都要先有 `OpcodeTable` 的' +
      '命令表），且多数阈值来自游戏侧配置（`GameBase` / `GameProfile`）。' +
      '`NotDefinedLabelName` 另需全项目标签索引，kojo 目前只有函数级 `erb.call-undefined`',
    ids: [
      'AwaitArgIsNegative',
      'AwaitArgIsOver10Seconds',
      'SavedataArgIsNegative',
      'TooLargeSavedataArg',
      'SavetextContainNewLineCharacter',
      'LoaddataArgIsNegative',
      'TooLargeLoaddataArg',
      'DuplicateCharaNo',
      'RefUndefinedChara',
      'OoRForcekanaArg',
      'AssertArgIs0',
      'SetcolorArgLessThan0',
      'SetcolorArgOver255',
      'MaxBarNotPositive',
      'BarNotPositive',
      'TooLongBar',
      'TransparentUnsupported',
      'InvalidColorName',
      'tooLongEncodetouniArg',
      'CanNotUseInstruction',
      'NotDefinedLabelName',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '`ARRAYCOPY` 四条：判据（两边是否数组、维度是否一致、类型是否一致）全部可由' +
      '**已有的 `dim` / `kind` 数据**静态判定，是本表里最容易补的一族——只差一个' +
      '「命令 → 参数语义」的薄壳（同 ArgumentBuilder 缺口）',
    ids: [
      'ArraycopyArgIsNotArray',
      'ArraycopyArgIsCharaVar',
      'DifferentArraycopyArgsDim',
      'DifferentArraycopyArgsType',
    ],
  },
  {
    kind: 'not-covered',
    where:
      '`ArgsCountNotMatches`（`{0}函数: 需要{1}个参数，但传入了{2}个`）：kojo 把"个数不匹配"' +
      '拆进 `NotEnoughArgs` / `TooManyFuncArgs` 两支（能给出"最多/至少几位"更可操作），' +
      '不产这条独立键——**这是有意为之的文案分支差**，不是漏条',
    ids: ['ArgsCountNotMatches'],
  },
];

describe('ERB 引擎报错文案契约（eratw specs/error-texts.yaml）', () => {
  it('生成区间的输入 sha256 与快照逐字相符', () => {
    const raw = readFileSync(INPUT, 'utf8');
    // 与生成器同尺：先 EOL 归一化再算 sha，避免 git autocrlf 换 EOL 造成假红。
    const sha = createHash('sha256').update(raw.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
    expect(readFileSync(TARGET, 'utf8'), 'error-texts.yaml 改了但没重跑 node tools/gen-erb-error-texts.mjs').toContain(
      `sha256 = \`${sha}\``,
    );
  });

  it('快照条数与分布：104 条（wired 54 / registered 50）', () => {
    expect(SNAPSHOT).toHaveLength(104);
    const wired = SNAPSHOT.filter((e) => e.status === 'wired').length;
    expect(wired).toBe(54);
    expect(Object.keys(ERB_ENGINE_ERROR_TEXTS)).toHaveLength(104);
  });

  it('双向对账：快照 id 集 = 运行时表键集', () => {
    const snap = new Set(SNAPSHOT.map((e) => e.id));
    const runtime = new Set(Object.keys(ERB_ENGINE_ERROR_TEXTS));
    expect([...snap].filter((id) => !runtime.has(id)), '快照有条目但生成表缺').toEqual([]);
    expect([...runtime].filter((id) => !snap.has(id)), '生成表有孤儿键').toEqual([]);
  });

  it('每条 zhs / args / status 与快照逐字相符', () => {
    for (const e of SNAPSHOT) {
      const got = ERB_ENGINE_ERROR_TEXTS[e.id];
      expect(got, `缺条目 ${e.id}`).toBeDefined();
      expect(got!.zhs, `${e.id} 的 zhs 被改写了`).toBe(e.zhs);
      expect(got!.args, `${e.id} 的 args`).toBe(Number(e.args));
      expect(got!.status, `${e.id} 的 status`).toBe(e.status);
    }
  });

  it('占位符连续无洞：{0}…{args-1} 全在，且没有越界序号', () => {
    for (const [id, text] of Object.entries(ERB_ENGINE_ERROR_TEXTS)) {
      const used = new Set([...text.zhs.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])));
      const want = Array.from({ length: text.args }, (_, i) => i);
      expect([...used].sort((a, b) => a - b), `${id} 的占位符与 args=${text.args} 不符`).toEqual(want);
    }
  });

  it('覆盖归档：每条引擎报错恰好归入一族（不漏条、不重条）', () => {
    const claimed = DISPOSITIONS.flatMap((d) => d.ids);
    const unique = new Set(claimed);
    expect(unique.size, '同一 id 被归入多族').toBe(claimed.length);
    const missing = SNAPSHOT.map((e) => e.id).filter((id) => !unique.has(id));
    expect(missing, '这些引擎报错还没归档：kojo 要么补检查，要么在台账写明为何不做').toEqual([]);
    const ghost = [...unique].filter((id) => !ERB_ENGINE_ERROR_TEXTS[id]);
    expect(ghost, '台账里有引擎并不存在的 id').toEqual([]);
  });

  it('consumed 的每一族都指到了真实存在的落点文件', () => {
    for (const d of DISPOSITIONS.filter((x) => x.kind === 'consumed')) {
      for (const m of d.where.matchAll(/`([\w./-]+\.(?:ts|kt|cs))`/g)) {
        const rel = m[1]!;
        const abs = rel.startsWith('plugins/') ? path.join(ROOT, 'packages', rel) : path.join(ROOT, rel);
        expect(() => readFileSync(abs, 'utf8'), `${rel} 不存在，落点已漂`).not.toThrow();
      }
    }
  });
});

describe('formatEngineErrorText · 按序号原位替换', () => {
  it('替换全部占位符，不 trim、不改引号形态', () => {
    expect(formatEngineErrorText('NotEnoughArgs', ['STRLENS', 1])).toBe('STRLENS函数: 至少需要1个参数');
    expect(formatEngineErrorText('ArgsNotFitExpr', ['DT_ROW_ADD', 2, 1, 2])).toBe(
      'DT_ROW_ADD函数: 参数数量(2)不满足1+2n',
    );
    // 原文里的全角引号与前置空格照抄，不替作者清理
    expect(formatEngineErrorText('Use2EqualToAssign')).toBe('使用”==”作为赋值运算符');
  });

  it('缺参时把占位符原样留下（让缺参可见，不悄悄插空串）', () => {
    expect(formatEngineErrorText('NotEnoughArgs', ['X'])).toBe('X函数: 至少需要{1}个参数');
    expect(formatEngineErrorText('NotEnoughArgs')).toBe('{0}函数: 至少需要{1}个参数');
  });

  it('未登记 id ⇒ undefined（绝不编造文案）', () => {
    expect(formatEngineErrorText('NoSuchEngineError')).toBeUndefined();
    // 原型链上的名字不能被当成条目（否则 `constructor` 会返回一个函数字符串）
    expect(formatEngineErrorText('constructor')).toBeUndefined();
    expect(formatEngineErrorText('toString')).toBeUndefined();
  });
});
