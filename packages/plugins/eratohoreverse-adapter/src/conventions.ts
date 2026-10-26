/**
 * eratohoReverse 口上约定规则集（`GameAdapter.conventions`）——四条规则，**每条都在
 * `C:/game/eratohoReverse` 逐处复验过**（2026-10-26 全量复测，非抽样）。计数一律**排除 `口上テンプレ/`**
 * 那棵干扰模板树（38 份 `KX2` 模板 + 第二棵完整 `ERB/口上` 树，天然落在 `erbRoot` 之外，
 * 见 `constants.ts` 头注）。判据「宁可漏报不可误报」：量出误报的整条不发（见文末留档）。
 *
 * ## 取证尺子（决定所有 `@` 相关计数）
 *
 * 本盘受管 `ERB/` **907 份 `.ERB/.ERH` 100% 带 BOM**、**100% 纯 LF**，而有 **39 份文件的第一行
 * 就是一个 `@` 定义** ⇒ 拿 utf8 原文 `startsWith('@')` 会把这 39 处**静默算成 0**
 * （`docs/PITFALLS.md` 231；本批早先那句「0 个定义」就是这么来的）。规则侧吃的是
 * `ctx.readFile`（内核解码已剥 BOM）与 `ErbIndex` 的函数表，两处都不依赖"我自己 trim 过"。
 *
 * ## 遮蔽段里的定义怎么拿（规则 1 的补扫与规则 3 共用同一条通道）
 *
 * `[SKIPSTART]…[SKIPEND]` 区间**解析器根本不产出定义**（`erb-parser/src/scanner.ts` 的
 * `inSkipBlock` 分支），而 `ErbFile.functions` 是 `ErbFile` 上唯一的定义表 ⇒
 * 拿 `file.functions` 去和遮蔽区间求交**恒为空集**（本文件早先那版就是这么写的，四条里两条因此never fire）。
 * 唯一的真源兼容拿法是**同一条语法两次解析之差**：
 * ① 把每个**严格等值**的标记行（判据与 scanner 同一条：`erbCodeBodyOf(line.trim()) === '[SKIPSTART]' | '[SKIPEND]'`，
 * 标记字面取契约真源 `ERB_SKIP_MARKERS`）就地换成 `;` + 原文（行号一位不移动）；
 * ② 用**索引同一个解析器**（`erb.parser` 服务的 `parseText`，由 `plugin.ts` 在"用到的那一刻"
 * `tryInject` 取，见下）重解析这段文本；
 * ③ 减去传进来的 `file.functions`（按 `normalizedName` + `startLine`）⇒ 余集**就是**被遮蔽的定义。
 * 本包**不写第二套 `@` 语法**（既不开放任正则，也不另立角色号提取），也不 import `@kojo/plugin-erb-parser`
 * （铁律 2：插件只依赖 `@kojo/plugin-api`；`audit:decoupling` C 项会当场拦）⇒ 解析器经服务键注入。
 * 解析器缺席（插件被停用）时这两处**一律抛错**进 `report.failedRules`（铁律 4），
 * 绝不返回空数组冒充"这棵判过了、没问题"。
 * 代价实测：口上域 636 份里 **286 份**含严格标记 ⇒ 只有这 286 份付第二次解析的钱（其余文件在标记闸就返回）。
 *
 * ## 四条规则的真盘命中清单（2026-10-26 逐条复测）
 *
 * 1. `evrse.kojo.ghost-character-no`（**warning**，4 条）——家族函数锚定的角色号**不在角色表里**。
 *    `ERB/口上/0011_フランドール/KOJO_TRAIN_MESSAGE_K11.ERB:1501` 定义 `KOJO_TRAIN_MESSAGE_K112_312`、
 *    `ERB/口上/0014_アリス/KOJO_MESSAGE_K14/KOJO_TRAIN_MESSAGE_K14.ERB:2229` 定义 `KOJO_TRAIN_MESSAGE_K142_312`、
 *    `ERB/口上/0039_雛/オトコ用/KOJO_MESSAGE_K39/KOJO_TRAIN_MESSAGE_K39.ERB:1064` 定义 `KOJO_MALE_TRAIN_MESSAGE_K392_312`、
 *    `ERB/口上/0064_こいし/KOJO_TRAIN_MESSAGE_K64.ERB:954` 定义 `KOJO_TRAIN_MESSAGE_K642_312`。
 *    角色表 `CSV/CHARA` 实测 108 份、号 **0–107** ⇒ 这四个号（112/142/392/642）在游戏里不存在，
 *    引擎按 `KOJO_%ARGS%` 拼出的名字永远召不到；四条的静态引用同为 0（取证时逐名扫过）。
 *    **前三条在索引里、第四条在 `[SKIPSTART]` 段里**（该文件 `:21` 开段、`:956` 收段），
 *    所以本条除了扫 `ctx.index` 还要扫遮蔽段补集——补集走上面那条差集通道，不另立语法。
 *    性别前缀那一族**不是**解析缺口（实测 `parseKojoFamily('KOJO_MALE_TRAIN_MESSAGE_K392_312')`
 *    = `kind:'ok' / family:'MALE' / face:'TRAIN_MESSAGE' / characterNo:392`），别照"家族段"的猜想去改 `family-index.ts`。
 *    **本条取代「目录号 vs 函数号」那条框架**：同样的四个事实，但照抄 eratohoK 的目录规则要
 *    `深度 ≤ 3`，而本盘最深 5 层（上面 39 号那条正在第 4 层）⇒ 目录口径**必漏**，号口径不漏。
 *    只发一条、不发两条。补扫范围＝口上域（与规则 3 同一条前缀判据）；整棵 `ERB` 都扫的口径实测
 *    补集里的幽灵号**也只有这 1 条**，故收窄不丢命中、只省 271 份文件的读盘。
 *    代价：本条是 `scope:'project'`，每轮整项目重算时要读口上域 636 份正文（引擎一次运行内记忆化，
 *    与规则 3 共用同一份文本），二次解析只为含标记的 285 份付钱。
 * 2. `evrse.kx-placeholder`（**warning**，1 条）——模板置换（K14→K{番号}）漏改的 `_KXX` 化石：
 *    `ERB/口上/0014_アリス/限定無し_K14/KOJO_REACT_K14/REACT_04_羞恥_K14.ERB:1210`
 *    定义 `@KOJO_REACT_KXX_44`（同目录 `0014_アリス` 的号由路径补回，见 `family-index.ts` 口径 5）。
 *    判据**用本地解析器的裁决**（`parseKojoFamily(...).isPlaceholder`），不另写一条正则：
 *    本包的占位符形态定义只在 `family-index.ts:203` 那一条 `PLACEHOLDER_RE` 里，抄第二份就是第二个真源。
 * 3. `evrse.skipstart-shielded-kojo`（**info**，`scope:'file'`，按文件聚合成一条）——
 *    口上域里落在 `[SKIPSTART]…[SKIPEND]` 遮蔽段内的 `@` 定义。真盘 **339 处 / 39 个文件**
 *    （最大一棵 `ERB/口上/0064_こいし/KOJO_TRAIN_MESSAGE_K64.ERB` 166 处、次大
 *    `ERB/口上/0014_アリス/KOJO_MESSAGE_K14/KOJO_REACTION_MESSAGE_K14.ERB` 64 处、第三
 *    `ERB/口上/0010_レミリア/オトコ用/KOJO_COM_K10/COM_K10.ERB` 17 处，`:924` 起）。
 *    **39 行逐处清单（`文件=处数@首行`）在 `tests/conventions.test.ts` 的真盘用例里钉死**，
 *    不再从散文报告转抄（转抄正是上一批把行号写歪的原因）。
 *    标记读数（2026-10-26 复测；判据与 scanner 同一条严格等值）：整棵 `ERB` **942 对 942**、全大写；
 *    非严格形态只有 2 处、都在 `;` 注释里（`ERB/口上/0064_こいし/KOJO_REACT_K64/REACT5_奉仕_K64.ERB`
 *    的 `;[SKIPSTART]` / `;[SKIPEND]`）⇒ scanner 不认、本条也不认（早先那句「943 对 943」是
 *    把这对**注释**也数进去了，口径在此纠正）。含严格标记的文件：整棵 `ERB` 319 份、口上域 285 份
 *    （口上域共 636 份）⇒ 二次解析只为这 285 份付钱。口上域外的 34 份（补集 66 处）按本条口径不判，
 *    其中最大一棵是 `ERB/TRAIN/TRAINSYS/POSE.ERB` 的 57 处 `MASTER_POSE*` 存档——见下面 `conventionPolicy` 一节。
 *    **这是作者有意的存档**，不是错误 ⇒ 严重度只能是 `info`、措辞不许写成"错"，且逐文件一条
 *    （339 条会把面板淹掉，而作者的操作性结论就是"这棵里有多少处没生效"）。
 * 4. `evrse.untagged-face`（**info**，4 条 / 5 处定义，逐面一条）——本包面词表
 *    （`ERATOHOREVERSE_FACE_LABELS`）里没有标签的面名，逐处实测（定位＝该面按路径→行号排序后的第一处）：
 *    `EV16` 2 处 = `ERB/口上/0014_アリス/咲アリ_K14/KOJO_NO9_EVENT_K14/NO9_EVENT_OTHERS_K14.ERB:592` 与
 *    `ERB/口上/0014_アリス/限定無し_K14/KOJO_EVENT_K14/EVENT_OTHERS_K14.ERB:658`（**报告点在前者**）；
 *    `EV16_1` 1 处 = `ERB/口上/0014_アリス/限定無し_K14/KOJO_EVENT_K14/EVENT_OTHERS_K14.ERB:663`；
 *    `REACT_LUST` 1 处 = `ERB/口上/0039_雛/オトコ用/KOJO_REACT_K39/REACT_10_性奉_K39.ERB:1913`；
 *    `TRAIN_MESSAGE_SKIP` 1 处 = `ERB/口上/0004_大妖精/KOJO_K4.ERB:52`（函数名 `@KOJO_TRAIN_MESSAGE_SKIP_K4`）。
 *    措辞硬约束：**只说「本适配器暂未收录该面名」**。这三个面名里有三个被正文**直接 CALL**
 *    （取证读数 `EV16` 9 处、`EV16_1` 4 处、`REACT_LUST` 11 处调用），写"未使用"就是误报；
 *    只有 `KOJO_TRAIN_MESSAGE_SKIP_K4` 是 0 引用。面名不认识的后果仅是函数树/矩阵显示不出中文标签，
 *    不是口上失效。
 *    本条扫描范围＝整棵 `ERB`（不限口上域）：实测口上域外**没有**额外的未收录面名 ⇒ 4 条不变，
 *    少一个目录判据就少一处会写错的地方。
 *
 * ## `conventionPolicy`（见 `plugin.ts`）
 *
 * 本盘同名多处定义 **87 组 / 215 处多余定义**（原始扫描口径，遮蔽段里的定义也算在内），但校验器吃的是
 * 索引函数表 ⇒ 一轮真实校验（整棵受管 `ERB/`，907 份）只看得见 **3 组**：
 * `EVENTFIRST`、`EVENTLOAD`、`EVENTTRAIN`。前两组是本策略收敛的对象——重复形状是 `#PRI` 条件定义：
 * `EVENTFIRST`（`ERB/FUNCTION/PROCESS/KOMEIJI_FUNCTIONS/KCOLOR.ERB:57` 带 `#PRI`
 * `SIF !KCOLOR("0") / CALL _LOAD_KCOLOR()` ↔ `ERB/SYSTEM/SYSTEM.ERB:4`）与
 * `EVENTLOAD`（同文件 `:62` ↔ `ERB/SYSTEM/SYSTEM_DATAMENU.ERB:48`）——汉化补丁按条件再挂一份同名钩子，
 * 是 Emuera 的 `#PRI` 语义，不是作者写错 ⇒ 收敛成一条留痕。**`EVENTTRAIN` 不收**
 * （`ERB/FUNCTION/USEFUL/COMMON_USEFUL.ERB:437` ↔ `ERB/TRAIN/EVETRAIN.ERB:4`，两处都**不带** `#PRI`
 * ⇒ 不在本策略的收敛范围内，照旧逐条报）。
 *
 * **`MASTER_POSE*` 一族（50 组原始口径）不在这 3 组里，原因不是判据漏了**：那一族的第二份整棵是
 * `[SKIPSTART]` 存档 —— `ERB/TRAIN/TRAINSYS/POSE.ERB:1` 开段，段内 57 处 `MASTER_POSE*` 定义
 * （`MASTER_POSE` 在 `:4`、`MASTER_POSE_ACT10` 在 `:848`），而 `ERB/TRAIN/TRAINSYS/MASTER_POSE.ERB`
 * 的 `:2` / `:873` 才是引擎实际编译的那一份 ⇒ `erb.duplicate-function`（只吃索引）恒只见一处、
 * **不可能**报出这一族的重复。把它报出来要动内置规则或解析器（跨包，本批不许）⇒ 本批的事实是
 * 在测试里钉住「差集补集里有 `POSE.ERB:4 MASTER_POSE`」+「索引里 `MASTER_POSE` 只有 1 处」，
 * 而不是假装重复规则看得见它。**策略清单不因此加 `MASTER_POSE`**（加了等于按一个看不见的重复收敛）。
 *
 * ## 已否决、**不发**的规则（实测理由）
 *
 * - **照抄 eraTW 的 `kojo-completeness`**：本盘 **75 处误报**——FLAGSETTING / ENCOUNTER / EXTRASOURCE
 *   在本盘 **0 个定义**，而 `M_KOJO` 那 11 处命中**全部**是 `ACT_ACTM_KOJO_CORRECTION_T` 的子串伪命中
 *   （`family-index.ts` 口径 2）。
 * - **`Global.csv` vs `Globals.csv`「重名表」**：两张表的键集**互不相交**（`{0,998,999}` 对
 *   `{10..14,99}`），且 `Globals.csv` 自述就是共享字符串表 ⇒ 报出来是假警报。
 * - **`TRYCCALLFORM` 一族规则**：口上域内 **0 处**（间接转发路由不产生该形态，见 `constants.ts`）。
 * - **照抄 eraTW 的 `form-triple-symbol`**：`PRINTFORM` 行 **0 命中**；把它放宽到 `PRINTL`/`PRINTW`
 *   会撞上 190 处 `***` + 37 处 `===` 的**装饰线**（作者有意分隔线，不是串味事故）。
 */

