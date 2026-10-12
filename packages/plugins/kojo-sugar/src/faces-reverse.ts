/**
 * 时机函数名的**反向匹配**（批 I）：函数名 → 糖的「时机 …：」标签。
 *
 * ## 为什么这件事可以放在通用插件里做
 *
 * 输入的模板表来自 adapter（`KojoFaceTable`，游戏知识只住 adapter），本模块做的只是
 * **模板字符串的正负双向算术**——`M_KOJO{t}_MESSAGE_COM_K{n}_{310}` 这种形态里
 * 没有任何 eraTW 专有事实需要我写死，正如 `PRONOUN_REVERSE` 由 `PRONOUN_MAP` 派生
 * 而不是手写第二张表（§5.49 纪律）。表缺席（别的适配器没声明 `faces`）时本模块
 * 什么都不产出：**fail-closed，绝不猜**。
 *
 * ## 判据（全部可证明，任何一条不满足 → `undefined` = 该头留原代码）
 *
 * 1. 候选只取 `faces`（登记 / 配色 / 开关三件套的 `registration` 模板**不参与**：
 *    它们不是"时机入口"，标成 `时机 …` 会误导读者以为能那样写）；
 * 2. **整串**匹配（锚定首尾，不做前缀匹配）；家族段 `{t}` 只允许"空"或 `_名字`；
 * 3. 命中多个模板时按**最具体者优先**：固定字面量（模板去掉占位符后的长度）最长的一组胜出
 *    ——实测歧义的绝大多数是这个形状：`_EVENT_K{n}_{i}`（事件）会吞掉
 *    `_EVENT_K{n}_ONABARE_{i}`（撞见）等更长的特化模板；
 * 4. 胜出组内**模板文本必须完全相同**，否则视为真歧义 → 不标
 *    （例：`指令·成否` 与 `成功·主` 是同一个 `SUCCESS_…` 函数的两个名字，模板文本不同，
 *    但"主模板"优先于"成否子模板"是规范 §3.2 明文（`时机 成功：`），故先按 kind 定序
 *    再比模板；仍不平即放弃）。
 *
 * ## 标签文本（规范 §3.2 `时机 <分野> [编号] [命名参数]：`）
 *
 * **产出的就是作者能写下的那一行**（糖视图的第一原则：看见的即写得出的）。故段取值
 * 不作位置段插在分野后面，而是按 §3.2 的**命名参数**写法收尾：
 *
 * `时机 <分野> [编号][ <命名参数>: <取值>][ 成否]< （X版）>：`
 *
 * - `类型:` 取值为 adapter 声明的**第一个候选**（= 规范"默认 `COM`"，codegen 同一口径）
 *   时**整个子句省略**：`M_KOJO_MESSAGE_COM_K1_310` → `时机 指令 310：`。把 `COM` 抄进
 *   标签等于把内部记号塞给读者，还让这一行变成作者写不出的形态。
 * - 非默认取值按 §3.2 原文写：`时机 指令 310 类型: SCOM：` / `… 类型: 自定指令：`
 *   （键名来自 `segments` 声明的键，`CUSTOM_COM` → `自定指令`）。
 * - 编号 `{i}` 等**位置捕获段保留**（`撞见 3`、`射精 1`）；解不出的段取值一律不标。
 * - **角色号 `{n}` 不进标签**（规范 §3.2：角色由文件头 `角色:` 声明，块头只有分野与编号；
 *  抄进来会得到 `时机 事件 1 2：` 这种分不清哪个是时机的标签）；
 * - 命中 `success` 子模板时补 ` 成否`（该函数在糖层由 `成否:` 子句生成，无独立写法）；
 * - 家族段非空（别人版 `_少女之梦`）时补 `（少女之梦版）`：署名/双真相源是本项目
 *  的一等公民，"这是谁改的版本"必须在读者视野里——它对应文件头 `口上:`，出现在每一段
 *  的开头是**读数时不需要回头翻头**。
 */

import type { KojoFaceTable } from '@kojo/plugin-api';
import { segmentParamName } from './codegen';

