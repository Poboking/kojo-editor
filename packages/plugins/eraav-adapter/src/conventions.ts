/**
 * eraAV 口上约定规则集（`GameAdapter.conventions`）——四条规则，**每条都在 `C:/game/eraAV`
 * 逐处复验过**（2026-10-26；排除 `附件/` 那棵干扰补丁树，它在 `erbRoot` 之外）。
 * 判据一律「宁可漏报不可误报」：语义拿不准的降级为 `info`，量出误报的规则整条不发（见文末）。
 *
 * ## 取证尺子（写在这里是因为它决定所有 `@` 相关计数）
 *
 * **读盘必须先剥 BOM**：真盘 471 份 `.ERB/.ERH` 里 **470 份带 BOM**，而有 **33 份文件的第一行
 * 就是一个 `@` 定义**（`ERB/ABLUP/ABL.ERB:1`、`ERB/EVENT/EVENT_MAEKOJO.ERB:1` …）——
 * 拿 utf8 原文 `startsWith('@')` 会把这些**静默算成 0**，本批次早先那句「0 个定义」就是这么来的
 * （已进 `docs/PITFALLS.md` 231）。`trim()` 恰好会吃掉 `U+FEFF`，所以「我 trim 过了」不算证明。
 * 规则侧的输入是 `ctx.readFile`（内核 `decodeWithProbe` 已按 WHATWG 剥 BOM），
 * 但 `conventions.ts` 里所有直接判行首的分支**仍然显式再剥一次**，不把正确性押在上面那层。
 *
 * ## 四条规则的真盘命中清单
 *
 * 1. `eraav.kojo.chara-duplicate-shadow`（**warning**，1 组 / 2 处 ⇒ 1 条问题）
 *    `ERB/MISSION/EXMISSIONC/MISSION_150_MINAMIEND.ERB:140` 与
 *    `MISSION_203_埃利亞與克莉絲.erb:149` 各定义一次 `@MISSION_RECEIVE_150`，
 *    正文逐字相同（`CALL MISSION_LIFELIST_DECIDE(80)` + `CALL MISSION_EXEC_REPORT(150)`），
 *    两处**都没有** `#PRI`/`#LATER` ⇒ Emuera 只会认其中一份，另一份作者的改动必然失效。
 *    判据「整组一个 `#PRI`/`#LATER` 都没有」正是为了把本作的主流形态挡在外面：全盘同名函数
 *    **4 组 / 71 处多余定义**，其中 `EVENTTRAIN` 35 处里 18 处、`EVENTEND` 36 处里 19 处、
 *    `EVENTSHOP` 2 处里 1 处是「`#PRI`/`#LATER` 存在判定 + 正体」的成对写法（引擎语义，不是作者错）。
 * 2. `eraav.router-face-missing`（**info**，3 条，全属 30 号角色）
 *    必配面集**从主路由 `ERB/EVENT/EVENT_K.ERB` 现读**（`:34/:51/:66/:78/:88` 五处
 *    `TRYCALLFORM …{NO:TARGET}`），过两道闸：① 带 `CATCH` 兜底的 `TRYCCALLFORM`
 *    （`:97/:103` 的 `KOJO_LESPLAY_{n}`／`KOJO_NTR_STAFF_{n}`）**不算必配**——引擎本来就允许缺席；
 *    ② 该面在全盘**一个正体定义都没有**也不算必配（死路由不是作者欠账）——
 *    `SINGLE_ENDING_K{n}` 正是被这道闸挡掉的：真盘 16 处**全部**是 `;@` 注释行、正体 0 个。
 *    活面读数：`MESSAGE_COM` 17/17 份口上文件、`MESSAGE_PALAMCNG` 16/17、`MESSAGE_MARKCNG` 16/17、
 *    `SELF_KOJO` 16/17 ⇒ 缺的三条都在 30 号（`ERB/Lines/EVENT_K30_文野柚香.ERB`）。
 *    锚点 = 该文件的第一处定义行（口上文件缺整个面，指到文件里第一个函数头最省事）。
 * 3. `eraav.annotation-no-conflict`（**info**，1 条）
 *    `ERB/Lines/EVENT_K30_文野柚香.ERB:341` 的 `@KOJO_MESSAGE_COM_30` 尾注原文
 *    「因为是由加子的番号是45，所以这里改成了45」——注释声称 45 号、函数名是 30 号。
 *    判据只认 `番号…数字` 这一种声称形态并与**函数名自己的号**比（不比文件名号，本作两者一致是巧合）。
 *    全盘带 `;` 尾注的定义行 12 处：口上域内 6 处（其余 5 处声称号与函数号一致 ⇒ 不报）、
 *    `ERB/MISSION/EXMISSIONC/` 6 处（`@MISSION_TITLE_{n} ;这里的150是任务在内的番号…` 一类
 *    任务号注释，非家族函数 ⇒ 天然出局，且那批注释的句式本来就不匹配）。
 * 4. `eraav.non-erb-in-kojo-domain`（**info**，1 条）
 *    `ERB/Lines/想达成调教结束后表白效果.txt`——口上域（也是本作唯一可写域）里躺着非 ERB 文件。
 *    真盘 `ERB/Lines/` 共 18 条目 = 17 份 `.ERB` + 这 1 份 `.txt`；域内没有 `.ERH`/`.ERM`。
 *    清单来自 `loadProject` 已经做过的那次 `listDir`（约定上下文没有 IO，见下"闭包输入"）。
 *
 * ## 闭包输入（为什么 2 与 4 不能只看 `ctx`）
 *
 * `ConventionCheckContext` 只有 project / index / readFile / log / policy，**没有列目录能力**，
 * 而「哪份文件属于哪个角色」与「域内有哪些非 ERB 文件」恰恰是目录级事实、且非 ERB 文件
 * 根本进不了 `ErbIndex`。所以这两条吃 `loadProject` 递进来的扫描结果（与 eraTW 把路由表
 * 以 `getProtocol()` 闭包递给 `kojo-call-slot-coverage` 同一个先例，见
 * `packages/plugins/eratw-adapter/src/conventions.ts:500`）；清单没备好 ⇒ 本轮**无结论**，
 * 不拿"空数组"冒充"查过、没问题"。
 *
 * ## 已否决、**不发**的规则（实测理由，留档免得下批再量一遍）
 *
 * - **照抄 eraTW 的 `kojo-completeness`**：本盘 **85 处误报**。它第一道闸是
 *   `if (!chara.kojoDir) continue`，而 eraAV 从不设 `kojoDir`（判据见 `plugin.ts` 头注与
 *   `docs/PITFALLS.md` 229）；四件套面（FLAGSETTING/COLOR/ENCOUNTER/EXTRASOURCE）在本盘
 *   **0 个定义**，报出来的每一条都是无中生有。
 * - **文件名号 vs 函数名号**：可比的 82 处定义里**相左 0 处**（`constants.ts` 同一读数）⇒ 没有内容可报。
 * - **悬空 `CALL` 目标**：本作静态 CALL 全部落地——早先怀疑的 `MAEKOJO_LESPLAY`
 *   实际就定义在 `ERB/EVENT/EVENT_MAEKOJO.ERB:1`（BOM 后首行，剥掉 BOM 才看得见）。
 * - **小写扩展名 `.erb`**：5 份全在口上域之外，且 `erb-ext` 的正文谓词本来就不区分大小写。
 * - **`_KX` 占位符**：本盘 **0 处**——模板树 `附件/杂项/超簡易版口上サンプル/` 与
 *   `附件/口上テンプレート/EVENT_KXX.ERB` 都在 `erbRoot` 之外（`constants.ts` 受管范围裁决）。
 */