import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  ErbFile,
  ErbFunction,
} from '@kojo/plugin-api';
import { ERB_SKIP_MARKERS, erbCodeBodyOf, join } from '@kojo/plugin-api';
import { ERATOHOREVERSE } from './constants';
import { ERATOHOREVERSE_FACE_LABELS, createEratohoreverseFamilyIndex, parseKojoFamily } from './family-index';

/**
 * 规则集的外部依赖（由 `plugin.ts` 装配时注入）。
 *
 * 为什么要有这一层而不是在 `conventions.ts` 里直取 `@kojo/plugin-erb-parser` 的 `parseErbText`：
 * 铁律 2（`pnpm audit:decoupling` C 项）禁插件间交叉 import，非测试源码没有豁免。
 * 服务键 `erb.parser` 的 `parseText` 就是索引那一条 `parseErbText`（同一个 scanner、同一套判据），
 * 差集口径要的"同一条语法"由此成立。
 */
export interface EratohoreverseConventionDeps {
  /**
   * 缓冲区结构解析（遮蔽段补集的唯一通道，见文件头）。
   * 缺席 ⇒ 需要它的判定**抛错**进 `report.failedRules`（铁律 4），不返回空数组冒充"判过了"。
   */
  readonly parseText?: (text: string, path: string) => ErbFile;
}

