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
 * `时机 <分野> [编号][ <命名参数>: <取值>][ 成否]：`
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
 *  家族段（别人版）**不进标签**（E13-1）：全角括号会把编号段变成"中文指令名"，
 *  转译器查不到 ⇒ 照抄回写必报错。署名/双真相源仍是一等公民，改由 `family()` 出口
 *  交给投影在**文件头**发一行 `口上: <家族名>`——那才是作者真能写下的声明。
 */

import type { KojoFaceTable } from '@kojo/plugin-api';
import { segmentParamName } from './codegen';
import { NAME_TOKEN_CHARS } from './lexer';

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
  /**
   * 函数名 → **家族名**（`口上:` 的取值；标准版 = `undefined`）。
   *
   * E13-1：家族 fork 不再塞进块头（`时机 指令 88（TOKI版）：` 里的全角括号会把
   * 编号段变成"中文指令名"，转译器查不到 ⇒ 作者照抄回写必报错），改由投影在
   * **文件头**发一行 `口上: <家族名>` —— 那才是可写形的真实声明。故标签与家族
   * 分两个出口，同源于一次匹配（不会互相漂移）。
   */
  family(functionName: string): string | undefined;
  /**
   * 函数名 → **选择器编号**（`口上: … 选择器: <n>` 的取值；非「选择器」登记函数 = `undefined`）。
   *
   * E13-1 同源问题：别人版的选择器（`_1`）记在**登记函数**上
   * （`@M_KOJO_K58_1(ARG)`），而家族名记在**带 `{t}` 的时机函数**上——投影把两者
   * 合成文件头一行 `口上: <家族名> 选择器: <n>`。故本出口专门给投影取选择器，
   * 与 `label()`/`family()`（时机入口面）**分属两个识别域**，互不干扰
   * （`registration` 不进 `faces`、不进 `label()`，测试已钉住）。
   */
  selector(functionName: string): number | undefined;
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
      // 字符集与正向 `lexer` 的令牌判定**同源**（`NAME_TOKEN_CHARS`）：尾部可能是
      // 编号（`310`）、中文名（`摸屁股`）或运行期**形态名**（`特殊エフェクト`——含片假名）。
      src += `([${NAME_TOKEN_CHARS}]+)`;
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
        src += `([${NAME_TOKEN_CHARS}]+)`;
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

/**
 * 编译整张分野表（表缺席 / 无 `faces` → 空索引，什么都不标）。
 *
 * PS-8：按 **`faceTable` 对象身份**记忆（WeakMap）——投影每次重建都重编译全表正则
 * （eraTW 实测 ~20 面 × 2 形）。身份记忆成立的前提是**表对象建好后就地不改**：
 * 这是**约定不是机制**——eratw-adapter `createEratwFaceTable()` 当前返回普通字面量
 * （`face-templates.ts:57` 起，**没有 `Object.freeze`**，尽管其文件头自称"冻结"）。
 * 谁将来就地改表，这份 memo 就会拿到旧编译结果——机械化（真 freeze 或在装配处复制）
 * 是 adapter 线的活，本模块只把不变量写在这。B4-fp 的前缀覆盖路径
 * （`service.ts resolveFaceTableForPrefix`）走**浅拷贝新对象** ⇒ 新身份 ⇒ 重编译，
 * 不会拿旧缓存出错表，身份记忆对它天然安全。表缺席（`undefined`）不进记忆。
 * 返回的 `FaceNameIndex` 是纯查询对象（内部 `cache` 只按函数名记忆判定结果），
 * 同一表身份下跨投影共享安全（同表同产出，判定是纯函数）。
 */
const faceIndexByTable = new WeakMap<KojoFaceTable, FaceNameIndex>();

export function buildFaceNameIndex(table: KojoFaceTable | undefined): FaceNameIndex {
  if (table !== undefined) {
    const memo = faceIndexByTable.get(table);
    if (memo !== undefined) return memo;
  }
  const index = compileFaceNameIndex(table);
  if (table !== undefined) faceIndexByTable.set(table, index);
  return index;
}