import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  ErbFunctionRef,
} from '@kojo/plugin-api';
import { isErbBodyPath, isErbDeclarationPath, isPathUnder, join, pathKey } from '@kojo/plugin-api';
import { ERAAV } from './constants';
import { parseKojoFamily } from './family-index';
import type { EraavKojoScan } from './kojo-scan';

/* ------------------------------ 共用工具 ------------------------------ */

/** 行数组缓存（`ctx.readFile` 已被引擎记忆化，这里只省掉重复 `split`） */
type LineCache = Map<string, string[]>;

/**
 * 取某文件的行数组；**读不到就抛**——空数组会被引擎当"这个文件判过了、没问题"存进桶，
 * 于是偶发 IO 故障被固化成"直到下次编辑都报不出问题"（与 eraTW `form-triple-symbol` 同取舍）。
 */
async function linesOf(ctx: ConventionCheckContext, cache: LineCache, path: string): Promise<string[]> {
  const hit = cache.get(path);
  if (hit) return hit;
  let text: string;
  try {
    text = await ctx.readFile(path);
  } catch (err) {
    throw new Error(`读取失败：${path}（${String(err)}）`);
  }
  // 内核解码已剥 BOM，这里再剥一次是显式护栏（见文件头「取证尺子」）
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  cache.set(path, lines);
  return lines;
}

