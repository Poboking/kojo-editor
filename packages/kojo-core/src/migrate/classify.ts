/**
 * 迁移引擎 · v1 行判别（**保守**：只认 v1 冻结语法里能逐字说清的行）。
 *
 * 设计纪律（设计稿 §12.1 / 阶段 M7）：
 * - **不认识就报 unsupported，绝不猜**：判别表只覆盖"机械可迁移 + 明确不可迁移"两张清单；
 *   清单外的行落 `other`（由 `index.ts` 记 unsupported + 目标提示）；
 * - **已经是 2.0 的行**（五锚点 / 声明 / `//` / `选项` 字面量区 / 台词 `角色：「…」`）原样放行，
 *   这是幂等（迁移结果再迁移 = 零改动）的构造基础；
 * - 判别只看**行首词 + 行尾冒号**，不解析表达式——条件/实参原样交给 2.0 前端；
 * - 结构化行（块头 / 语句）的 v1 行内 `;` 注释在这里剥出（随行返回，供迁移器改写成整行 `//`）；
 *   **文本行的 `;` 是作者要打印的字**，不剥（v1 语义）。
 */
import type { CoreDiagnosticCode } from '../diagnostics.js';
import { leadingWord, restAfterWord, stripHeadColon, splitInlineComment, splitTopLevelComma } from './source.js';

/** 2.0 调度词（`@` 家族；`@原生` 的块体另由 `index.ts` 整块透传） */
const KOJO2_DISPATCH_WORDS: ReadonlySet<string> = new Set([
  '算',
  '着色',
  '颜绘',
  '随机',
  '组',
  '循',
  '断',
  '续',
  '标',
  '跳',
  '返',
  '巡',
  '复',
  '函',
  '织',
  '原生',
]);

/** 2.0 已退场的 v1 声明词（出现在 `# ` 后时**不是** 2.0 声明） */
const KOJO2_LEGACY_DECL_WORDS: ReadonlySet<string> = new Set(['版本', '时机']);

/** v1 文件头声明词（2.0 搬到 adapter / 工程配置；`角色` 另作说话人来源） */
const HEAD_DECL_WORDS: ReadonlySet<string> = new Set([
  '角色',
  'char',
  '口上',
  'family',
  '显示名',
  'title',
  '简介',
  'desc',
  '开关',
  'switch',
  '随机形',
  '函数前缀',
  'function-prefix',
  '选择器',
]);

/** v1 取色类文件头声明（明确 unsupported：2.0 搬到 profile） */
const COLOR_OPTION_WORDS: ReadonlySet<string> = new Set([
  '旁白色',
  '口上色',
  '自机色',
  'narration-color',
  'player-color',
  'color',
]);

/** v1 文本行尾等待别名（`续` 是 2.0 正典，不算别名） */
const WAIT_ALIAS_RE = /(?:^|[\s\u3000])(?:~|⏎|cont|continue)\s*$/;

/** v1 台词等待标记（正典 `续`） */
const WAIT_CANON_RE = /(?:^|[\s\u3000])续\s*$/;

/** 行内条件（行内 `如果 条件： 语句`）——贪婪回溯到"最后一个后跟空白的冒号"（同 v1） */
const INLINE_IF_RE = /^([^\s:：]+)\s+(.+)[:：]\s+(\S.*)$/;

/** 2.0 的选项条目（`「标签」：`；与 v1 写法相同，原样放行） */
const CHOICE_ITEM_RE = /^[「｢][^」｣]*[」｣]\s*[：:]\s*$/;

/** 行首原生全大写指令（v1 原生直通行） */
const RAW_INSTR_RE = /^[A-Z][A-Z0-9_]*(?:[:.][^\s]*)?(?:\s|=|$)/;

/** v1 `#DIM` 族（`#` 与词之间无空格） */
const PREPROCESSOR_RE = /^#[A-Za-z_]/;