function compileFaceNameIndex(table: KojoFaceTable | undefined): FaceNameIndex {
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

  // PS-8 读数账（收口批补实）：这张 name→label 缓存按**函数名**只增不减，
  // 生命周期＝表对象生命周期（WeakMap 值随表回收）——eraTW 的表在插件激活时一次构建
  // （`eratw-adapter/src/plugin.ts:492`），跨项目代际**不换身份** ⇒ 换代不释放这份，
  // 这是**上限有界的留存增加**（上界 = 全库函数名总数，真语料读数 99,228，每值一个
  // `{label, family}` 小对象），不是无界泄漏。代际释放由转译实例那层钉
  // （`hotpath-memo.test.ts`「项目关闭（current === null）⇒ 又一代际；重开原项目 ⇒
  // 再换新实例（旧缓存不复活脏数据）」钉转译缓存换代归零；表身份记忆的正反面由
  // `faces-reverse.test.ts`「身份记忆：同表对象同实例、新表对象新索引」钉"新身份 ⇒
  // 新索引 ⇒ 新缓存"）。
  const cache = new Map<string, LabelHit | undefined>();

  const compute = (functionName: string): LabelHit | undefined => {
    if (cache.has(functionName)) return cache.get(functionName);
    const hit = computeLabel(matchers, functionName);
    cache.set(functionName, hit);
    return hit;
  };

  // 选择器登记函数（别人版）——**单独编译、单独出口**：它不是"时机入口"，
  // 不进 `matchers`/`label()`（测试「三件套不参与」钉住了这一点）。
  const declareRe = compileDeclareSelector(table?.registration?.declareSelector?.template);

  return {
    label: (functionName: string) => compute(functionName)?.label,
    family: (functionName: string) => compute(functionName)?.family,
    selector: (functionName: string) => {
      const m = declareRe?.exec(functionName);
      return m ? Number(m[1]) : undefined;
    },
    size: matchers.length,
  };
}

/**
 * 选择器登记函数模板 → 锚定正则（`{n}` = 角色号、`{s}` = 选择器段，捕获前者）。
 *
 * 参数段（`(ARG)`）按 `stripParams` 剥掉——糖表层不手写函数参数，投影匹配用的
 * 是剥参后的函数名（`@M_KOJO_K58_1(ARG)` → `M_KOJO_K58_1`）。
 */
function compileDeclareSelector(template: string | undefined): RegExp | null {
  if (template === undefined) return null;
  const name = stripParams(template);
  let src = '';
  for (let i = 0; i < name.length; i++) {
    if (name.startsWith('{n}', i)) {
      src += '\\d{1,4}';
      i += 2;
      continue;
    }
    if (name.startsWith('{s}', i)) {
      src += '(\\d{1,4})';
      i += 2;
      continue;
    }
    src += escapeRe(name[i]!);
  }
  return new RegExp(`^${src}$`);
}

/** 去掉 `（ARG,ARG:1）` 之类的参数段（糖表层不手写函数参数，规范 §3.2） */
export function stripParams(head: string): string {
  const i = head.indexOf('(');
  return (i < 0 ? head : head.slice(0, i)).trim();
}

/** 一次匹配的产物：可写块头 + 家族名（E13-1 起分两个出口） */
interface LabelHit {
  /** 作者能照抄回写的块头（家族 fork **不进**这一行） */
  label: string;
  /** 家族名（`_TOKI` → `TOKI`；标准版 = `undefined`） */
  family: string | undefined;
}

function computeLabel(matchers: readonly FaceMatcher[], name: string): LabelHit | undefined {
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
    const raw = declared ? (Object.keys(declared).find((k) => declared[k] === value) ?? value) : value;
    // E13-1①：M1 委托桩的 `_1` 尾要剥掉（`…_COM_K49_88_1` → `编号 88`）。
    // 理由：`时机 指令 88：` 正是这两个函数（桩 + 正文）的糖形——包着 `_1` 写出去
    // 只会生成正文那一个函数，桩丢了；而库内 `{i}` 里的 `_1` 就是 M1 的委托后缀
    // （判据见 `faces-reverse.test.ts`「`{i}` 允许带后缀的真实编号」）。**只剥 `_1`**：
    // 别的后缀（`_EXTRA_SUFFIX`）不是委托记号，剥了就是改名。
    const key = slot === 'i' ? stripDelegationSuffix(raw) : raw;
    // `{i}` 恰好就是 `_1`（`…_K1__1`）⇒ 剥完是空的，给不出可写块头 → 整头不标
    if (slot === 'i' && key.length === 0) return undefined;
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
  // E13-1②：家族 fork **不进块头**（全角括号会让编号段被当成中文指令名，转译报错）。
  // 家族信息由 `family()` 出口单独给投影发文件头 `口上: <家族名>`。
  const tail = [...positional, ...named];
  if (first.m.kind === '成否') tail.push('成否');
  return {
    label: `时机 ${first.m.face}${tail.length ? ` ${tail.join(' ')}` : ''}：`,
    family: family.length > 0 ? family.replace(/^_/, '') : undefined,
  };
}

/**
 * 剥 M1 委托桩的后缀（`88_1` → `88`；`600_1` → `600`）。
 * **只剥恰好一个 `_1` 尾**——其余后缀（`_EXTRA_SUFFIX` / `ONABARE`）原样保留。
 */
function stripDelegationSuffix(index: string): string {
  return index.endsWith('_1') ? index.slice(0, -2) : index;
}
