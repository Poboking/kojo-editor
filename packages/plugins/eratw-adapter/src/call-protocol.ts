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

import type { FileIO, KojoCallProtocol, KojoCallSlot, Logger } from '@kojo/plugin-api';

/** 路由行：(?:TRY)?CALLFORM <模板>(<实参表>)；括号可省（无实参转发） */
const ROUTE_LINE_RE = /\b(?:TRY)?CALLFORM\s+(M_KOJO[^\s(]+)\s*(?:\(([^)]*)\))?/;

/** 单个转发实参 token：ARG:n（数值）或 ARGS:n（字符串） */
const ARG_TOKEN_RE = /^(ARG|ARGS)(?::(\d+))?$/;

/** 家族模板 → 函数名匹配正则：%…% 与 {…} 为通配段，其余字面。
 *  **尾部段类型区分**（数值/字符串时机的函数名判定）：尾部 {…}（数值表达式
 *  如 {ARG:1}）→ `\d+`；尾部 %…%（字符串时机 %ARGS:1%）→ `.+`。中段一律 `.+`。 */
function templateToRegex(template: string): { regex: RegExp; numericTail: boolean } {
  let pattern = '^';
  let numericTail = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c === '%') {
      const close = template.indexOf('%', i + 1);
      const isTail = close === template.length - 1;
      pattern += isTail ? '.+' : '.+'; // 插值段（尾部 = 字符串时机：任意文本）
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
    }
  }
  return { regex: new RegExp(pattern + '$'), numericTail };
}

interface FamilyRule {
  family: string;
  regex: RegExp;
  slots: KojoCallSlot[];
  /** 尾部段是数值时机（{ARG:1} → \d+）——匹配优先级高于字符串时机 */
  numericTail: boolean;
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
 * 加载口上调用协议（读路由文件逐行解析）。
 * 文件不存在 / 读取失败 → 返回 undefined（协议不可用，优雅降级——UI 隐藏场景参数区）。
 */
export async function loadEratwCallProtocol(opts: LoadCallProtocolOptions): Promise<KojoCallProtocol | undefined> {
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
    const { regex, numericTail } = templateToRegex(template);
    const rule: FamilyRule = { family: fam, regex, slots, numericTail };
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

  return {
    slotsFor(functionName: string): readonly KojoCallSlot[] | null {
      const name = functionName.toUpperCase();
      // 数值时机模板（尾部 \d+）优先：数值函数名不应被字符串时机模板（尾部 .+）
      // 抢先匹配（两者都可能同配，数值版的槽位语义才是该函数的真实转发结构）。
      const sorted = [...rules].sort((a, b) => Number(b.numericTail) - Number(a.numericTail));
      for (const r of sorted) {
        if (r.regex.test(name)) return r.slots;
      }
      return null;
    },
  };
}