/** 取解析器；缺席即出声（错误文案要说清是谁缺席、后果是什么） */
function requireParseText(ruleId: string, deps: EratohoreverseConventionDeps) {
  if (!deps.parseText) {
    throw new Error(
      `${ruleId} 需要 erb.parser 服务（解析器插件被停用/未激活）：遮蔽段里的 @ 定义拿不到，本条没有结论`,
    );
  }
  return deps.parseText;
}

/* 差集通道本体见 `shieldedDefinitions`（规则 1 的补扫与规则 3 共用，一份实现两个消费方） */

/**
 * 一次行扫：把**严格等值**的 `[SKIPSTART]` / `[SKIPEND]` 标记行换成 `;` + 原文（行号不动），
 * 返回换好的文本与"这棵到底有没有标记"。判据与 scanner 逐字同一条（先剥 `;!;` / `;#;` 代码前缀、
 * 再整行严格等值，字面取契约真源 `ERB_SKIP_MARKERS`）；没有任何标记时调用方**不必**第二次解析。
 */
function neutraliseSkipMarkers(text: string): { text: string; hasMarker: boolean } {
  const lines = text.split(/\r\n|\n|\r/);
  let hasMarker = false;
  for (let i = 0; i < lines.length; i += 1) {
    const body = erbCodeBodyOf(lines[i]!.trim());
    if (body === ERB_SKIP_MARKERS.start || body === ERB_SKIP_MARKERS.end) {
      lines[i] = `;${body}`;
      hasMarker = true;
    }
  }
  return { text: lines.join('\n'), hasMarker };
}