/** 迁移目标提示（unsupported 台账的人话；由 `index.ts` 取用） */
export const TARGET_HINTS: Readonly<Record<string, string>> = {
  switch: '值查找写 `# 对照表`，语句分叉写 `?` 链（§6.5 / §12.1）',
  branch: '`分支：` + `[条件]` 改成 `?` 链或 `# 池`（§12.1）',
  ask: '`初回 / 询问 / 确认` 2.0 暂无对应：整块放进 `@原生`（§12.1）',
  alias: '`别名` 改成 adapter 变量映射（正文直接写字典名），或放进 `@原生`（§3.4.4）',
  'color-option': '`旁白色 / 口上色 / 自机色` 搬到 project/file profile（§4.7）',
  timing: '一个文件只写一个 `# 机`：多个时机块请拆文件（§3.5）',
  'hidden-timing': '`隐藏情景 / 隐藏口上` 改成 `# 机` / `@织`；无对应时用 `@原生`',
  loop: '`循环` 改成 `@循`（条件）/ `@复`（次数）/ `@巡`（遍历）（§9.3）',
  'loop-end': '删掉收束行：2.0 由缩进收口（§9.3）',
  data: '`数据表：` 是随机数据表：改成 `@随机`，不要映射成 `# 池`（§8.4）',
  assignment: '状态更新写进 `@算` 块，且名字先用 `# 变量` 声明（§8.1）',
  native: '整行放进 `@原生` 缩进围栏（§8.5）',
  const: '改成 `# 常量 <名> 整数 = <值>`（§3.4）',
  section: '段头改成 `?` 链，或把 `若` 的分段语义并在 `# 机` / `@织` 里（§12.1）',
  'custom-command': '`自定指令` 属 adapter UI：放进 `@原生`（§12.1）',
  menu: '`菜单：` 属 adapter UI：改成 `@原生`（§12.1）',
  'statement-fn': '这条语句糖 2.0 未覆盖：放进 `@原生`（§12.1）',
  'line-fold': '2.0 没有源折行：把内容写在一行，或放进 `@原生`（§2.4）',
  call: '`调用` 改成 `! 名字(实参)`（§12.1）',
  return: '`返回` 改成 `@返 [值]`（§2.3 / §12.1）',
  label: '`标签 / 跳到` 改成 `@标 / @跳`（§9.4）',
  unknown: '写法不在 §12.1 迁移表内：保守起见放进 `@原生` 或按 2.0 手工重写',
};

/** 判别结果 + 该行剥出的 v1 行内注释（结构化行；文本行恒 null） */
export interface Classified {
  readonly kind: V1Kind;
  /** 行内 `;` 注释正文（不含 `;`）；null = 没有 */
  readonly comment: string | null;
}

