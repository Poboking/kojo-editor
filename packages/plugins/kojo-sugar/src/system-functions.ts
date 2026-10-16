/**
 * 系统函数中文别名（HK-11①）——**单一真源**。
 *
 * 作者在条件/正文里可能写到的系统函数（`GETBIT` / `FIRSTTIME` / `CHK_*` /
 * `RAND` / 引擎算术族 …，HANDOFF §13.4 HK-11 与附录 A）给出中文糖形；本表是
 * 唯一的一份——**降糖器与 Monaco 高亮/补全都从这里派生**，绝不各写一份。
 *
 * 三条纪律：
 * 1. **只收系统函数**：不含作者自定义函数（规范 §7.2 已排除"用户自定义扩展函数"）；
 * 2. **纯函数、无副作用、可扩展**：本模块只依赖叶子表 `identifier-chars`（标识符
 *    字符集单一真源；**不**依赖 `expression.ts`，避免循环 import），新增别名只改这一处；
 * 3. **fail-visible**：未收录的中文名**原样保留**（不静默改写）。
 */

import type { KojoLibraryTable } from '@kojo/plugin-api';
import { isIdentPart, isIdentStart } from './identifier-chars';

/**
 * 入库判据（HK-11① 扩容批）：
 * - **引擎内建**：Emuera 引擎自带、在游戏侧无 `@` 定义（语料实证：STRLENS/STRCOUNT/
 *   STRFIND/SUBSTRING/UNICODE/ENCODETOUNI/TOSTR/TOINT/CHKFONT/REPLACE/GETNUM/SUMARRAY/
 *   MATCH/FINDELEMENT/INRANGE/INRANGEARRAY/TOHALF/TOFULL/GETCHARA/SQRT…）；
 * - **eraTW 系统检查族 `CHK_*`**（HANDOFF §13.4 HK-11 点名）：定义在游戏基础库
 *   （如 `COMMON2.ERB` / `OGAMITAOSHI.ERB` / `BIRTH.ERB`），与项目内自定义 `@函数` 有别。
 * **不在本表**：依任务口径与规范 §7.2 排除的"游戏助手长尾 / 项目内自定义 `@函数`"
 * （`TEXTR` / `COLORMESSAGE` / `MAKE_INT` / `MAKE_STR` / `HE_SHE_CN` / `HPH_PRINT`
 * 等基础库助手与 K* 私有函数）。
 *
 * ## ZH-F1：基础库 / 常用函数名（住 adapter，不进本表）
 *
 * 上表是**跨游戏语言层**的系统函数；游戏**基础库**里的助手 / 宏（`HPH_PRINT` /
 * `TEXTR` / `ASK_YN` …）不属语言层，住 adapter 的 `KojoLibraryTable`（经
 * `game.adapter` 槽位按 `adapterId` 注入）。本模块的扫描**先查系统表、再查 adapter
 * 表**（系统表优先）；两表都不认的**中文函数名调用形态**原样保留，由 `expression.ts` 分级
 * 报诊断（ZH-D1）：表内有**唯一**高置信近名 ⇒ `function-name-typo`（**error**，fail-closed
 * 拒绝产字节）；纯未知 ⇒ `function-name-unknown`（**warning**，fail-visible，不猜、不纠）。
 * 分级判据与语料读数见 `suggestFunctionName`。
 */