/** 定义行的**下一行**是否是 `#PRI` / `#LATER`（Emuera 的存在判定块就紧跟函数头） */
async function carriesPriOrLater(
  ctx: ConventionCheckContext,
  cache: LineCache,
  ref: ErbFunctionRef,
): Promise<boolean> {
  const lines = await linesOf(ctx, cache, ref.filePath);
  const next = (lines[ref.startLine] ?? '').trim(); // startLine 是 `@` 那一行（1 基）⇒ 下一行下标即 startLine
  return /^#(?:PRI|LATER)\b/i.test(next);
}

/* --------------------- 规则 1：无存在判定的同名遮蔽 --------------------- */

export const RULE_CHARA_DUPLICATE_SHADOW = 'eraav.kojo.chara-duplicate-shadow';

/** 实测：1 组 / 2 处 ⇒ 发 **1 条**问题（逐处地址进正文，与 eraTW `_KX` 那条同粒度） */
function createDuplicateShadowRule(): ConventionRule {
  return {
    id: RULE_CHARA_DUPLICATE_SHADOW,
    description:
      '同名函数多处定义且**整组都没有** #PRI/#LATER 存在判定（不是本作的成对写法，Emuera 只认其中一份，另一份的改动必然失效）',
    severity: 'warning',
    source: '真盘 C:/game/eraAV 全量：同名 4 组 / 71 处多余定义，其中无 #PRI/#LATER 的 1 组 / 2 处',
    async check(ctx): Promise<ConventionIssue[]> {
      const cache: LineCache = new Map();
      const issues: ConventionIssue[] = [];
      for (const refs of ctx.index.byName.values()) {
        if (refs.length < 2) continue;
        const flagged: boolean[] = [];
        for (const ref of refs) flagged.push(await carriesPriOrLater(ctx, cache, ref));
        if (flagged.some((f) => f)) continue; // 组内出现存在判定 ⇒ 本作结构，不报
        const first = refs[0]!;
        const where = refs.map((r) => `${r.filePath}:${r.startLine}`).join(' | ');
        issues.push({
          ruleId: RULE_CHARA_DUPLICATE_SHADOW,
          severity: 'warning',
          message:
            `「${first.name}」被 ${refs.length} 处定义且都不带 #PRI/#LATER：${where}。` +
            `本作的成对写法是「#PRI/#LATER 存在判定 + 正体」（实测 EVENTTRAIN 18/35、EVENTEND 19/36、EVENTSHOP 1/2 处带判定），` +
            `整组都没有判定的同名函数只会有一处在生效，其余文件的改动永远不会进游戏。`,
          filePath: first.filePath,
          line: first.startLine,
          key: `${RULE_CHARA_DUPLICATE_SHADOW}|${first.normalizedName}`,
        });
      }
      return issues;
    },
  };
}