/**
 * 遮蔽段里的定义 = **同一条语法两次解析之差**（口径见文件头）：
 * 标记中性化后重解析，再按 `normalizedName` + `startLine` 减掉 `file.functions` 里已有的。
 * 差集天然只含"被标记挡掉的那批"，不需要第二条 `@` 正则，也不会因标记嵌套/半截而说谎。
 */
function shieldedDefinitions(
  deps: EratohoreverseConventionDeps,
  ruleId: string,
  file: ErbFile,
  text: string,
): ErbFunction[] {
  const neutralised = neutraliseSkipMarkers(text);
  if (!neutralised.hasMarker) return [];
  const parseText = requireParseText(ruleId, deps);
  const seen = new Set(file.functions.map((fn) => `${fn.normalizedName}@${fn.startLine}`));
  return parseText(neutralised.text, file.path).functions.filter(
    (fn) => !seen.has(`${fn.normalizedName}@${fn.startLine}`),
  );
}

/** 口上域前缀判据（与 erasqc 同一条：`erasqc-adapter/src/conventions.ts:54-57`）；域外一律不判 */
function isUnderKojoRoot(ctx: ConventionCheckContext, path: string): boolean {
  const kojoRoot = join(ctx.project.rootDir, ...ERATOHOREVERSE.paths.kojoRoot);
  const normalized = path.replace(/\\/g, '/');
  const root = kojoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`);
}

/** 一次读盘：读不到就抛（不把 IO 故障编造成"这棵判过了、没问题"） */
async function readOrThrow(ctx: ConventionCheckContext, path: string): Promise<string> {
  try {
    return await ctx.readFile(path);
  } catch (err) {
    throw new Error(`读取失败：${path}（${String(err)}）`);
  }
}

/* ------------------------------ 规则 1：幽灵角色号 ------------------------------ */

export const RULE_GHOST_CHARACTER_NO = 'evrse.kojo.ghost-character-no';

/** 幽灵号判据（索引里的定义与遮蔽段补集走同一条，绝不分叉） */
function ghostIssueOf(
  ruleId: string,
  hit: { readonly name: string; readonly filePath: string; readonly startLine: number },
  charaIndex: ConventionCheckContext['project']['charaIndex'],
): ConventionIssue | null {
  const m = parseKojoFamily(hit.name);
  if (!m || m.isPlaceholder || m.characterNo === null) return null;
  if (charaIndex.has(m.characterNo)) return null;
  return {
    ruleId,
    severity: 'warning',
    message:
      `「${hit.name}」锚定角色 ${m.characterNo}，但角色表里没有这个号（本盘 CSV/CHARA 实测号域 0–107）。` +
      `本作路由是 CALL KOJO_CALL(@"…_K{NO:TARGET}_…") 的间接转发，名字里的号就是引擎要找的地址 ⇒ ` +
      `这条口上永远不会被任何角色触发。若它属于 ${hit.filePath.split(/[\\/]/).pop() ?? hit.filePath} ` +
      `所在角色的口上，请把「_K${m.characterNo}」改成该角色的号；若是别处的存档，请整段移出口上域。`,
    filePath: hit.filePath,
    line: hit.startLine,
    family: m.face || undefined,
    key: `${ruleId}|${hit.name.toUpperCase()}|${hit.filePath}|${hit.startLine}`,
  };
}

/**
 * 家族函数锚定的角色号不在 `charaIndex`（真盘 108 份 `CSV/CHARA`，号 0–107）里。
 * 占位符（`_KXX`）不参与——它压根不归属角色，归规则 2。
 *
 * 定义来自**两处**：① `ctx.index` 里的普通定义；② 口上域内被 `[SKIPSTART]` 遮掉、
 * 因而出不了函数树的那些（真盘第四条幽灵 `KOJO_TRAIN_MESSAGE_K642_312` 正在此列）。
 * ②走差集通道（见文件头），解析器缺席或读盘失败一律抛错进 `failedRules`。
 */
function createGhostCharacterNoRule(deps: EratohoreverseConventionDeps): ConventionRule {
  return {
    id: RULE_GHOST_CHARACTER_NO,
    description:
      '家族函数锚定的角色号在角色表（CSV/CHARA）里不存在，含被 [SKIPSTART] 遮蔽的那批（引擎按该号拼名，永远召不到）',
    severity: 'warning',
    source:
      '真盘 C:/game/eratohoReverse（2026-10-26 复测）：4 处（112/142/392/642；前三在索引、第四在 [SKIPSTART] 段内），角色表号域 0–107，四处静态引用均 0',
    async check(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
      const issues: ConventionIssue[] = [];
      for (const refs of ctx.index.byName.values()) {
        for (const ref of refs) {
          const issue = ghostIssueOf(RULE_GHOST_CHARACTER_NO, ref, ctx.project.charaIndex);
          if (issue) issues.push(issue);
        }
      }
      // ② 遮蔽段补扫（只口上域；见文件头"补扫范围"的实测理由）
      for (const file of ctx.index.files.values()) {
        if (!isUnderKojoRoot(ctx, file.path)) continue;
        const text = stripBom(await readOrThrow(ctx, file.path));
        for (const fn of shieldedDefinitions(deps, RULE_GHOST_CHARACTER_NO, file, text)) {
          const issue = ghostIssueOf(RULE_GHOST_CHARACTER_NO, fn, ctx.project.charaIndex);
          if (issue) issues.push(issue);
        }
      }
      return issues;
    },
  };
}

/** 剥 BOM（内核已剥，双保险；本盘 907/907 带 BOM，见文件头取证尺子） */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/* ------------------------------ 规则 2：_KXX 占位符 ------------------------------ */

export const RULE_KX_PLACEHOLDER = 'evrse.kx-placeholder';

/** 命中点（`check` 与 `partition.combine` 共用的最小形态；与 eraTW 同一条规则同粒度） */
interface PlaceholderRef {
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
}

function placeholderIssue(hit: PlaceholderRef, where: readonly string[], ownerNo: number | null): ConventionIssue {
  return {
    ruleId: RULE_KX_PLACEHOLDER,
    severity: 'warning',
    message:
      `「${hit.name}」是模板占位符残留（共 ${where.length} 处：${where.join(' | ')}）：` +
      `模板以 K{番号} 编写后需替换成具体角色号，漏改则该口上永远不会被引擎调用。` +
      (ownerNo === null ? '' : `所在文件属 ${ownerNo} 号角色，可据此补号。`),
    filePath: hit.filePath,
    line: hit.startLine,
    ...(ownerNo === null ? {} : { characterNo: ownerNo }),
    key: `${RULE_KX_PLACEHOLDER}|${hit.name.toUpperCase()}`,
  };
}

/**
 * 判据 = **本包解析器的裁决**（`parseKojoFamily(...).isPlaceholder`），不另写正则：
 * 占位符形态只在 `family-index.ts` 的 `PLACEHOLDER_RE` 一处定义（口径 5），
 * 第二条正则就是第二个真源，改日两边口径一分岔这条规则就会自己造假。
 * 角色号回补也走同一条生产入口（`createEratohoreverseFamilyIndex().match(name, filePath)`
 * 会按路径段 `…_K14` 把 14 号补回来）。
 */
function createKxPlaceholderRule(): ConventionRule {
  const familyIndex = createEratohoreverseFamilyIndex();
  const isHit = (name: string): boolean => name.includes('_KX') && parseKojoFamily(name)?.isPlaceholder === true;
  return {
    id: RULE_KX_PLACEHOLDER,
    description: '_KXX / _K{…} / 光杆 _K 模板占位符残留（置换事故化石，函数名匹配不到任何角色）',
    severity: 'warning',
    source: '真盘 C:/game/eratohoReverse：1 处（REACT_04_羞恥_K14.ERB:1210 定义 @KOJO_REACT_KXX_44）',
    check(ctx: ConventionCheckContext): ConventionIssue[] {
      const issues: ConventionIssue[] = [];
      for (const refs of ctx.index.byName.values()) {
        const hits: PlaceholderRef[] = [];
        for (const ref of refs) {
          if (!isHit(ref.name)) continue;
          hits.push({ name: ref.name, filePath: ref.filePath, startLine: ref.startLine });
        }
        const hit = hits[0];
        if (!hit) continue;
        const ownerNo = familyIndex.match(hit.name, hit.filePath)?.characterNo ?? null;
        issues.push(placeholderIssue(hit, hits.map((r) => `${r.filePath}:${r.startLine}`), ownerNo));
      }
      return issues;
    },
  };
}

/* ------------------------------ 规则 3：[SKIPSTART] 遮蔽段里的口上定义 ------------------------------ */

export const RULE_SKIPSTART_SHIELDED = 'evrse.skipstart-shielded-kojo';

/**
 * 口上域内落在 `[SKIPSTART]…[SKIPEND]` 遮蔽段里的 `@` 定义，逐文件聚合成一条 info。
 *
 * 定义集合走文件头那条**差集通道**（`shieldedDefinitions`）：区间内的 `@` 行压根不进
 * `ErbFile.functions`（`erb-parser/src/scanner.ts` 的 `inSkipBlock` 分支直接 `continue`），
 * 而 `ErbFile` 上又没有第二张定义表 ⇒ 早先那版"函数表 ∩ 遮蔽区间"恒为空集，整条规则never fire
 * （连"读不到正文要抛错"都到不了——空函数表的早退挡在读盘之前）。现在的顺序是：
 * 口上前缀闸 → 读盘（失败即抛）→ 标记闸 → 二次解析取差集 → 聚合，成本只落在真有标记的那 286 份。
 */
function createSkipStartRule(deps: EratohoreverseConventionDeps): ConventionRule {
  return {
    id: RULE_SKIPSTART_SHIELDED,
    description: '口上域内有 @ 定义落在 [SKIPSTART]…[SKIPEND] 遮蔽段里（这段口上引擎根本不会执行）',
    severity: 'info',
    source:
      '真盘 C:/game/eratohoReverse ERB/口上（2026-10-26 差集口径复测）：339 处定义 / 39 个文件（最大一棵 166 处）；' +
      '口上域 636 份里 286 份含标记、整棵 ERB（907 份）口径为 405 处 / 42 个文件',
    // 只看这棵文件自身 ⇒ 逐文件增量
    scope: 'file',
    async checkFile(ctx: ConventionCheckContext, file: ErbFile): Promise<ConventionIssue[]> {
      if (!isUnderKojoRoot(ctx, file.path)) return [];
      const text = stripBom(await readOrThrow(ctx, file.path));
      const shielded = shieldedDefinitions(deps, RULE_SKIPSTART_SHIELDED, file, text).sort(
        (a, b) => a.startLine - b.startLine,
      );
      if (shielded.length === 0) return [];
      const first = shielded[0]!;
      const last = shielded[shielded.length - 1]!;
      return [
        {
          ruleId: RULE_SKIPSTART_SHIELDED,
          severity: 'info',
          message:
            `本文件有 ${shielded.length} 个 @ 定义位于 [SKIPSTART]…[SKIPEND] 遮蔽段内` +
            `（首处 ${first.name} @ 行 ${first.startLine}，末处行 ${last.startLine}）。` +
            `遮蔽段里的正文引擎不会执行——这通常就是作者把写完又下线的一整批口上**存档**在这里的写法，` +
            `所以这条只作提示不作错误；若这段本意是要生效的，请把标记去掉。`,
          filePath: file.path,
          line: first.startLine,
          key: `${RULE_SKIPSTART_SHIELDED}|${file.path}`,
        },
      ];
    },
  };
}

/* ------------------------------ 规则 4：本包未收录的面名 ------------------------------ */

export const RULE_UNTAGGED_FACE = 'evrse.untagged-face';

/**
 * 面词表是本包的显示真源（`ERATOHOREVERSE_FACE_LABELS`，语义出处＝真盘作者注释）。
 * 词表没有的面名 ⇒ 函数树/条件矩阵只能原样显示 token。措辞**不许写"未使用"**：
 * 实测 `EV16` / `EV16_1` / `REACT_LUST` 三个面名分别被正文直接 CALL 9 / 4 / 11 处。
 *
 * **同面多处定义时的定位口径**（钉住以免跨轮漂移）：命中点一律按（路径→行号）排序，
 * issue 的 `filePath`/`line` 取**排序后的第一处**，消息里的清单取同一序的全集
 * （路径统一成正斜杠再比，跨平台同一串文本）。本盘 `EV16` 有两处定义，
 * 早先那版直接取 Map 的插入序（= 索引遍历序）⇒ 报告点哪一处随盘上枚举顺序而定，不可复现。
 */
function createUntaggedFaceRule(): ConventionRule {
  /** 命中点的稳定序：路径（正斜杠）字典序 → 行号 */
  const byPathThenLine = (
    a: { readonly filePath: string; readonly startLine: number },
    b: { readonly filePath: string; readonly startLine: number },
  ): number => {
    const pa = a.filePath.replace(/\\/g, '/');
    const pb = b.filePath.replace(/\\/g, '/');
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.startLine - b.startLine;
  };
  return {
    id: RULE_UNTAGGED_FACE,
    description: '口上函数用了本适配器面词表里没有的面名（只显示不出中文标签，不影响引擎调用）',
    severity: 'info',
    source:
      '真盘 C:/game/eratohoReverse（2026-10-26 复测）：4 个面名 / 5 处定义（EV16 2 处 / EV16_1 1 处 / REACT_LUST 1 处 / TRAIN_MESSAGE_SKIP 1 处），逐处清单见文件头',
    check(ctx: ConventionCheckContext): ConventionIssue[] {
      const sites = new Map<string, Array<{ filePath: string; startLine: number; name: string }>>();
      for (const refs of ctx.index.byName.values()) {
        for (const ref of refs) {
          const m = parseKojoFamily(ref.name, ref.filePath);
          if (!m || !m.face) continue;
          if (m.face in ERATOHOREVERSE_FACE_LABELS) continue;
          const list = sites.get(m.face) ?? [];
          list.push({ filePath: ref.filePath, startLine: ref.startLine, name: ref.name });
          sites.set(m.face, list);
        }
      }
      const issues: ConventionIssue[] = [];
      for (const face of [...sites.keys()].sort()) {
        const hits = (sites.get(face) ?? []).slice().sort(byPathThenLine);
        const first = hits[0]!;
        const where = hits.map((h) => `${h.filePath.replace(/\\/g, '/')}:${h.startLine}`);
        issues.push({
          ruleId: RULE_UNTAGGED_FACE,
          severity: 'info',
          message:
            `面名「${face}」本适配器暂未收录该面名（共 ${hits.length} 处定义：${where.join(' | ')}），` +
            `函数树与条件矩阵会原样显示这个 token、没有中文标签。` +
            `本包的面词表只收真盘作者注释说死了语义的面（见 family-index.ts 头注），` +
            `一次性私货面按口径不入表——这**不代表**它没被调用。`,
          filePath: first.filePath,
          line: first.startLine,
          family: face,
          key: `${RULE_UNTAGGED_FACE}|${face}`,
        });
      }
      return issues;
    },
  };
}

/* ---------------------------- 汇总 ---------------------------- */

/**
 * 构造 eratohoReverse 约定规则集（供 `GameAdapter.conventions` 使用）。
 * `deps.parseText` 由 `plugin.ts` 经服务键 `erb.parser` 注入（缺席与判定口径见文件头）。
 */
export function createEratohoreverseConventions(
  deps: EratohoreverseConventionDeps = {},
): readonly ConventionRule[] {
  return [
    createGhostCharacterNoRule(deps),
    createKxPlaceholderRule(),
    createSkipStartRule(deps),
    createUntaggedFaceRule(),
  ];
}