/** 判别结果（判别种类） */
export type V1Kind =
  | { readonly kind: 'blank' }
  | { readonly kind: 'comment'; readonly rest: string }
  /** 已经是 2.0 的行：原样放行 */
  | { readonly kind: 'kojo2' }
  /** v1 文本行（台词 / 旁白，含文内 `;` 原样） */
  | { readonly kind: 'text'; readonly body: string }
  | { readonly kind: 'version' }
  | { readonly kind: 'preprocessor' }
  | { readonly kind: 'skipStart' }
  | { readonly kind: 'skipEnd' }
  /** v1 `@` 原生函数块块头（整块透传为 `@原生`） */
  | { readonly kind: 'rawAt' }
  /** v1 文件头声明（`角色: 12` / `口上: 家族` …；2.0 搬到 adapter/工程配置） */
  | { readonly kind: 'headDecl'; readonly word: string; readonly value: string }
  /** `时机 <面> <编号>：` 块头（块体缩进更深） */
  | { readonly kind: 'timingHead'; readonly rest: string }
  /** `# 时机 <事件>`（无块体；v1 旧声明形） */
  | { readonly kind: 'timingHash'; readonly rest: string }
  | {
      readonly kind: 'ifHead';
      readonly variant: 'if' | 'elif';
      readonly condition: string;
      /** 行内体（`如果 条件： 语句`）；无则空串 */
      readonly inline: string;
    }
  | { readonly kind: 'elseHead' }
  | { readonly kind: 'whenHead'; readonly rest: string }
  | { readonly kind: 'isHead'; readonly rest: string }
  | { readonly kind: 'branchHead' }
  | { readonly kind: 'askHead' }
  | { readonly kind: 'hiddenHead' }
  | { readonly kind: 'loopHead' }
  | { readonly kind: 'loopEnd' }
  | { readonly kind: 'catchHead' }
  | { readonly kind: 'catchEnd' }
  | { readonly kind: 'dataHead' }
  | { readonly kind: 'dataEnd' }
  | { readonly kind: 'menuHead' }
  | { readonly kind: 'choiceHead' }
  /** `「标签」：`（2.0 `选项` 字面量区；与 v1 写法相同） */
  | { readonly kind: 'choiceItem' }
  | { readonly kind: 'colorHead'; readonly color: string }
  | { readonly kind: 'randomHead' }
  | { readonly kind: 'randomInline'; readonly alternatives: readonly string[] }
  | { readonly kind: 'groupHead' }
  | { readonly kind: 'heartHead' }
  | { readonly kind: 'heartLine'; readonly body: string }
  | { readonly kind: 'functionHead'; readonly name: string; readonly params: string | null }
  | { readonly kind: 'callStatement'; readonly target: string }
  | { readonly kind: 'returnStatement'; readonly value: string | null }
  | { readonly kind: 'labelDecl'; readonly name: string }
  | { readonly kind: 'jumpStatement'; readonly target: string }
  /** 清单外的行：由 `index.ts` 记 unsupported（带 code / construct / targetHint） */
  | {
      readonly kind: 'other';
      readonly construct: string;
      readonly code: CoreDiagnosticCode;
      readonly targetHint: string;
      /** 是否带着更深缩进的块体（unsupported 要整块原样保留） */
      readonly block: boolean;
    };

/** 是否是 2.0 合法行（幂等判据；`#` 声明 / `@` 调度 / 五锚点 / 台词 / 选项字面量） */
export function isKojo2Line(body: string): boolean {
  if (body.length === 0) return true;
  if (body.startsWith('//') || body.startsWith('\\')) return true;
  if (body.startsWith('#')) {
    if (!body.startsWith('# ') && !body.startsWith('#\t')) return false;
    const word = leadingWord(body.slice(1).trimStart());
    return !KOJO2_LEGACY_DECL_WORDS.has(word);
  }
  if (body.startsWith('@')) {
    const m = /^@([^\s@]+)/.exec(body);
    const name = m ? m[1]! : '';
    return name.length > 0 && KOJO2_DISPATCH_WORDS.has(name);
  }
  if (/^>\s/.test(body) || body === '>') return true;
  if (/^\?\s/.test(body) || body === '?') return true;
  if (/^!\s/.test(body) || body === '!') return true;
  if (CHOICE_ITEM_RE.test(body)) return true;
  // `选项：` 不在本谓词里：它的块体（条目 + 条目正文）要逐行过迁移（v1 条目正文是 v1 文本行），
  // 由 `index.ts` 的 `choiceHead` 分支专门处理；2.0 已是正典时该分支逐字节复原。
  if (isBlankLineStatement(body)) return true;  if (isDialogue2(body)) return true;
  return false;
}

/** `空行` 三态（2.0 正典；`空行 等待` / `空行 续`） */
function isBlankLineStatement(body: string): boolean {
  const word = leadingWord(body);
  if (word !== '空行' && word !== 'blank') return false;
  const rest = restAfterWord(body, word).trim();
  return rest === '' || rest === '等待' || rest === '续' || rest === 'wait';
}

/**
 * 2.0 台词形 `角色：「…」` 的结构（K2-MIGRATE-SHAPE）。
 *
 * 只描述**形状**（说话人 / 引号内正文 / 引号后尾巴），不判断它来自 v1 还是 2.0——
 * 同形歧义的裁决在 `index.ts`（需要 v1 说话人事实，判别层不持有该事实）。
 */