/* --------------------- 规则 2：主路由必配面缺席 --------------------- */

export const RULE_ROUTER_FACE_MISSING = 'eraav.router-face-missing';

/** `TRYCALLFORM 名字模板`——**只认这一条指令**：`TRYCCALLFORM …CATCH` 一族的缺席是设计允许的 */
const TRYCALLFORM_RE = /^\s*TRYCALLFORM\s+([A-Za-z0-9_{}:]+)/i;

/** 主路由里指向"目标角色号"的槽位写法（本作只有这一种） */
const TARGET_SLOT = '{NO:TARGET}';

/**
 * 从主路由正文现读必配面模板（**不硬编码面名清单**）。
 * 返回 `[面, 首次出现的行号, 名字模板]`；`1` 是探针号——模板里 `{NO:TARGET}` 换成角色号后
 * 必须能被家族解析认成"该号的这个面"，认不出的模板（引擎侧其它 TRYCALLFORM）不进必配集。
 */
async function requiredFaceTemplates(
  ctx: ConventionCheckContext,
  routerPath: string,
): Promise<Array<{ face: string; line: number; template: string }>> {
  const out: Array<{ face: string; line: number; template: string }> = [];
  const lines = await linesOf(ctx, new Map(), routerPath);
  for (let i = 0; i < lines.length; i++) {
    const m = TRYCALLFORM_RE.exec(lines[i] ?? '');
    const template = m?.[1];
    if (!template || !template.includes(TARGET_SLOT)) continue;
    const probe = parseKojoFamily(template.replaceAll(TARGET_SLOT, '1'));
    if (!probe || probe.characterNo !== 1) continue;
    out.push({ face: probe.face, line: i + 1, template });
  }
  return out;
}

/** 一个"可归属"的定义摘要：面 + 函数名锚定的角色号 */
interface FaceRef {
  readonly face: string;
  readonly characterNo: number;
  readonly startLine: number;
}