/** 中文名 → 原生 ERB 函数名（单一真源） */
export const SYSTEM_FUNCTION_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  // 位运算族（引擎内置）
  ['获取标记', 'GETBIT'],
  ['设置标记', 'SETBIT'],
  ['清除标记', 'CLEARBIT'],
  ['反转标记', 'INVERTBIT'],
  // 算术 / 比对族（`state-replay` 的引擎内置纯函数子集）
  ['分组匹配', 'GROUPMATCH'],
  ['最大值', 'MAX'],
  ['最小值', 'MIN'],
  ['绝对值', 'ABS'],
  ['符号', 'SIGN'],
  ['限幅', 'LIMIT'],
  ['乘方', 'POWER'],
  ['平方根', 'SQRT'],
  // 随机族
  ['随机', 'RAND'],
  ['随机化', 'RANDOMIZE'],
  // 时间族
  ['当前时间', 'GETTIME'],
  ['毫秒', 'GETMILLISECOND'],
  // 字符串族（引擎内置）
  ['字符串长度', 'STRLENS'],
  ['出现次数', 'STRCOUNT'],
  ['查找位置', 'STRFIND'],
  ['取子串', 'SUBSTRING'],
  ['替换', 'REPLACE'],
  ['取码点', 'UNICODE'],
  ['编码取字', 'ENCODETOUNI'],
  ['转字符串', 'TOSTR'],
  ['转数值', 'TOINT'],
  ['转半角', 'TOHALF'],
  ['转全角', 'TOFULL'],
  ['检查字体', 'CHKFONT'],
  // 数组 / CSV 常量族（引擎内置）
  ['取常量', 'GETNUM'],
  ['数组求和', 'SUMARRAY'],
  ['数组计数', 'MATCH'],
  ['数组查找', 'FINDELEMENT'],
  ['区间判定', 'INRANGE'],
  ['区间计数', 'INRANGEARRAY'],
  ['取角色号', 'GETCHARA'],
  // 系统 / 游戏助手（HANDOFF §13.4 HK-11 点名）
  ['首次', 'FIRSTTIME'],
  // eraTW 系统检查族 `CHK_*`
  ['检查约会中', 'CHK_DATENOW'],
  ['检查焦点', 'CHK_FOCUS'],
  ['检查入口', 'CHK_ENTRANCE'],
  ['检查有孩子', 'CHK_HAVE_CHILD'],
  ['检查子名重复', 'CHK_CHILDNAME_DUPLICATION'],
  ['检查避妊恋爱', 'CHK_HININ_LOVE'],
  ['检查避妊恋爱二', 'CHK_HININ_LOVE_2'],
  ['检查避妊理由', 'CHK_HININ_REASON'],
  ['检查避妊理由二', 'CHK_HININ_REASON_2'],

  // ================== ZH-2① 扩容批（引擎内建长尾，2026-10-16） ==================
  // 入库判据逐条自查：以下名字在语料 `ERB/**` 全树（4,385 份 `.ERB`/`.ERM`）**无任何 `@` 定义**
  // ⇒ 只可能由引擎提供，属跨游戏语言层；括号内为该口径普查的语料调用点次数
  // （复跑见 `eratw-adapter/tests/library-coverage.corpus.test.ts`）。
  // 字符串族补齐（与 `转半角` / `转全角` / `转数值` 同一命名式）
  ['转小写', 'TOLOWER'], // 引擎字符串大小写转换 (6)
  ['转大写', 'TOUPPER'], // 同上（基础库 `@COLOR` 即用它做色彩名归一）(1)
  ['数值判定', 'ISNUMERIC'], // 引擎"字符串是否为数值"谓词 (1)
  // 数组 / 维度族补齐（与 `数组求和` / `数组计数` / `数组查找` 同族）
  ['数组大小', 'VARSIZE'], // 引擎 `#DIM` 变量的元素数（基础库 `VARSIZE("COLUMN_NAME", 1)` 遍历用）(18)
  ['数组最大值', 'MAXARRAY'], // 引擎数组归约（与 `最大值`/MAX 同族）(3)
  // 算术族补齐
  ['立方根', 'CBRT'], // 引擎算术函数（与 `平方根`/SQRT 同族）(1)
  // 显示属性查询族（引擎侧当前绘制状态；与 `检查字体`/CHKFONT 同层）
  ['取当前颜色', 'GETCOLOR'], // 引擎当前文字色（基础库 `LOCAL:9 = GETCOLOR()` 存色复归用）(67)
  ['取背景色', 'GETBGCOLOR'], // 引擎当前背景色 (11)
  ['取默认色', 'GETDEFCOLOR'], // 引擎默认文字色 (8)
  ['取当前字体', 'GETFONT'], // 引擎当前字体名（`检查字体` 的同伴）(15)
]);

/**
 * 原生 ERB 函数名 → 中文名（**反向派生**自 `SYSTEM_FUNCTION_ALIASES`；正反对称是构造
 * 事实，单一真源、绝不手抄第二张表——与 `PRONOUN_REVERSE` 同一条纪律）。同名多中文取
 * **首条**。显示侧（ZH-F2：投影反糖 / 宿主 hover）用它；查不到一律 `undefined`（不猜）。
 */
export const SYSTEM_FUNCTION_REVERSE: ReadonlyMap<string, string> = (() => {
  const reverse = new Map<string, string>();
  for (const [cn, erb] of SYSTEM_FUNCTION_ALIASES) {
    if (!reverse.has(erb)) reverse.set(erb, cn);
  }
  return reverse;
})();

/** ERB 字符串字面量 `"…"`（无转义概念）的结束下标；返回**闭合引号之后**的位置 */
function stringEnd(text: string, from: number): number {
  let j = from + 1;
  while (j < text.length && text[j] !== '"') j++;
  return Math.min(j + 1, text.length);
}

/**
 * 查一个中文函数名对应的 ERB 函数名：**系统函数表优先，再查 adapter 基础库表**。
 * 两表皆无 → `undefined`（**绝不猜**，规范 §5.3）。
 */