/** 编译后的候选（一条模板 = 一个候选） */
interface FaceMatcher {
  readonly face: string;
  readonly kind: '主' | '成否';
  readonly re: RegExp;
  /** 占位符在模板里出现的顺序（`t` 除外） */
  readonly slots: string[];
  /** `slots` 里哪些是 `${段名}` 上下文段（其余按位置段渲染） */
  readonly segNames: ReadonlySet<string>;
  /** 模板去掉占位符后的固定字面量长度（"具体度"） */
  readonly literalLen: number;
  /** 模板原文（胜出组一致性比较用） */
  readonly template: string;
  /** 该模板的段声明（渲染时把取值换回作者看得懂的那个键名，如 `CUSTOM_COM` → `自定指令`） */
  readonly segments?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** 家族段：空（标准版）或 `_名字`（别人版；名字可含中文/日文/数字，也可能带括号） */
const FAMILY_SEG = '((?:_[^（）()]*?(?:（[^）]*）)?)?)';

/** 反向索引（一次编译，供整个文件复用） */
export interface FaceNameIndex {
  /** 函数名 → 糖标签；解不出 / 有歧义 → `undefined`（绝不猜） */
  label(functionName: string): string | undefined;
  /** 候选数（诊断与测试用） */
  readonly size: number;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 单个模板 → 锚定正则 + 槽位顺序（段候选来自 adapter 的 `segments` 声明） */
function compile(
  face: string,
  kind: '主' | '成否',
  template: string,
  segments?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FaceMatcher | null {
  const slots: string[] = [];
  const segNames = new Set<string>();
  let src = '';
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith('{t}', i)) {
      slots.push('t');
      i += 2;
      src += FAMILY_SEG;
      continue;
    }
    if (template.startsWith('{n}', i)) {
      slots.push('n');
      i += 2;
      src += '(\\d{1,4})';
      continue;
    }
    if (template.startsWith('{i}', i)) {
      slots.push('i');
      i += 2;
      src += '([0-9A-Za-z_\\u4e00-\\u9fff]+)';
      continue;
    }
    const dollar = template.indexOf('${', i);
    if (dollar === i) {
      const end = template.indexOf('}', i);
      if (end < 0) return null;
      const segName = template.slice(i + 2, end);
      const table = segments?.[segName];
      slots.push(segName);
      segNames.add(segName);
      if (table) {
        // **只认 adapter 声明过的段取值**（长值优先，避免 `COM` 抢走 `CUSTOM_COM`）。
        // 为什么不用宽松字符类：真实语料里 `M_KOJO_…_MESSAGE_MESSAGECHECK_COM_K1_310`
        // 与 `…_MESSAGE_PALAMCNG_A_K1_3` 会被"任意大写字母串"吞成 `指令` 的 `类型` 段，
        // 于是给读者一个**看着像糖、其实是错的分野判定**——比不标危险得多。
        const values = Object.entries(table).sort((a, b) => b[1].length - a[1].length);
        src += `(${values.map(([, v]) => escapeRe(v)).join('|')})`;
      } else {
        src += '([A-Za-z0-9_\\u4e00-\\u9fff]+)';
      }
      i = end;
      continue;
    }
    src += escapeRe(template[i]!);
  }
  return {
    face,
    kind,
    re: new RegExp(`^${src}$`),
    slots,
    segNames,
    literalLen: template.replace(/\{[tni]\}|\$\{[^}]*\}/g, '').length,
    template,
    segments,
  };
}

/** 编译整张分野表（表缺席 / 无 `faces` → 空索引，什么都不标） */
export function buildFaceNameIndex(table: KojoFaceTable | undefined): FaceNameIndex {
  const matchers: FaceMatcher[] = [];
  for (const [face, tpl] of Object.entries(table?.faces ?? {})) {
    const main = compile(face, '主', tpl.template, tpl.segments);
    if (main) matchers.push(main);
    if (tpl.success) {
      const sub = compile(face, '成否', tpl.success.template, tpl.segments);
      if (sub) matchers.push(sub);
    }
  }
  // 具体度降序：第一个胜出候选即"最具体"（稳定排序，模板顺序仅在同分时决定优先级）
  matchers.sort((a, b) => b.literalLen - a.literalLen);

  const cache = new Map<string, string | undefined>();

  const label = (functionName: string): string | undefined => {
    if (cache.has(functionName)) return cache.get(functionName);
    const hit = computeLabel(matchers, functionName);
    cache.set(functionName, hit);
    return hit;
  };

  return { label, size: matchers.length };
}