function createRouterFaceRule(getScan: () => EraavKojoScan | undefined): ConventionRule {
  return {
    id: RULE_ROUTER_FACE_MISSING,
    description: '主路由无条件 TRYCALLFORM 的某个面在该角色自己的口上文件里没有定义（该角色在这个时机永远不出声）',
    severity: 'info',
    source:
      'ERB/EVENT/EVENT_K.ERB 的 TRYCALLFORM …{NO:TARGET}（TRYCCALLFORM/CATCH 与全盘 0 正体定义的死路由一律不计）',
    async check(ctx): Promise<ConventionIssue[]> {
      const scan = getScan();
      if (scan === undefined) return []; // 目录级事实没备好 ⇒ 本轮无结论（不拿空清单冒充"查过"）
      const routerPath = join(ctx.project.rootDir, ...ERAAV.detect.routerErb);
      const templates = await requiredFaceTemplates(ctx, routerPath);
      if (templates.length === 0) return [];

      /**
       * 口上域内的可归属定义按文件归堆。键走 `pathKey`（Windows 折叠大小写 + 归一分隔符）：
       * `loadProject` 的 `listDir` 与 ERB 索引的 walker 两处给到的路径写法不必逐字相同，
       * 直接拿原串做键会漏配成"这个文件一个定义都没有"。
       */
      const refsByFile = new Map<string, FaceRef[]>();
      for (const entry of scan.kojoFiles) refsByFile.set(pathKey(entry.path), []);
      for (const refs of ctx.index.byName.values()) {
        for (const ref of refs) {
          const bucket = refsByFile.get(pathKey(ref.filePath));
          if (bucket === undefined) continue; // 不是口上域的文件：本规则只管"这个角色自己的文件"
          const probe = parseKojoFamily(ref.name, ref.filePath);
          if (!probe || probe.characterNo === null) continue;
          bucket.push({ face: probe.face, characterNo: probe.characterNo, startLine: ref.startLine });
        }
      }
      /**
       * 闸②：一个面在全盘口上域里一个正体定义都没有 ⇒ 那是**死路由**，不是作者欠账
       * （`SINGLE_ENDING_K{n}` 即此例：16 处全是 `;@` 注释、正体 0 个，报出来 17 条全是误报）。
       */
      const liveFaces = new Set<string>();
      for (const bucket of refsByFile.values()) {
        for (const r of bucket) liveFaces.add(r.face);
      }

      const issues: ConventionIssue[] = [];
      for (const entry of scan.kojoFiles) {
        const bucket = refsByFile.get(pathKey(entry.path)) ?? [];
        /** 锚点 = 该文件最早的一处定义行（缺整个面是文件级事实，指到文件里第一个函数头最省事） */
        const anchor = bucket.reduce(
          (min, r) => (min === undefined || r.startLine < min ? r.startLine : min),
          undefined as number | undefined,
        );
        for (const t of templates) {
          if (!liveFaces.has(t.face)) continue;
          if (bucket.some((r) => r.face === t.face && r.characterNo === entry.no)) continue;
          issues.push({
            ruleId: RULE_ROUTER_FACE_MISSING,
            severity: 'info',
            message:
              `${entry.label}（${entry.no} 号）的口上文件没有定义面「${t.face}」：` +
              `主路由 ERB/EVENT/EVENT_K.ERB:${t.line} 无条件 TRYCALLFORM ${t.template}，` +
              `该角色在这个时机不会有任何口上。同盘别的口上文件里有这个面的正体定义（活面判定），` +
              `所以这不是死路由；若确实不打算写，请补一条空面或删掉这段路由。`,
            filePath: entry.path,
            ...(anchor === undefined ? {} : { line: anchor }),
            characterNo: entry.no,
            family: t.face,
            key: `${RULE_ROUTER_FACE_MISSING}|${entry.no}|${t.face}`,
          });
        }
      }
      return issues;
    },
  };
}

/* --------------------- 规则 3：定义行尾注的角色号自相矛盾 --------------------- */

export const RULE_ANNOTATION_NO_CONFLICT = 'eraav.annotation-no-conflict';

/** 注释里"声称的角色号"只有这一种句式（`番号是45` / `番号為45`）；任务号注释（`这里的150是…番号`）不匹配 */
const CLAIMED_NO_RE = /番号\s*[是為为]?\s*(\d{1,4})/g;

function createAnnotationConflictRule(): ConventionRule {
  return {
    id: RULE_ANNOTATION_NO_CONFLICT,
    description: '定义行尾注里声称的角色号与函数名自己的角色号不一致（模板置换留下的注释与代码对不上）',
    severity: 'info',
    source: '真盘 C:/game/eraAV：带 ; 尾注的定义行 12 处（口上域 6 处），矛盾 1 处（EVENT_K30_文野柚香.ERB:341）',
    // 只看这一棵文件的正文与函数表 ⇒ 逐文件可增量
    scope: 'file',
    async checkFile(ctx, file): Promise<ConventionIssue[]> {
      const cache: LineCache = new Map();
      const lines = await linesOf(ctx, cache, file.path);
      const issues: ConventionIssue[] = [];
      for (const fn of file.functions) {
        const probe = parseKojoFamily(fn.name, fn.filePath);
        const ownNo = probe?.characterNo;
        if (ownNo === null || ownNo === undefined) continue;
        const raw = lines[fn.startLine - 1] ?? '';
        const semi = raw.indexOf(';');
        if (semi < 0) continue;
        const annotation = raw.slice(semi + 1);
        CLAIMED_NO_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CLAIMED_NO_RE.exec(annotation)) !== null) {
          const claimed = Number.parseInt(m[1] ?? '', 10);
          if (!Number.isFinite(claimed) || claimed === ownNo) continue;
          issues.push({
            ruleId: RULE_ANNOTATION_NO_CONFLICT,
            severity: 'info',
            message:
              `「${fn.name}」的行尾注释声称角色号是 ${claimed}，函数名锚定的却是 ${ownNo}：` +
              `注释与代码二者必有一处没跟着模板改（引擎只按函数名路由，注释不参与）。` +
              `原文：${annotation.trim()}`,
            filePath: file.path,
            line: fn.startLine,
            characterNo: ownNo,
            family: probe?.face || undefined,
            key: `${RULE_ANNOTATION_NO_CONFLICT}|${file.path}|${fn.startLine}`,
          });
        }
      }
      return issues;
    },
  };
}