export interface DialogueShape {
  /** 全角冒号前的说话人（已 trim；非空） */
  readonly speaker: string;
  /** 最外层 `「` 内、最外层 `」` 前的正文（v1 里这段是**打印文本的一部分**） */
  readonly body: string;
  /** 收尾引号之后的内容（已 trim）：`''` / `续` / `(表演提示)[ 续]` */
  readonly tail: string;
  /** 首个 `「` 的下标 */
  readonly quote: number;
  /** 末个 `」` 的下标 */
  readonly close: number;
  /** 说话人后全角冒号的下标（= quote - 1） */
  readonly colon: number;
}

/**
 * 解析 2.0 台词形 `角色：「…」`（含行尾 `续` 与一个表演提示组）；不是该形 → null。
 *
 * 单一真源：`isKojo2Line` 的台词判据、v1 同形歧义的裁决（`index.ts`）都走这里，
 * 避免两处各写一份正则而漂移。
 */
export function parseDialogueShape(body: string): DialogueShape | null {
  const quote = body.indexOf('「');
  if (quote <= 1) return null;
  const colon = body.indexOf('：');
  if (colon <= 0 || colon !== quote - 1) return null;
  const speaker = body.slice(0, colon).trim();
  if (speaker.length === 0) return null;
  const close = body.lastIndexOf('」');
  if (close <= quote) return null;
  const tail = body.slice(close + 1).trim();
  if (tail.length !== 0 && tail !== '续' && !/^\([^()]*\)(?:\s+续)?$/.test(tail)) return null;
  return { speaker, body: body.slice(quote + 1, close), tail, quote, close, colon };
}

/** 2.0 台词 `角色：「…」`（含行尾 `续` 与一个表演提示组） */
function isDialogue2(body: string): boolean {
  return parseDialogueShape(body) !== null;
}

/** 行尾等待别名 → 正典 `续`（`~` / `⏎` / `cont` / `continue`；`续` 不动） */
export function rewriteWaitAlias(body: string): string {
  if (!WAIT_ALIAS_RE.test(body)) return body;
  return body.replace(WAIT_ALIAS_RE, ' 续');
}

/** 2.0 `选项` 条目行 `「标签」：`（v1 写法与 2.0 正典相同） */
export function isChoiceItem(body: string): boolean {
  return CHOICE_ITEM_RE.test(body);
}

/** 行尾是否带 v1 等待标记（正典 `续` 或别名）——heart 迁移用 */
export function hasWaitMark(body: string): boolean {
  return WAIT_ALIAS_RE.test(body) || WAIT_CANON_RE.test(body);
}

/** 行内条件头（`如果 条件： 语句`）——返回 null 表示不是 */
function matchInlineIf(body: string): { word: string; condition: string; inline: string } | null {
  const m = INLINE_IF_RE.exec(body.trimEnd());
  if (!m) return null;
  return { word: m[1]!, condition: m[2]!.trim(), inline: m[3]!.trim() };
}

/**
 * v1 行判别主入口。
 *
 * @param body 去掉行首空白后的行内容
 */