/** 去掉 `（ARG,ARG:1）` 之类的参数段（糖表层不手写函数参数，规范 §3.2） */
export function stripParams(head: string): string {
  const i = head.indexOf('(');
  return (i < 0 ? head : head.slice(0, i)).trim();
}

function computeLabel(matchers: readonly FaceMatcher[], name: string): string | undefined {
  const hits: Array<{ m: FaceMatcher; caps: string[] }> = [];
  for (const m of matchers) {
    const r = m.re.exec(name);
    if (r) hits.push({ m, caps: r.slice(1) });
  }
  if (hits.length === 0) return undefined;

  const best = hits[0]!;
  const sameSpec = hits.filter((h) => h.m.literalLen === best.m.literalLen);
  // 规范 §3.2：`时机 成功：` 是主模板写法，优先于"某分野的成否子模板"这一叫法
  const mains = sameSpec.filter((h) => h.m.kind === '主');
  const chosen = mains.length > 0 ? mains : sameSpec;
  const first = chosen[0]!;
  if (!chosen.every((h) => h.m.template === first.m.template)) return undefined; // 真歧义 → 放弃

  const positional: string[] = [];
  const named: string[] = [];
  let family = '';
  for (let i = 0; i < first.m.slots.length; i++) {
    const slot = first.m.slots[i]!;
    const value = first.caps[i] ?? '';
    if (value.length === 0) continue;
    if (slot === 't') {
      family = value;
      continue;
    }
    // 角色号 `{n}` **不进标签**：规范 §3.2 的块头是 `时机 <分野> [编号]`，角色由文件头
    // `角色:` 声明——把 `K1` 也抄进来会得到 `时机 事件 1 2：` 这种"两个数读不出哪个是时机"的标签。
    if (slot === 'n') continue;
    const declared = first.m.segments?.[slot];
    // 段取值换回**声明时的键名**（`CUSTOM_COM` → `自定指令`）：作者认的是中文键，
    // 而且这正好暴露"这个头是自定义指令面"这一事实。找不到键就用取值本身。
    const key = declared ? (Object.keys(declared).find((k) => declared[k] === value) ?? value) : value;
    if (first.m.segNames.has(slot)) {
      // 上下文段 = 规范 §3.2 的**命名参数**（`com` ← `类型:`，与 codegen 同一函数）。
      // **默认取值 = adapter 声明的第一个键**（codegen 的缺省段规则同源，规范 §3.2
      // "`类型:` COM（默认）"）→ 默认值整个子句省略，于是 `…_MESSAGE_COM_K1_310` 得到
      // `时机 指令 310：` 这一行**作者真能写出来**的糖。
      const paramName = segmentParamName(slot);
      // 语法层没登记这个段的命名参数名 → **整头不标**：静默丢掉一个分支事实，会得到
      // "看着是糖、其实把副指令读成了主指令"的标签——错标比不标危险（本模块第一判据）。
      if (paramName === undefined) return undefined;
      // adapter 声明了 `${段}` 却没给候选表 = 我们既不知道默认值、也只能用宽松字符类去猜
      // 取值 → 同样整头不标（宽松类正是上一轮把 `MESSAGECHECK_COM` 读成"指令"的根因）。
      if (declared === undefined) return undefined;
      const defaultKey = Object.keys(declared)[0]!;
      if (key !== defaultKey) named.push(`${paramName}: ${key}`);
      continue;
    }
    positional.push(key);
  }
  const fork = family.length > 0 ? `（${family.replace(/^_/, '')}版）` : '';
  const tail = [...positional, ...named];
  if (first.m.kind === '成否') tail.push('成否');
  return `时机 ${first.m.face}${tail.length ? ` ${tail.join(' ')}` : ''}${fork}：`;
}
