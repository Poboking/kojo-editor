/**
 * 口上调用协议解析（eraAkumaMaid；游戏知识只住本包，结构照 eratw-adapter）。
 *
 * 解析主路由表（`ERB/EVENT_K/EVENT_K.ERB`，= eraTW `KOJO_MESSAGE.ERB` 的等价物），
 * 把「路由层转发给口上函数的实参结构」声明为槽位语义表（`KojoCallProtocol` 契约）。
 *
 * 路由形态实测（eraAkumaMaid，Emuera 1824+v18 私家改造版；EVENT_K.ERB 全文 528 行，
 * UTF-8-BOM）：
 *
 *   TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}
 *   TRYCALLFORM KOJO_MESSAGE_COM_K{NO:TARGET}, ARGS        ← `, ARGS` = 被调方带 ARGS 签名
 *   TRYCALLFORM KOJO_MESSAGE_PALAMCNG_K{NO:TARGET}, LOCALS ← `, LOCALS` = 被调方带 LOCALS
 *   TRYCALLFORM COM_ABLE{TEQUIP:シックスナイン}            ← 引擎自有调用，非口上路由
 *
 * 实测读数（逐行、跳过注释行）：
 * - CALLFORM 系路由行共 **18** 条；
 * - 命中口上家族（`…_K{…}` 锚）的 **16** 条 / 去重后 **14** 个模板；引擎自有
 *   （`COM_ABLE{TEQUIP:…}`，无 `_K{` 锚）**2** 条；
 * - 带 `(ARG…)` 实参表的路由行 **0** 条——本游戏路由**不向前转发具名槽位**；
 * - 带 `%…%` 插值的路由行 **0** 条；
 * - 带 `, ARGS` / `, LOCALS` 修饰后缀的 **5** 条
 *   （PALAMCNG / COUNTER / MARKCNG / EVENT / GUEST）。
 *
 * 与 eraTW（eratw-adapter/src/call-protocol.ts）的差异：
 * 1. **无 `M_KOJO` 前缀锚**：eraTW 模板形如 `M_KOJO%口上名%_家族_K…`；本游戏是
 *    **后缀式** `{家族}_K{NO:TARGET}`（无口上名插值段、无前缀）⇒ 路由行正则
 *    **不锚 `M_KOJO`**，家族名取模板开头到 `_K{` 之前的字面段；
 * 2. **`{NO:TARGET}` 是角色号、不是数值时机号**：eraTW 把**尾部** `{…}` 当数值
 *    时机号（`…_K49_2` 尾段的 2）；本游戏的时机号由作者在函数名里自管（主流形态
 *    `@KOJO_MESSAGE_COM_K1` 内部按 SELECTCOM 分派；路由只拼到 `_K{角色号}`），
 *    路由模板里的内嵌表达式**只有角色号**（`{NO:TARGET}` / `{NO:ACTOR}`，恒数值）
 *    ⇒ 通配取 `\d+`。位于模板尾部时记 `numericTail`——它在本包**只表示「尾段是
 *    数值段」**（供同字面长消歧），**不是 eratw 的「数值时机号」语义**，别错判；
 * 3. **`, ARGS` / `, LOCALS` / `, ACTOR` / `, STR:…` 修饰后缀**（Emuera 1824+v18
 *    TRYCALLFORM 扩展语法）：是整数组透传 / 局部量声明，**不是** `(ARG:n)` 具名
 *    转发 ⇒ 路由行正则必须把模板 token 在逗号处截断，否则模板会带上尾逗号而永远
 *    配不上函数名（`KOJO_COUNTER_K{NO:TARGET},` ≠ `KOJO_COUNTER_K1`）；
 * 4. 实测**零具名转发**：口上路由行的 `(实参表)` 全为空 ⇒ 本游戏的槽位语义表对
 *    路由可达函数恒为**空槽**（协议认识该函数、但路由不转发任何槽）。
 *
 * 语义依据：`(ARG:n)` 转发槽位语义（按序绑定 / 非平凡实参不建模）照 eratw，
 * 其存在是为了结构对齐与魔改路由文件；eraAkumaMaid 实测路由不用该形态
 * （见上读数）。口上函数命名形态实测（`ERB/EVENT_K/<编号>/` 目录下的
 * `EVENT_K{n}.ERB`）：`@KOJO_MESSAGE_COM_K1`、`@KOJO_EVENT_K1, ARGS`——即
 * `{家族}_K{角色号}`，
 * 尾段严格锚定（路由生成的名字就到角色号为止；`15 槞彁/遺産` 里旧系统残留的
 * `@KOJO_MESSAGE_COM_K15_1` 形态无对应路由模板，不可达 ⇒ 不匹配，不猜）。
 */