/* --------------------- 规则 4：口上域里的非 ERB 文件 --------------------- */

export const RULE_NON_ERB_IN_KOJO_DOMAIN = 'eraav.non-erb-in-kojo-domain';

/**
 * `.ERH` 不在契约的"正文扩展名"集合里（`ERB_BODY_EXTENSIONS` = `.erb`/`.erm`，
 * 那是"可含函数定义"的口径），但它在口上域里是合法的头文件 ⇒ 一并放过，
 * 只报**两者都不是**的文件（本作实测就是那份 `.txt` 说明）。
 * 判据一律取契约谓词（`isErbBodyPath` / `isErbDeclarationPath`），**不许在本包再抄一遍
 * 扩展名字面量**——扩展名口径的副本闸是 `packages/plugin-api/tests/erb-ext.test.ts`。
 */
function isErbFamilyFile(path: string): boolean {
  return isErbBodyPath(path) || isErbDeclarationPath(path);
}

function createNonErbRule(getScan: () => EraavKojoScan | undefined): ConventionRule {
  return {
    id: RULE_NON_ERB_IN_KOJO_DOMAIN,
    description: '口上域里存在非 ERB/ERH 文件（不参与函数索引与检索，且本作这个域还是唯一可写路径）',
    severity: 'info',
    source: '真盘 C:/game/eraAV：ERB/Lines 共 18 条目 = 17 份 .ERB + 1 份 .txt，命中 1 处',
    async check(ctx): Promise<ConventionIssue[]> {
      const scan = getScan();
      if (scan === undefined) return [];
      const kojoRoot = join(ctx.project.rootDir, ...ERAAV.paths.kojoRoot);
      const issues: ConventionIssue[] = [];
      for (const path of scan.nonErbFiles) {
        if (isErbFamilyFile(path)) continue; // 清单是 loadProject 那次的快照，这里再判一次当前口径
        if (!isPathUnder(kojoRoot, path)) continue;
        issues.push({
          ruleId: RULE_NON_ERB_IN_KOJO_DOMAIN,
          severity: 'info',
          message:
            `口上域里有非 ERB/ERH 文件：${path}。它不进函数索引、不参与口上检索，` +
            `而本作的口上域同时是唯一可写路径——作者在这里放说明文容易误当成口上内容。`,
          filePath: path,
          key: `${RULE_NON_ERB_IN_KOJO_DOMAIN}|${path}`,
        });
      }
      return issues;
    },
  };
}

/* ---------------------------- 汇总 ---------------------------- */

/**
 * 构造 eraAV 约定规则集（供 `GameAdapter.conventions` 使用）。
 * @param getScan `loadProject` 备好的口上域目录级事实（角色号→文件、域内非 ERB 文件）；
 *   未加载工程时返回 `undefined` ⇒ 吃它的两条规则本轮无结论。
 */
export function createEraavConventions(
  getScan: () => EraavKojoScan | undefined = () => undefined,
): readonly ConventionRule[] {
  return [
    createDuplicateShadowRule(),
    createRouterFaceRule(getScan),
    createAnnotationConflictRule(),
    createNonErbRule(getScan),
  ];
}