export function lookupFunctionName(name: string, libraryTable?: KojoLibraryTable): string | undefined {
  const system = SYSTEM_FUNCTION_ALIASES.get(name);
  if (system !== undefined) return system;
  return libraryTable?.lookupByName(name);
}

/** 该中文名是否被任一函数表收录（`expression.ts` 据它决定是否报 `function-name-unknown`） */
export function isKnownFunctionName(name: string, libraryTable?: KojoLibraryTable): boolean {
  return lookupFunctionName(name, libraryTable) !== undefined;
}

/* ==================== ZH-D1 · 表外名的**分级**判据（拼错不再静默进产物） ==================== */

/** 升 error 档的近名判据阈值（**测试逐条钉住这三个数**：改数=改判据，必须连同语料读数一起复核） */
export const TYPO_EDIT_DISTANCE = 1;
export const TYPO_MIN_NAME_LEN = 3;
export const TYPO_MAX_TAIL_LEN = 2;

/** 表外名查到的唯一近名：中文名 + 其原生 ERB 名（文案要给"唯一那一个改法"） */
export interface FunctionNameCandidate {
  readonly name: string;
  readonly engineName: string;
}

/**
 * **为什么这么分**（数据口径，不是口味）：只读普查真语料 `個人口上` 2,285 份 `.ERB`
 * （复跑口径 = `tests/unknown-name-tier.corpus.test.ts`，与 `lowerSystemFunctions` 同一个扫描
 * 语义；eraTW 4.980 画蛇添足版 2026-10-16 实测）——中文函数名**调用形态**共 1,396 处，
 * 补名表前**全部**落在两张表外（324 个不同名 / 263 个文件），按基础库收录判据补 13 条恒等条目后
 * 仍有 **526 处 / 311 个名 / 158 个文件**在表外：表外名里绝大多数是基础库与项目自定义 `@函数`
 * 直接用中文/日文写就的合法名（`SHOW_上半身内衣` 11 · `画像一斉表示` 12 · `WITH_恋人` 8…）。
 * ⇒ 把 `function-name-unknown` 一刀切升 error = 全语料新增 **526~1,396** 条 error、
 * 158~263 个文件（6.9%~11.5%）一打开就红到编译不动 ⇒ 产品坏掉。
 * ⇒ 只升"表外名**且**表内有**唯一**高置信近名"这一档：同一张盘新增 error 恰 **0** 处
 * （真实语料是能跑通的代码，里面没有拼错名 ⇒ 0 是**零误伤**的证据，不是零抓力；抓力由
 * `tests/unknown-name-tier.test.ts` 的合成拼错名钉）。两条"判据一放宽就冒误伤"的实测：
 * 短名（两字）也当近邻 ⇒ 10 处（`随意`↔`随机`、`随便`↔`随机`、`参数`↔`参数消息甲`）；
 * 恒等条目也当候选 ⇒ 13 处（`SHOW_上半身内衣`↔`SHOW_下半身内衣` 等双生真函数）。
 * ⇒ 于是判据带两条限制：**两侧都 ≥ 3 字** + **候选只取别名条目**。
 *
 * 两条近名形状（阈值见上面三个常量）：
 * 1. **单字之差**：编辑距离恰为 `TYPO_EDIT_DISTANCE`，且两侧名字都 ≥ `TYPO_MIN_NAME_LEN` 字；
 * 2. **写短了**：表内名以作者写的名字开头，作者名 ≥ `TYPO_MIN_NAME_LEN` 字、缺的尾巴
 *    ≤ `TYPO_MAX_TAIL_LEN` 字（`彩虹打印` → `彩虹打印行`）。**反方向不单独认**：作者名更长
 *    只多出 1 字时由形状 1 接住（同属"单字之差"），多出 ≥ 2 字视为**另一个**自定义函数。
 *
 * 候选池还有一条**形状限制**：只有**别名条目**（`中文名 ≠ 原生名`）当候选。表里的**恒等条目**
 * （基础库里函数名本身就是中文/日文，见 `eratw-adapter/src/library-table.ts` 的 ZH-D1 收录批）
 * 的近邻**更可能是另一个真实函数**——语料实测成对存在的"一字之差双生函数"就有
 * `脱衣处理`↔`脱衣処理`、`挿入不可`↔`插入不可`、`SHOW_下半身内衣`↔`SHOW_上半身内衣`、
 * `金額表示`↔`金额表示`、`SOURCE_快Ｍ`↔`SOURCE_快Ｖ`，把它们判成拼错会直接打死能跑通的口上；
 * 而**别名**的近邻只可能是"作者想写某个中文糖形但写错了"，正是本批要抓的形态。
 *
 * 近名 ≥ 2 个 ⇒ **不升档**（歧义不猜，与 `bit-name-unknown` 同一口径）；查不到候选 ⇒ 纯未知，
 * 维持 `function-name-unknown` warning（行上波浪线可见，一键动作见跨文件请求）。
 *
 * 候选池来自 `KojoLibraryTable.names?.()`（**可选**枚举能力）：本文件声明了 `函数` 块时
 * codegen 会换成 per-file 合并表，那张表**同样必须**透传 `names()`（见
 * `codegen.ts::mergeUserFunctionLibrary` 的注），否则"拼错名"的升档会在那些文件里静默失效。
 */