export function classifyV1(body: string): Classified {
  const none = (kind: V1Kind): Classified => ({ kind, comment: null });
  if (body.trim().length === 0) return none({ kind: 'blank' });
  if (isKojo2Line(body)) return none({ kind: 'kojo2' });
  if (body.startsWith(';')) return none({ kind: 'comment', rest: body.slice(1) });
  if (body.startsWith('#')) {
    if (body.startsWith('# ') || body.startsWith('#\t')) {
      const word = leadingWord(body.slice(1).trimStart());
      if (word === '版本') return none({ kind: 'version' });
      if (word === '时机') {
        return none({ kind: 'timingHash', rest: restAfterWord(body.slice(1).trimStart(), word).trim() });
      }
    }
    if (PREPROCESSOR_RE.test(body)) return none({ kind: 'preprocessor' });
    return none(other('不认识的 `#` 行', 'core/lex/anchor', '`#` 与声明词之间要有空格；原生预处理器放进 `@原生`', false));
  }
  if (body === '[SKIPSTART]') return none({ kind: 'skipStart' });
  if (body === '[SKIPEND]') return none({ kind: 'skipEnd' });
  if (body.startsWith('@')) return none({ kind: 'rawAt' });

  // 结构化行：先剥 v1 行内 `;` 注释（文本行不走这条路——`;` 是要打印的字）
  const { code, comment } = splitInlineComment(body);
  const structured = (kind: V1Kind): Classified => ({ kind, comment });

  // 文件头声明形 `词: 值` / 时机子句 `隐藏情景: 条件`：冒号在**行中**（非行尾），
  // 与块头的"行尾冒号"分开判（前者是元数据/子句，后者才是块）。
  const declMatch = /^([^:：\s]+)[ \t]*[:：][ \t]*(.*)$/.exec(code);
  if (declMatch !== null) {
    const word = declMatch[1]!;
    const value = declMatch[2]!.trim();
    if (HEAD_DECL_WORDS.has(word)) return structured({ kind: 'headDecl', word, value });
    if (COLOR_OPTION_WORDS.has(word)) {
      return structured(
        other(`\`${word}\` 文件头声明`, 'core/migration/color-option', TARGET_HINTS['color-option']!, false),
      );
    }
    if (word === '隐藏情景' || word === '隐藏口上' || word === 'skip-scene' || word === 'skip-kojo') {
      return structured({ kind: 'hiddenHead' });
    }
  }

  // 无冒号的语句形收束行（`循环结束 [当 条件]` / `出错处理结束` / `数据表结束`）
  if (/^循环结束(?:[ \t\u3000]|$)/.test(code)) return structured({ kind: 'loopEnd' });
  if (/^出错处理结束(?:[ \t\u3000]|$)/.test(code)) return structured({ kind: 'catchEnd' });
  if (/^数据表结束(?:[ \t\u3000]|$)/.test(code)) return structured({ kind: 'dataEnd' });

  const headCode = stripHeadColon(code);
  if (headCode !== null) {
    const word = leadingWord(headCode);
    const rest = restAfterWord(headCode, word).trim();
    if (HEAD_DECL_WORDS.has(word)) return structured({ kind: 'headDecl', word, value: rest });
    if (COLOR_OPTION_WORDS.has(word)) {
      return structured(
        other(`\`${word}\` 文件头声明`, 'core/migration/color-option', TARGET_HINTS['color-option']!, false),
      );
    }
    switch (word) {
      case '时机':
      case 'timing':
        return structured({ kind: 'timingHead', rest });
      case '如果':
      case 'if':
        return structured({ kind: 'ifHead', variant: 'if', condition: rest, inline: '' });
      case '否则如果':
      case 'elif':
      case 'elseif':
        return structured({ kind: 'ifHead', variant: 'elif', condition: rest, inline: '' });
      case '否则':
      case 'else':
        return structured({ kind: 'elseHead' });
      case '当':
      case 'when':
        return structured({ kind: 'whenHead', rest });
      case '是':
      case 'is':
        return structured({ kind: 'isHead', rest });
      case '分支':
      case 'branch':
        return structured({ kind: 'branchHead' });
      case '初回':
      case '询问':
      case 'ask':
      case '确认':
      case 'confirm':
        return structured({ kind: 'askHead' });
      case '隐藏情景':
      case '隐藏口上':
      case 'skip-scene':
      case 'skip-kojo':
        return structured({ kind: 'hiddenHead' });
      case '循环':
      case 'loop':
        return structured({ kind: 'loopHead' });
      case '循环结束':
        return structured({ kind: 'loopEnd' });
      case '出错处理':
        return structured({ kind: 'catchHead' });
      case '出错处理结束':
        return structured({ kind: 'catchEnd' });
      case '数据表':
      case 'data':
        return structured({ kind: 'dataHead' });
      case '数据表结束':
        return structured({ kind: 'dataEnd' });
      case '菜单':
      case 'menu':
        return structured({ kind: 'menuHead' });
      case '选项':
      case 'choice':
        return structured({ kind: 'choiceHead' });
      case '着色':
        return structured({ kind: 'colorHead', color: rest });
      case '随机':
      case 'random':
        return structured({ kind: 'randomHead' });
      case '组':
      case 'group':
        return structured({ kind: 'groupHead' });
      case '心形':
      case 'heart':
        return structured({ kind: 'heartHead' });
      case '函数':
      case 'function':
        return structured(parseFunctionHead(rest));
      case '若':
        return structured(other('`若` 段块', 'core/migration/raw', TARGET_HINTS.section!, true));
      case '自定指令':
        return structured(other('`自定指令` 块', 'core/migration/raw', TARGET_HINTS['custom-command']!, true));
      default:
        break;
    }
  }

  // 行内 `如果 条件： 语句`（v1 单行块头；不要求行尾冒号，故用原行而不是剥注释后的 code）
  const inlineIf = matchInlineIf(body);
  if (inlineIf !== null) {
    if (inlineIf.word === '如果' || inlineIf.word === 'if') {
      return none({ kind: 'ifHead', variant: 'if', condition: inlineIf.condition, inline: inlineIf.inline });
    }
    if (inlineIf.word === '否则如果' || inlineIf.word === 'elif' || inlineIf.word === 'elseif') {
      return none({ kind: 'ifHead', variant: 'elif', condition: inlineIf.condition, inline: inlineIf.inline });
    }
  }

  const word = leadingWord(code);
  const rest = restAfterWord(code, word);

  // 文本行内的 `;` 是内容：文本类判别一律回原行
  if (word === '心形' || word === 'heart') {
    return rest.trim().length > 0 ? none({ kind: 'heartLine', body: rest.trim() }) : none({ kind: 'text', body });
  }
  if (word === '随机' || word === 'random') {
    const alternatives = splitTopLevelComma(rest);
    if (alternatives.length >= 2) return none({ kind: 'randomInline', alternatives });
    return none({ kind: 'text', body });
  }
  if (word === '调用' || word === 'call') {
    const target = rest.trim();
    if (target.length === 0) return structured(other('`调用` 缺目标', 'core/migration/call-return', TARGET_HINTS.call!, false));
    return structured({ kind: 'callStatement', target });
  }
  if (word === '返回' || word === 'return') {
    const value = rest.trim();
    return structured({ kind: 'returnStatement', value: value.length > 0 ? value : null });
  }
  if (word === '标签') {
    const name = rest.trim();
    if (name.length === 0) return structured(other('`标签` 缺名', 'core/migration/label', TARGET_HINTS.label!, false));
    return structured({ kind: 'labelDecl', name });
  }
  if (word === '跳到') {
    const target = rest.trim();
    if (target.length === 0) return structured(other('`跳到` 缺目标', 'core/migration/label', TARGET_HINTS.label!, false));
    return structured({ kind: 'jumpStatement', target });
  }
  if (word === '别名' || word === 'alias') {
    return structured(other('`别名` 声明', 'core/migration/alias', TARGET_HINTS.alias!, false));
  }
  if (word === '常量' || word === 'const') {
    return structured(other('v1 `常量` 声明', 'core/migration/raw', TARGET_HINTS.const!, false));
  }
  // v1 语句形糖（2.0 未覆盖的清单 → 整行原样保留）
  const statementSugar = mapStatementSugar(word);
  if (statementSugar !== null) return structured(statementSugar);
  if (word === '条目') {
    return structured(other('`条目` 数据表条目行', 'core/migration/data', TARGET_HINTS.data!, false));
  }
  if (word === '原形' || word === '试探') {
    return structured(other(`\`${word}\` TRY 系行`, 'core/migration/raw', TARGET_HINTS.native!, false));
  }
  // v1 原生直通行（全大写指令 / `$标签`）
  if (RAW_INSTR_RE.test(code) || code.startsWith('$')) {
    return structured(other('v1 叙事区原生行', 'core/migration/raw', TARGET_HINTS.native!, false));
  }
  // 行尾 v1 源折行（`\`）：2.0 无逻辑行合并
  if (/(^|[^\\])\\\s*$/.test(code)) {
    return structured(other('v1 源折行（行尾 `\\`）', 'core/migration/raw', TARGET_HINTS['line-fold']!, false));
  }
  // 全角等号：v1 在编译期报 `fullwidth-expr-punct`（脚本拒编译），2.0 同样只认半角；
  // 迁移不猜"作者想赋给谁"，整行留给人工（否则会被当成旁白静默打印出来）。
  if (/＝/.test(code)) {
    return structured(
      other('全角等号 `＝`', 'core/migration/fullwidth-punct', '表达式/赋值里用半角 `=`（§4.13）；不确定就整行放进 `@原生`', false),
    );
  }
  // 赋值 / 裸表达式：v1 语句位，2.0 必须进 `@算`
  if (hasTopLevelAssign(code)) {
    return structured(other('赋值/裸表达式', 'core/migration/raw', TARGET_HINTS.assignment!, false));
  }
  // v1 裸台词 / 裸旁白：交给迁移器（speaker 在那边补）
  return none({ kind: 'text', body });
}