import type { FileIO, KojoCallProtocol, KojoCallSlot, Logger, ReplayCallContext } from '@kojo/plugin-api';
import { stableHash } from '@kojo/plugin-api';

/** 路由行：CALLFORM / TRYCALLFORM / TRYCCALLFORM（TRYC 系）<模板>[<实参表>][, 修饰]；
 *  实参表括号可省（无实参转发）。**模板 token 在空白 / `(` / `,` 处截断**——本游戏
 *  TRYCALLFORM 支持 `, ARGS` / `, LOCALS` / `, ACTOR` / `, STR:…` 修饰后缀（整数组
 *  透传 / 局部量声明，非具名转发），不截断会把尾逗号吃进模板。
 *  第 3 捕获组 = 修饰后缀（`ARGS` / `LOCALS` 是**真实转发**：被调方以
 *  `@F, ARGS` 声明 1 个字符串槽接收整个数组——见 `modifierStrSlots`）。 */
const ROUTE_LINE_RE =
  /\b(?:TRYC?)?CALLFORM\s+([^\s(,]+)\s*(?:\(([^)]*)\))?\s*(?:,\s*(ARGS|LOCALS|ACTOR|STR:[^\s,]+))?/;

/**
 * 修饰后缀 → 折算的字符串槽数。
 *
 * `, ARGS` / `, LOCALS` 在 Emuera 1824+v18 的 TRYCALLFORM 扩展语法里是**整数组透传**：
 * 被调方的 `@F, ARGS` 以 1 个字符串槽接收整个 ARGS 数组（LOCALS 同理）。它不是
 * 「具名转发」（无 `(ARG:n)` 槽位编号），但**确实是转发**——覆盖校验必须把它算进
 * 转发槽数，否则「声明 1 个 ARGS 槽的 PALAMCNG/MARKCNG/COUNTER/EVENT/GUEST」会被
 * 误判成"签名槽永远收默认值"（全语料实测误报 369 条，正好 = 5 家族 × 74 角色）。
 *
 * `, ACTOR` / `, STR:…` 语义未取得语料证据（实测路由 0 处）⇒ 不建模（不猜）。
 */
function modifierStrSlots(modifier: string | undefined): number {
  if (!modifier) return 0;
  const m = modifier.toUpperCase();
  return m === 'ARGS' || m === 'LOCALS' ? 1 : 0;
}

/** 单个转发实参 token：ARG:n（数值）或 ARGS:n（字符串） */
const ARG_TOKEN_RE = /^(ARG|ARGS)(?::(\d+))?$/;

/** 家族名锚：模板开头到 `_K{` 之前的字面段（后缀式命名，如
 *  `KOJO_MESSAGE_COM_K{NO:TARGET}` → `KOJO_MESSAGE_COM`）。无 `_K{` ⇒ 不是口上
 *  路由（引擎自有的 `COM_ABLE{TEQUIP:…}`、`%TachieType%_TachieGenerate` 等）⇒ 跳过。 */
const FAMILY_ANCHOR_RE = /^(.*)_K\{/;

/** 家族模板 → 函数名匹配正则：`%…%` 与 `{…}` 为通配段，其余字面。
 *
 *  - `%…%` = 字符串插值段 → `.+`（eraAkumaMaid 实测路由 0 处；保留为魔改路由兜底）；
 *  - `{…}` = 引擎内嵌表达式 → `\d+`：实测路由模板中的内嵌表达式**只有角色号**
 *    （`{NO:TARGET}` / `{NO:ACTOR}`，恒数值）——它不是 eratw 的「尾部数值时机号」
 *    （本游戏时机号由作者在函数名里自管、路由不拼时机），但正则语义同为数值段；
 *  - 尾部 `%…%` → `.+`（字符串时机形态；同字面长时排在数值段之后）；
 *  - 累计**字面字符数**（literalLen）——同名多模板命中时取最具体的一张
 *    （字面最长者），消解互相包含的歧义。 */
function templateToRegex(template: string): { regex: RegExp; numericTail: boolean; literalLen: number } {
  let pattern = '^';
  let numericTail = false;
  let literalLen = 0;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c === '%') {
      const close = template.indexOf('%', i + 1);
      pattern += '.+'; // 插值段（任意文本；尾部 = 字符串时机）
      i = close < 0 ? template.length : close;
    } else if (c === '{') {
      const close = template.indexOf('}', i + 1);
      const isTail = close === template.length - 1;
      pattern += '\\d+'; // 内嵌表达式 = 数值角色号（{NO:TARGET} / {NO:ACTOR}）
      // 尾段为数值段——仅用于同字面长时「数值模板优先于字符串模板」的消歧；
      // **不表示时机号语义**（eraAkumaMaid 的时机号不在路由模板里）。
      if (isTail) numericTail = true;
      i = close < 0 ? template.length : close;
    } else {
      pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      literalLen++;
    }
  }
  return { regex: new RegExp(pattern + '$'), numericTail, literalLen };
}