export function suggestFunctionName(
  name: string,
  libraryTable?: KojoLibraryTable,
): FunctionNameCandidate | undefined {
  if (name.length < TYPO_MIN_NAME_LEN) return undefined;
  const hits: string[] = [];
  for (const key of candidatePool(libraryTable)) {
    if (key === name) continue;
    if (!isNearTypoName(name, key)) continue;
    hits.push(key);
    if (hits.length > 1) return undefined; // 歧义 ⇒ 不猜、不升档
  }
  if (hits.length === 0) return undefined;
  const only = hits[0]!;
  const engineName = lookupFunctionName(only, libraryTable);
  return engineName === undefined ? undefined : { name: only, engineName };
}

/** 候选池 = 系统函数表键 + adapter 基础库表键（系统表优先，重名不重复计） */
function candidatePool(libraryTable?: KojoLibraryTable): readonly string[] {
  const pool: string[] = [...SYSTEM_FUNCTION_ALIASES.keys()];
  const seen = new Set(pool);
  for (const key of libraryTable?.names?.() ?? []) if (!seen.has(key)) pool.push(key);
  // **只有别名条目当候选**（`中文名 ≠ 原生名`）；恒等条目（盘上函数名本身就是中文/日文）剔除
  // ——判据与理由见 `suggestFunctionName` 头注的形状限制。
  return pool.filter((key) => {
    const native = SYSTEM_FUNCTION_ALIASES.get(key) ?? libraryTable?.lookupByName(key);
    return native !== undefined && native !== key;
  });
}

/** 唯一近名判据本体（两条形状见 `suggestFunctionName` 头注；不认第三条形） */
function isNearTypoName(written: string, listed: string): boolean {
  if (listed.startsWith(written)) return listed.length - written.length <= TYPO_MAX_TAIL_LEN;
  if (Math.min(written.length, listed.length) < TYPO_MIN_NAME_LEN) return false;
  return editDistance(written, listed) === TYPO_EDIT_DISTANCE;
}

/** 码点级 Levenshtein（短名专用；先按长度差剪枝，超过 1 即可提前收工） */
function editDistance(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  if (Math.abs(A.length - B.length) > TYPO_EDIT_DISTANCE) return TYPO_EDIT_DISTANCE + 1;
  let prev = Array.from({ length: A.length + 1 }, (_, i) => i);
  for (let j = 1; j <= B.length; j++) {
    const cur = [j];
    for (let i = 1; i <= A.length; i++) {
      cur[i] = Math.min(prev[i]! + 1, cur[i - 1]! + 1, prev[i - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[A.length]!;
}


/**
 * 把表达式文本里的**调用形态**中文函数名替换为 ERB 函数名。
 *
 * 只对「中文名（可含空白）后随 `(`」生效——裸词（台词 / 属性词 / 别名）一律不动，
 * 故不会误伤同为中文名的普通文本。字符串字面量内部不改写；未收录的中文名原样保留
 * （fail-visible）。
 *
 * 扫描口径：以**最大标识符**为词元（`identifier-chars` 的起点集 + 后续集），整词查表
 * ——`随机化` 与 `随机` 各按**精确名**命中，"最长优先"由"整词"天然保证（不再需要长度
 * 降序表）。词元起点须**不粘在前一个标识符字符上**，与旧口径逐字等价。
 */
export function lowerSystemFunctions(text: string, libraryTable?: KojoLibraryTable): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    // 词元起点：标识符起始字符，且前一个字符不得是标识符字符（不从长中文串中截取子串）
    if (!isIdentStart(ch) || (i > 0 && isIdentPart(text[i - 1]!))) {
      out += ch;
      i++;
      continue;
    }
    // 扫**最大标识符**（整词精确查表）
    let e = i + 1;
    while (e < text.length && isIdentPart(text[e]!)) e++;
    const name = text.slice(i, e);
    // 名字与 `(` 之间允许空白（引擎侧 `GETBIT (…)` 亦合法），只换名字本身
    let j = e;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] === '(') {
      const erb = lookupFunctionName(name, libraryTable);
      if (erb !== undefined) {
        out += erb + text.slice(e, j);
        i = j;
        continue;
      }
    }
    out += name;
    i = e;
  }
  return out;
}
