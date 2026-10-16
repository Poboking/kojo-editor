/**
 * 口上调用协议解析（v0.2 第十批；eraTW 游戏知识，只住本包）。
 *
 * 解析 KOJO_MESSAGE.ERB 的路由表，把"路由层转发给口上函数的实参结构"
 * 声明为槽位语义表（`KojoCallProtocol` 契约）。
 *
 * 路由形态实测（ERB/口上・メッセージ関連/KOJO_MESSAGE.ERB，eraTW 4.980）：
 *
 *   TRYCALLFORM M_KOJO%KOJO_NAME%_SPEVENT_K{NO:TARGET}_{ARG:1}(ARG:3,ARG:4)
 *   TRYCALLFORM M_KOJO%RESULTS%_EVENT_K{NO:TARGET}_%ARGS:1%(ARGS:2,ARG:3,ARG:4)
 *
 * - `%…%` = 变量插值段（口上名 / 字符串时机）→ 函数名中为任意文本；
 * - `{…}` = 引擎内嵌表达式（NO:TARGET / ARG:1 等，函数名后缀 = 时机号）；
 * - 括号内 = 转发实参表：ARG:n → 函数的**数值槽**（按序绑定 ARG:0..），
 *   ARGS:n → **字符串槽**（按序绑定 ARGS:0..）；值为场景输入（不可推导），
 *   未设置槽在转发链上 = 0/''（fresh 局部量语义——"默认场景"的依据）。
 *
 * 语义依据：KOJO_MESSAGE_SEND 头注释（ARG:3~6/ARGS:1~2 = 透传缓冲）+
 * Process.CalledFunction ConvertArg（签名槽按序绑定）。
 */

import type { FileIO, KojoCallProtocol, KojoCallSlot, Logger, ReplayCallContext } from '@kojo/plugin-api';
import { stableHash } from '@kojo/plugin-api';

/** 路由行：CALLFORM / TRYCALLFORM / TRYCCALLFORM（TRYC 系）<模板>(<实参表>)；
 *  括号可省（无实参转发）。**TRYCALLFORM 是 TRY+CALLFORM，TRYCCALLFORM 是
 *  Emuera TRYC 系关键字**（实测整合版 214 处，如 `_EVENT_K…_ONABARE_…` 分支
 *  多实参转发）——不解析会造成家族槽位误判。 */
const ROUTE_LINE_RE = /\b(?:TRYC?)?CALLFORM\s+(M_KOJO[^\s(]+)\s*(?:\(([^)]*)\))?/;

/** 单个转发实参 token：ARG:n（数值）或 ARGS:n（字符串） */
const ARG_TOKEN_RE = /^(ARG|ARGS)(?::(\d+))?$/;

/** 家族模板 → 函数名匹配正则：%…% 与 {…} 为通配段，其余字面。
 *  **尾部段类型区分**（数值/字符串时机的函数名判定）：尾部 {…}（数值表达式
 *  如 {ARG:1}）→ `\d+`；尾部 %…%（字符串时机 %ARGS:1%）→ `.+`。中段一律 `.+`。
 *  同时累计**字面字符数**（literalLen）——同名多模板命中时取最具体的一张
 *  （字面最长者），消解 `_EVENT_` 与 `_DAILY_EVENT_` / `_26_1` 等互相包含的歧义。 */
function templateToRegex(template: string): { regex: RegExp; numericTail: boolean; literalLen: number } {
  let pattern = '^';
  let numericTail = false;
  let literalLen = 0;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c === '%') {
      const close = template.indexOf('%', i + 1);
      pattern += '.+'; // 插值段（尾部 = 字符串时机：任意文本）
      i = close < 0 ? template.length : close;
    } else if (c === '{') {
      const close = template.indexOf('}', i + 1);
      const isTail = close === template.length - 1;
      if (isTail) {
        pattern += '\\d+'; // 尾部内嵌表达式 = 数值时机号（函数名后缀为纯数字）
        numericTail = true;
      } else {
        pattern += '.+'; // 中段内嵌表达式（如 CHILD_{ARGS:1} 的子事件名）
      }
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
  /** 尾部段是数值时机（{ARG:1} → \d+）——匹配优先级高于字符串时机 */
  numericTail: boolean;
  /** 字面字符数——同类型模板命中时取最具体（字面最长）者 */
  literalLen: number;
}

/** 解析转发实参表 → 槽位（按序绑定；ARG:n=int 槽 / ARGS:n=str 槽） */
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

export interface LoadCallProtocolOptions {
  io: FileIO;
  /** KOJO_MESSAGE.ERB 绝对路径 */
  routeFile: string;
  log: Logger;
}