function other(construct: string, code: CoreDiagnosticCode, hint: string, block: boolean): V1Kind {
  return { kind: 'other', construct, code, targetHint: hint.length > 0 ? hint : TARGET_HINTS.unknown!, block };
}

/** v1 `函数 <名>[(形参)]：` → 函数块头；解析失败落 unsupported */
function parseFunctionHead(rest: string): V1Kind {
  const text = rest.trim();
  if (text.length === 0) {
    return {
      kind: 'other',
      construct: '`函数` 缺函数名',
      code: 'core/migration/raw',
      targetHint: '写 `@函 <名>(形参)`',
      block: true,
    };
  }
  const paren = /^([^(（]*?)\s*[（(]\s*(.*?)\s*[)）]$/.exec(text);
  if (paren) {
    const name = paren[1]!.trim();
    if (name.length === 0) {
      return { kind: 'other', construct: '`函数` 缺函数名', code: 'core/migration/raw', targetHint: '写 `@函 <名>(形参)`', block: true };
    }
    return { kind: 'functionHead', name, params: paren[2]!.trim() };
  }
  return { kind: 'functionHead', name: text, params: null };
}

/** 语句形糖词 → unsupported 台账（2.0 未覆盖的清单；整行保留） */
function mapStatementSugar(word: string): V1Kind | null {
  const table: Readonly<Record<string, { construct: string; code: CoreDiagnosticCode; hint: string }>> = {
    设置标记: { construct: '`设置标记` 语句糖', code: 'core/migration/raw', hint: TARGET_HINTS['statement-fn']! },
    结算: { construct: '`结算` 语句糖', code: 'core/migration/raw', hint: TARGET_HINTS['statement-fn']! },
    settle: { construct: '`结算` 语句糖', code: 'core/migration/raw', hint: TARGET_HINTS['statement-fn']! },
    增减: { construct: '`增减` 语句糖', code: 'core/migration/raw', hint: TARGET_HINTS['statement-fn']! },
    adjust: { construct: '`增减` 语句糖', code: 'core/migration/raw', hint: TARGET_HINTS['statement-fn']! },
    步进: { construct: '`步进` 语句糖', code: 'core/migration/loop', hint: TARGET_HINTS.loop! },
    跳出循环: { construct: '`跳出循环`', code: 'core/migration/loop', hint: TARGET_HINTS.loop! },
    跳过本轮: { construct: '`跳过本轮`', code: 'core/migration/loop', hint: TARGET_HINTS.loop! },
    重跑本轮: { construct: '`重跑本轮`', code: 'core/migration/loop', hint: TARGET_HINTS.loop! },
    函数跳转: { construct: '`函数跳转`', code: 'core/migration/call-return', hint: '放进 `@原生` 写原生 `JUMP`' },
  };
  const hit = table[word];
  if (!hit) return null;
  return { kind: 'other', construct: hit.construct, code: hit.code, targetHint: hit.hint, block: false };
}

/** 顶层赋值运算符（`=` 不是 `==` / `!=` / `>=` / `<=`；引号外）——v1 语句位判据 */
export function hasTopLevelAssign(body: string): boolean {
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString || ch !== '=') continue;
    const prev = i > 0 ? body[i - 1]! : '';
    const next = i + 1 < body.length ? body[i + 1]! : '';
    if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>' || prev === '\\') continue;
    if (body.slice(0, i).trim().length === 0) continue;
    return true;
  }
  return false;
}