interface FamilyRule {
  family: string;
  regex: RegExp;
  slots: KojoCallSlot[];
  /** `, ARGS` / `, LOCALS` 修饰后缀折算的字符串转发槽数（0 或 1；见 `modifierStrSlots`） */
  modifierStr: number;
  /** 尾部通配段是数值段（`{NO:TARGET}` → `\d+`）——匹配优先级高于字符串时机模板 */
  numericTail: boolean;
  /** 字面字符数——同类型模板命中时取最具体（字面最长）者 */
  literalLen: number;
}

/** 解析转发实参表 → 槽位（按序绑定；ARG:n=int 槽 / ARGS:n=str 槽）。
 *  eraAkumaMaid 实测路由 0 处具名转发；保留为结构对齐与魔改路由兜底。 */
function parseArgsToSlots(argList: string): KojoCallSlot[] {
  const tokens = argList
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const slots: KojoCallSlot[] = [];
  let intIdx = 0;
  let strIdx = 0;
  for (const token of tokens) {
    const m = ARG_TOKEN_RE.exec(token.toUpperCase());
    if (!m) continue; // 非平凡实参（如 OVERRIDE_TARGET）→ 不建模
    if (m[1] === 'ARGS') {
      slots.push({ index: strIdx, kind: 'str', label: `转发自路由 ${token}（字符串）` });
      strIdx++;
    } else {
      slots.push({ index: intIdx, kind: 'int', label: `转发自路由 ${token}` });
      intIdx++;
    }
  }
  return slots;
}

export interface LoadErakumamaidCallProtocolOptions {
  io: FileIO;
  /** 主路由文件（`ERB/EVENT_K/EVENT_K.ERB`）绝对路径 */
  routeFile: string;
  log: Logger;
}

/**
 * eraAkumaMaid 口上调用协议（在通用 `KojoCallProtocol` 之上扩展覆盖判定所需能力）。
 *
 * `slotsFor` 返回**最具体**的一张模板（字面最长优先）——用于 UI 展示"该函数
 * 的典型场景参数"；`maxForwardedSlotsFor` 返回**所有**匹配模板的逐类最大槽数
 * ——用于覆盖校验（判定声明槽是否"永远收默认值"）。
 *
 * 两者分开的原因：一个函数名可能被多条路由模板同时接纳——UI 需确定性首选，
 * 而"是否永远拿不到转发值"必须按**存在性**（任一模板转发即不算永远）判定。
 */
export interface ErakumamaidCallProtocol extends KojoCallProtocol {
  /** 所有匹配模板的**逐类最大**转发槽数；无模板匹配 → null（协议不认识该函数） */
  maxForwardedSlotsFor(functionName: string): { int: number; str: number } | null;
  /**
   * 路由表正文摘要（additive）：分区缓存判据（约定规则 `partition.key`）用它把
   * "路由文件变了但口上 ERB 没变"的失效也兜住。同内容重建 ⇒ 同摘要。
   */
  readonly routeDigest?: string;
}

/**
 * 加载口上调用协议（读路由文件逐行解析）。
 * 文件不存在 / 读取失败 / 无口上家族模板 → 返回 undefined（协议不可用，优雅降级
 * ——UI 隐藏场景参数区、约定规则不产出问题）。
 */