/**
 * eraTW 口上调用协议（在通用 `KojoCallProtocol` 之上扩展覆盖判定所需能力）。
 *
 * `slotsFor` 返回**最具体**的一张模板（字面最长优先）——用于 UI 展示"该函数
 * 的典型场景参数"；`maxForwardedSlotsFor` 返回**所有**匹配模板的逐类最大槽数
 * ——用于覆盖校验（判定声明槽是否"永远收默认值"）。
 *
 * 两者分开的原因：一个函数名可能被多条路由模板同时接纳（`_EVENT_K…_CHILD_RAISING_…`
 * 既命中 `_CHILD_%ARGS:1%`，也命中通用 `_EVENT_K…_%ARGS:1%`）——UI 需确定性首选，
 * 而"是否永远拿不到转发值"必须按**存在性**（任一模板转发即不算永远）判定。
 */
export interface EratwCallProtocol extends KojoCallProtocol {
  /** 所有匹配模板的**逐类最大**转发槽数；无模板匹配 → null（协议不认识该函数） */
  maxForwardedSlotsFor(functionName: string): { int: number; str: number } | null;
  /**
   * 路由表正文摘要（PERF-12b，additive）：分区缓存判据（`ConventionProjectPartition.key`）
   * 用它把"路由文件变了但口上 ERB 没变"的失效也兜住。同内容重建 ⇒ 同摘要（可跨开项目复用）。
   */
  readonly routeDigest?: string;
}

/**
 * 加载口上调用协议（读路由文件逐行解析）。
 * 文件不存在 / 读取失败 → 返回 undefined（协议不可用，优雅降级——UI 隐藏场景参数区）。
 */
export async function loadEratwCallProtocol(opts: LoadCallProtocolOptions): Promise<EratwCallProtocol | undefined> {
  let text: string;
  try {
    text = (await opts.io.readText(opts.routeFile)).text;
  } catch (err) {
    opts.log.warn(`Call protocol route file unreadable: ${opts.routeFile} — ${String(err)}`);
    return undefined;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rules: FamilyRule[] = [];
  for (const raw of text.split(/\r\n|\n/)) {
    const line = raw.trim();
    if (line.startsWith(';')) continue; // 注释（含协议说明块）
    const m = ROUTE_LINE_RE.exec(line);
    if (!m) continue;
    const template = m[1]!;
    // 家族名：M_KOJO + 插值段之后的第一个 `_段_`（模板字面锚，如 SPEVENT / EVENT）
    const afterFirstInterp = template.replace(/^M_KOJO%[^%]*%/, '');
    const fam = /^_([A-Z0-9_]+?)_K/.exec(afterFirstInterp)?.[1];
    if (!fam) continue; // 模板形态不符合家族约定 → 跳过
    const slots = parseArgsToSlots(m[2] ?? '');
    const { regex, numericTail, literalLen } = templateToRegex(template);
    const rule: FamilyRule = { family: fam, regex, slots, numericTail, literalLen };
    const existing = rules.find((r) => r.regex.source === rule.regex.source);
    if (existing) {
      // 同模板多行 → 取槽位更多的一张（覆盖最全场景）
      if (rule.slots.length > existing.slots.length) existing.slots = rule.slots;
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
   * （回放面板一次要对上千个函数名各调一次），`maxForwardedSlotsFor` 每次重数一遍每条模板的槽。
   * 协议对象随 `loadProject` 重建 ⇒ 预计算天然随项目失效。
   *
   * 曾在此再加一层"名字 → 结果"的 memo，**实测没有收益**就退了：校验规则一轮里每个名字只访问一次，
   * memo 只在"同进程重复跑校验"时才有用，而那条路径的成本在别处（见 IMPLEMENTATION-LOG §5.74）。
   */
  const sortedBySpecificity: readonly FamilyRule[] = [...rules].sort(
    (a, b) => b.literalLen - a.literalLen || Number(b.numericTail) - Number(a.numericTail),
  );
  const ruleSlots = rules.map((r) => {
    let int = 0;
    let str = 0;
    for (const slot of r.slots) {
      if (slot.kind === 'int') int++;
      else str++;
    }
    return { rule: r, int, str };
  });

  /** 匹配优先级：①**字面最长**（最具体）优先——消解 `_EVENT_K…` 与
   *  `_DAILY_EVENT_K…` / `_EVENT_K…_26_1` 等互相包含的歧义；②同字面长时
   *  **数值时机模板优先**（尾部 \d+）——数值函数名不应被字符串时机模板
   *  （尾部 .+）抢先匹配。 */
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
     * 路由转发来源为 `ARG:2` 的槽 = 回放角色号（`{NO:TARGET}` ≡ `ARG:2`：路由层
     * `TARGET = ARG:2`，`KOJO_MESSAGE_SEND` 头注释「ARG:2 = 発言者」）；
     * 其余转发槽（`ARG:3`/`ARG:4`/…）是场景输入、无路由匹配者协议不认识 ⇒ 不填。
     * 全无确定事实 → `undefined`（调用方保持 unknown('call-context')，**不猜**）。
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