export async function loadErakumamaidCallProtocol(
  opts: LoadErakumamaidCallProtocolOptions,
): Promise<ErakumamaidCallProtocol | undefined> {
  let text: string;
  try {
    text = (await opts.io.readText(opts.routeFile)).text;
  } catch (err) {
    opts.log.warn(`Call protocol route file unreadable: ${opts.routeFile} — ${String(err)}`);
    return undefined;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 实测本游戏 ERB 均 UTF-8-BOM

  const rules: FamilyRule[] = [];
  for (const raw of text.split(/\r\n|\n/)) {
    const line = raw.trim();
    if (line.startsWith(';')) continue; // 注释（含协议说明块）
    const m = ROUTE_LINE_RE.exec(line);
    if (!m) continue;
    const template = m[1]!;
    // 家族名：模板开头到 `_K{` 之前的字面段（后缀式命名；无 `_K{` ⇒ 非口上路由）
    const fam = FAMILY_ANCHOR_RE.exec(template)?.[1];
    if (!fam) continue;
    const slots = parseArgsToSlots(m[2] ?? '');
    const modifierStr = modifierStrSlots(m[3]);
    const { regex, numericTail, literalLen } = templateToRegex(template);
    const rule: FamilyRule = { family: fam, regex, slots, modifierStr, numericTail, literalLen };
    const existing = rules.find((r) => r.regex.source === rule.regex.source);
    if (existing) {
      // 同模板多行 → 取槽位更多的一张（覆盖最全场景）；修饰槽取较大者
      if (rule.slots.length > existing.slots.length) existing.slots = rule.slots;
      if (rule.modifierStr > existing.modifierStr) existing.modifierStr = rule.modifierStr;
    } else {
      rules.push(rule);
    }
  }

  if (rules.length === 0) {
    opts.log.warn(`Call protocol: no route templates found in ${opts.routeFile}`);
    return undefined;
  }

  /**
   * 以下两样都是**每次调用重算的常量**：`slotsFor` 以前每调一次就 `[...rules].sort(...)`
   * （回放面板一次要对上千个函数名各调一次），`maxForwardedSlotsFor` 每次重数一遍每条
   * 模板的槽。协议对象随 `loadProject` 重建 ⇒ 预计算天然随项目失效。
   */
  const sortedBySpecificity: readonly FamilyRule[] = [...rules].sort(
    (a, b) => b.literalLen - a.literalLen || Number(b.numericTail) - Number(a.numericTail),
  );
  const ruleSlots = rules.map((r) => {
    let int = 0;
    // 初值含修饰后缀折算的串槽（`, ARGS` / `, LOCALS` 整数组透传 = 1 串槽）
    let str = r.modifierStr;
    for (const slot of r.slots) {
      if (slot.kind === 'int') int++;
      else str++;
    }
    return { rule: r, int, str };
  });

  /** 匹配优先级：①**字面最长**（最具体）优先——消解互相包含的歧义；②同字面长时
   *  **数值段模板优先**（尾部 `\d+`）——数值函数名不应被字符串时机模板
   *  （尾部 `.+`）抢先匹配。 */
  const slotsFor = (functionName: string): readonly KojoCallSlot[] | null => {
    const name = functionName.toUpperCase();
    for (const r of sortedBySpecificity) {
      if (r.regex.test(name)) return r.slots;
    }
    return null;
  };

  /** 从槽位 label 抽出路由转发来源 token（如 `ARG:2`）；无 → null */
  const forwardToken = (slot: KojoCallSlot): string | null =>
    /转发自路由\s+(ARGS?:\d+)/.exec(slot.label)?.[1] ?? null;

  return {
    slotsFor,
    /** 路由表正文摘要（分区缓存判据用；正文含注释——保守方向，宁多废一次不多复用一次） */
    routeDigest: stableHash(text),

    /**
     * 推导「确定槽值」调用上下文（HK-20）——只填**确定事实**：
     * 路由转发来源为 `ARG:2` 的槽 = 回放角色号（eraTW 口径：路由层
     * `TARGET = ARG:2`、「ARG:2 = 発言者」）；其余转发槽（`ARG:3`/`ARG:4`/…）是
     * 场景输入、无路由匹配者协议不认识 ⇒ 不填。全无确定事实 → `undefined`
     * （调用方保持 unknown('call-context')，**不猜**）。
     *
     * eraAkumaMaid 实测：路由零具名转发 ⇒ 对任何函数都返回 `undefined`
     * （无「发言者」槽可填——本游戏的口上函数签名槽要么不存在、要么由 `, ARGS`
     * 修饰整数组透传，值全是场景输入，不可推导）。
     */
    deriveCallContext(functionName: string, characterNo: number): ReplayCallContext | undefined {
      const slots = slotsFor(functionName);
      if (!slots) return undefined;
      let ints: (number | undefined)[] | undefined;
      let strs: (string | undefined)[] | undefined;
      let derived = false;
      for (const slot of slots) {
        const tok = forwardToken(slot)?.toUpperCase() ?? null;
        if (slot.kind === 'int') {
          const arr = (ints ??= []);
          if (tok === 'ARG:2') {
            arr[slot.index] = characterNo;
            derived = true;
          } else {
            arr[slot.index] = undefined;
          }
        } else {
          (strs ??= [])[slot.index] = undefined;
        }
      }
      return derived ? { ints, strs } : undefined;
    },

    maxForwardedSlotsFor(functionName: string): { int: number; str: number } | null {
      const name = functionName.toUpperCase();
      let int = 0;
      let str = 0;
      let matched = false;
      for (const { rule, int: ri, str: rs } of ruleSlots) {
        if (!rule.regex.test(name)) continue;
        matched = true;
        if (ri > int) int = ri;
        if (rs > str) str = rs;
      }
      return matched ? { int, str } : null;
    },
  };
}
