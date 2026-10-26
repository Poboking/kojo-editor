/**
 * eratohoReverse 函数家族识别规则（`FamilyIndexRule` 实现）——
 * **全部 eratohoReverse 领域知识只住本包**（路径/锚点取自 `./constants`）。
 *
 * ## 为什么本作的家族清单只能「按真盘定义枚举反推」
 *
 * 路由**不是** eraTW 式「TRYCALLFORM 直接拼名」，而是**间接转发**（真盘 `ERB/口上/EVENT_K.ERB`）：
 * 系统侧 `CALL KOJO_CALL(@"ACT_K{NO:TARGET}_{TFLAG:ACT}", …)`（`:350`）把**函数名后半段**当字符串交下去，
 * `@KOJO_CALL`（`:502`）先套立场层（`MS_`／`AS_`，`:525/:528`）与优先层（`PRI{1..3}_`，`:519`），
 * `@KOJO_CALL2`（`:561`）再套性器层（`KOJO_{MALE|TWIN|PENIS|FEMALE}YOU_%ARGS%`，`:573-664`）、
 * 玩家编号层（`KOJO_NO{NO:MASTER}_%ARGS%`，`:589`）与性别层（`KOJO_{MALE|TWIN|PENIS|FEMALE}_%ARGS%`，`:710-757`），
 * 最里层才是 `TRYCALLFORM KOJO_%ARGS%`（`:793`）。⇒ 名字是**四层拼出来的**，
 * 扫 `TRYCALLFORM`/`TRYCCALLFORM` 字面（全树另有 `TRYCCALLFORM` 21 处）只能看到 `%ARGS%` 这种占位，
 * **抓不全家族面** ⇒ 家族面一律由真盘 `@` 定义枚举反推（下表）。
 *
 * ## 真盘读数与面词表
 *
 * 口径 = `ERB/口上/` 全部 633 份 `.ERB` 里 erb-parser `parseFunctionDefinition` 认定的
 * `@` 定义（与编辑器函数树同判据）共 **5,796** 个；其中行首顶格 5,786、缩进 10
 * （主会话给的 5,782 是同树再排 4 处非定义形的口径，两口径命中差 ≤ 0.25%，本文一律按 5,796 计）。
 *
 * ```
 * KOJO_ACT_K1_0                    ← 动作口上（`EVENT_K.ERB:350` 尾槽 = TFLAG:ACT 动作号；1,298 处）
 * KOJO_ACT_K4_26_OLD               ← 同一面的作者自定义尾段（尾段整段进 slot，不裁）
 * KOJO_REACT_K13_0                 ← 反应口上（`:450`，尾槽 = 动作号；1,125 处，含 1 处 `_KXX` 化石）
 * KOJO_COM_K1_12                   ← 指令口上（`:456` 尾槽 = SELECTCOM ⇒ **本作有指令号尾槽**；768 处）
 * KOJO_EVENT_K1_201                ← 事件口上（`:114`，尾槽 = 事件番号；504 处）
 * KOJO_TRAIN_MESSAGE_K11_0         ← 旁白口上（`:296`，尾槽 = 动作号；506 处）
 * KOJO_TRAIN_MESSAGE2_K11_0        ← 反应旁白（`:319`；495 处）
 * KOJO_TRAIN_MESSAGE_ANIME_K1      ← 旁白动画效果（`0001_霊夢/KOJO_K1.ERB:48`；20 处）
 * KOJO_ACT_ASSI_K1_0 / _EVENT_ASSI_ / _DATUI_ASSI_ / _ACT_EXTRA_  ← 助手与追加行动（139 / 9 / 4 / 106）
 * KOJO_NO9_TRAIN_MESSAGE_K11_0     ← **玩家编号族**（`KOJO_NO{NO:MASTER}_…`，`:589`；NO9 族共 564 处）
 * KOJO_NO9_MS_ACT_K14_1            ← 家族段可**叠两层**（玩家编号 + 主人限定）
 * KOJO_FEMALEYOU_EXCLUSION_K22     ← **性器族**（`KOJO_{…}YOU_…`，`0022_紫/KOJO_K22.ERB:48`；121 处）
 * KOJO_MALE_ACT_K1_1               ← 性别族（不带 YOU，`:710`；family=MALE 628 处，叠层另 2 处）
 * KOJO_MS_EVENT_K1_11 / KOJO_AS_EVENT_K1_11 / KOJO_PRI1_MS_EVENT_K1_11
 *                                  ← 立场层（主人／追加调教者／优先口上，`:519/:525/:528`）
 * KOJO_Y1_EXCLUSION_K1             ← 模板立场槽 `Y1`（`0001_霊夢/KOJO_K1.ERB:55` 注释直说
 *                                    「Y1的部位を MALEYOU/…/NO{角色番号} にする」⇒ 未改写的槽位）
 * KOJO_K1                          ← 口上存在判定（每角色一份，`:813 TRYCALLFORM KOJO_K{ARG}`；25 处）
 * KOJO_COLOR_K1 / SETUP_K1 / ATTENTION_K1 / DIGEST_K1 / MARK_K1 / DATUI_K1 / USE_K1 / POSE_K1
 *                                  ← 小面（`0001_霊夢/KOJO_K1.ERB:75/130/119/108` 等，各 19–26 处）
 * KOJO_PRIORITY1_K1                ← 优先口上判定（`:513`；PRIORITY1/2/3 各 1 处）
 * KOJO_EXCLUSION_K1                ← 排他判定（`KOJO_{立场}_EXCLUSION_K{no}`，共 19 处）
 * KOJO_REACTION_MESSAGE_K14_0      ← 作者扩展面（引擎 `@REACTION_MESSAGE` 的角色侧；64 处）
 * ```
 *
 * 真盘 31 个残余面、5,254 个带号定义**全部可解析**，未命中只有三类（见文末「覆盖率」）。
 *
 * ## 六条解析口径（都由真盘倒推，宁可不标也不标错）
 *
 * 1. **锚点是 `_K{数字}`，且必须带 `KOJO_` 前缀**（`ERATOHOREVERSE.charaAnchor`）。
 *    实测 5,254 个带号 KOJO 定义里「首个锚 = 末个锚」（0 例分歧），故沿用 eraTW 的
 *    **贪婪末锚**判据而不必另立规则；`KOJO_K1` 的锚就是它自己（head = `KOJO`）。
 * 2. **`M_KOJO` 在本作不存在**（eraTW 的中缀家族在这里是**陷阱**）：全树 `M_KOJO` 11 处
 *    **全部**是 `ACT_ACTM_KOJO_CORRECTION_T` 的子串伪命中（`ERB/TRAIN/ACT/PLAYER_ACTM/
 *    PLAYER_ACTM_00_会話.ERB:121` 等 10 处 CALL + `PLAYER_ACTM_PROCESS.ERB:111` 一处定义），
 *    真族一个都没有 ⇒ 本作**只认 `^KOJO_`**。任何照抄 eraTW 的 `M_KOJO` 前缀判据都会把
 *    这 11 处伪命中收进口上家族；`ACT_…`／`PRINT_KOJO_…`／`K64_KOJO_COLOR`／
 *    `CHK_FADECONFIG_OUTPUT_OF_KOJORAND_K14` 同属此族，一律 null。
 * 3. **立场/性别/家族段进 `family`，语义面进 `face`**：`family` = 锚点之前、`KOJO_` 之后的
 *    立场 token 序列（`MS`／`AS`／`SP`／`Y1`／`PRI1..3`／`NO{数字}`／`MALE|FEMALE|TWIN|PENIS`／
 *    `…YOU`，按**名内出现顺序**以 `_` 连接，基础家族 = `''`）；`face` = 剥完立场层剩下的整段
 *    token（原样大写，不查表、不猜语义）。剥不掉就退回整段当 face，**绝不允许**出现空 face。
 * 4. **尾段整段进 `slot`**：`KOJO_ACT_K4_26_OLD` → `26_OLD`、`KOJO_EVENT_K52_AMIBA_EVENT` →
 *    `AMIBA_EVENT`、`KOJO_REACT_K13_性奉共通` → `性奉共通`。子分支里可能再含 `_K` 之外的数字，
 *    裁成首段会丢掉「这条属于哪一档」的证据（对齐 era紅魔館 的同条纪律）。
 * 5. **`_KX` / `_K{…}` / 光杆 `_K` 是模板化石**：标 `isPlaceholder`、`characterNo = null`
 *    （真盘 1 处 `KOJO_REACT_KXX_44`，`0014_アリス/…/REACT_04_羞恥_K14.ERB:1210`）；
 *    这类正是校验器的目标形态，**不能当普通函数**，也不能塞给某个角色。
 *    传了 `filePath` 时按路径里的 `_K{数字}`（文件名/目录名，去扩展名后）补回角色号——
 *    路由本身不读路径，这只是给占位符归位用的 additive 便利，不传即与旧版逐字一致。
 * 6. **路由终端与引擎事件都不是口上家族**：`@KOJO_BAA`／`@KOJO_CALL`／`@KOJO_CHECK` 等
 *    20 处系统调度入口无 `_K{数字}` ⇒ null；本作引擎事件是**连写旧式**
 *    （`@EVENTFIRST`／`@EVENTTRAIN`／`@EVENTCOMEND`… 8 个名字共 11 处真定义，`@EVENTBUY` 0 处、
 *    下划线式只有 `@EVENT_EQUIP` 一处（`ERB/TRAIN/TRAINSYS/EVENT_EQUIP.ERB:1`，是装备钩子不是
 *    编号事件形），且 11 处全在 `ERB/口上` **之外**——真盘实测口上域内 `^@EVENT` 定义为 0）
 *    ⇒ 同样 null，绝不收成面。
 *
 * ## 面标签（中文）的依据与留白
 *
 * 真盘注释已被本仓库机翻混排（中日并列），故标签**只取真盘注释里说死了的语义**：
 * 「活动ション口上」→ 动作口上、「旁白口上」→ 旁白口上、「口上色设定」→ 口上配色、
 * 「配置设定」「注意事项」「口上存在判定」「排他的チェック」「あらすじ」照真盘措辞给中文。
 * 作者一次性私货面（`EV16`／`EV16_1`／`REACT_LUST`／`TRAIN_MESSAGE_SKIP`）**不入表**——
 * 语义只有一行作者注释、撑不起「面」的口径，消费方原样显示 token（fail-visible，不猜）。
 *
 * ## 指令承载面（instructionFaces）裁决
 *
 * **只声明 `['COM']`**：`KOJO_COM_K{no}_{SELECTCOM}`（`EVENT_K.ERB:456`）的尾槽是引擎指令号，
 * 且与本作指令名表 `CSV/Train.csv`（表头「反应(COM)名」，行号 0–8 / 10–16 / 20–22 / 30–33 /
 * 40–44 / 50–52 / 70–71）逐一对上——真盘 COM 尾槽去重后正好是这套带空缺的编号。
 * `ACT`／`REACT`／`TRAIN_MESSAGE` 的尾槽是 `TFLAG:ACT` **动作号**（值域 0–312，`0/1/…/10/…/312`），
 * 不是指令号 ⇒ 若列进 instructionFaces，条件矩阵会拿动作号去查指令名表、凭空造出不存在的列，**不列**。
 * `REACTION_MESSAGE` 的尾槽虽也是反应号，但那是作者自建面（路由从不发这个形），留口不列。
 *
 * ## 覆盖率读数（2026-10-26 真盘全量，非抽样）
 *
 * `ERB/口上/` 5,796 个 `@` 定义逐条过 `parseKojoFamily`：**命中 5,255 / 总数 5,796 = 90.67%**
 * （带号口上定义 5,254 全中 = 可解析面的覆盖 5,254/5,254 = 100%，另 1 处 `_KXX` 模板化石按占位符命中）。
 * 未命中 541 处，按形态三类：
 * - **路由终端 20 处**（`ERB/口上/EVENT_K.ERB` 19 处 + `KOJO_PROFILE.ERB:4` 1 处）：
 *   `@KOJO_BAA`／`@KOJO_DIGEST`／`@KOJO_ATTENTION`／`@KOJO_EVENT`／`@KOJO_ACT`／`@KOJO_REACT`／
 *   `@KOJO_COLOR`／`@KOJO_CALL`／`@KOJO_CALL2`／`@KOJO_CHECK`… 无 `_K{数字}`，是系统侧调度入口，
 *   归任何角色都是错的 ⇒ null；
 * - **排版化石 2 处**（`0014_アリス/…/ACT_01_愛撫_K14.ERB:1530` 的
 *   `@KOJO_TRAIN_MESSAGE_K[角色番号]_ACT[ACT番号]で旁白的插し替え…`、
 *   `0039_雛/KOJO_K39.ERB:129` 的 `@KOJO_ACTなり@KOJO_REACT终了时に…`）：说明文字漏了 `;`
 *   被顶到行首，名字里带 `[`/`@`/整句假名，不是合法函数名 ⇒ null（也**不**算占位符——
 *   占位符形态要求 `KOJO_…_K{X|{…}|}` 恰好收尾，见口径 5）；
 * - **作者私有函数 519 处**：非 `KOJO_` 前缀的一切（`WARD_A_K14`／`PRINT_COMGRO_4_K14`／
 *   `FUNC_K13_CALLNAME`／`TV_EX_K14`／`COLOR_K14`／中文命名的 `性交奉仕拒绝处理_K14`…，
 *   以及口径 2 那批含 `KOJO` 字样的伪命中）。它们**带 `_K{数字}` 也不收**——
 *   本作路由只拼 `KOJO_` 前缀（`:793`），私有函数永远不可能被口上命中，
 *   收进家族会让函数树与条件矩阵多出几百个假面。
 */

import type { FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';
import { ERATOHOREVERSE } from './constants';

/**
 * 面（`FamilyMatch.face`）→ **中文**标签（游戏知识，只住本包）。
 * 语义出处 = 真盘各面定义上方的作者注释（`ERB/口上/EVENT_K.ERB` 与 `ERB/口上/0001_霊夢/KOJO_K1.ERB`
 * 模板注释），逐条见文件头「面标签」一节；未收录的面消费方原样显示 token。
 */
export const ERATOHOREVERSE_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  /* 系统 / 声明 */
  KOJO: '口上存在判定',
  COLOR: '口上配色',
  SETUP: '配置设定',
  SETUP_BONUS: '大满足奖励设定',
  DIGEST: '口上梗概（あらすじ）',
  ATTENTION: '注意事项',
  EXCLUSION: '排他判定',
  PRIORITY1: '优先口上判定（一）',
  PRIORITY2: '优先口上判定（二）',
  PRIORITY3: '优先口上判定（三）',
  RAND: '口上随机生成',
  /* 训练正文 */
  ACT: '动作口上',
  ACT_EXTRA: '追加动作口上',
  ACT_ASSI: '助手动作口上',
  REACT: '反应口上',
  REACTION_MESSAGE: '反应消息',
  COM: '指令口上',
  TRAIN_MESSAGE: '旁白口上',
  TRAIN_MESSAGE2: '反应旁白口上',
  TRAIN_MESSAGE_ANIME: '旁白动画效果',
  /* 事件 / 结局相关 */
  EVENT: '事件口上',
  EVENT_ASSI: '助手事件口上',
  /* 其它时机 */
  MARK: '刻印取得口上',
  DATUI: '脱衣口上',
  DATUI_ASSI: '助手脱衣口上',
  POSE: '姿势变化口上',
  USE: '媚药等使用口上',
});

/**
 * 立场 / 性别 / 优先层 token（本作的「家族段」词表）。
 * 全部来自 `EVENT_K.ERB` 的 `TRYCALLFORM KOJO_{层}_%ARGS%` 字面：
 * `MS`／`AS`（`:525/:528` 主人・追加调教者）、`SP`（`:294/:317` ＳＰ行动）、
 * `NO{数字}`（`:589` 玩家编号）、`MALE|TWIN|PENIS|FEMALE`（`:710-757` 性别指定）、
 * `MALEYOU|TWINYOU|PENISYOU|FEMALEYOU`（`:573-664` 性器指定）、
 * `PRI{1..3}`（`:519` 优先口上正文）、`Y1`（模板立场槽，见文件头）。
 * **不含任何语义面名**：`ACT`/`REACT`/`COM`… 永远留在 face，不会被这里吃掉。
 */
const STANCE_TOKENS: readonly string[] = Object.freeze([
  'MS',
  'AS',
  'SP',
  'Y1',
  'PRI1',
  'PRI2',
  'PRI3',
  'MALEYOU',
  'TWINYOU',
  'PENISYOU',
  'FEMALEYOU',
  'MALE',
  'TWIN',
  'PENIS',
  'FEMALE',
]);

/** `NO{数字}` 单独成形（玩家编号族；`NO9` 是实测唯一在用的档，号由名字给、不做枚举白名单） */
const NO_TOKEN_RE = /^NO\d+$/;

function isStanceToken(token: string): boolean {
  return STANCE_TOKENS.includes(token) || NO_TOKEN_RE.test(token);
}

/**
 * 入参 / 注释裁剪：Emuera 函数名不含空白、逗号、括号、分号，实盘存在
 * `@KOJO_RAND_K14(ARGS, ARG)` 与 `@KOJO_POSE_K14(ARG, ARG:1, ARG:2)` ⇒ 从首个分隔符整段裁掉。
 */
const TRAILING_JUNK_RE = /[\s,(;].*$/;

/** 主锚（贪婪末锚，口径 1）：`{head}_K{数字}[_{尾段}]` */
const ANCHORED_RE = /^(.*)_K(\d+)(?:_(.*))?$/i;

/** 模板化石（口径 5）：`_KXX`／`_K{対象}`／光杆 `_K` 收尾；**不**含 `KOJO_TRAIN_MESSAGE_K[…]…` 那类排版化石 */
const PLACEHOLDER_RE = /^(.*)_K(?:X{1,3}|\{[^}]*\})?(?:_(.*))?$/i;

/** 注释与假名混排的排版化石护栏：名字里出现这些字符即非合法 ERB 函数名（口径 6 第二类的判据） */
const NOT_A_NAME_RE = /[[\]@"，。・]/;

/**
 * 把锚点之前的 head 分成「家族段（立场层序列）+ 面」。
 * 立场层可以叠多层（`NO9_MS_…`），但**至少给 face 留一段**：
 * 剥到空就退回整段当 face，绝不交出空 face（空面在函数树里等于「其它」，是丢信息）。
 */
function splitStance(headUpper: string): { family: string; face: string } {
  // head 形如 `KOJO`／`KOJO_ACT`／`KOJO_NO9_MS_TRAIN_MESSAGE`：先剥掉域前缀那一段
  const rest = headUpper === 'KOJO' ? '' : headUpper.replace(/^KOJO_/, '');
  const parts = rest.split('_').filter((s) => s.length > 0);
  // head 恰为 `KOJO`（`KOJO_K1`）⇒ 无立场层、无面段，根面 `KOJO`（口上存在判定）
  if (parts.length <= 1) return { family: '', face: parts[0] ?? 'KOJO' };
  const stance: string[] = [];
  let i = 0;
  while (i < parts.length - 1 && isStanceToken(parts[i]!)) {
    stance.push(parts[i]!);
    i += 1;
  }
  const face = parts.slice(i).join('_');
  if (face.length === 0) return { family: '', face: parts.join('_') };
  return { family: stance.join('_'), face };
}

function make(p: {
  kind: FamilyParseKind;
  face: string;
  no: number | null;
  family?: string;
  slot?: string;
  selector?: number;
  placeholder?: boolean;
}): FamilyMatch {
  return Object.freeze({
    kind: p.kind,
    // 本作路由只拼 `KOJO_`（`:793`），prefix 恒为该域；家族维度由 family 承担
    prefix: 'KOJO',
    family: p.family ?? '',
    characterNo: p.no,
    selector: p.selector ?? 0,
    face: p.face,
    // 本作没有状态段/子面段：立场层在 family、尾段在 slot，sub 一律留空
    sub: '',
    // 本作没有 MESSAGECHECK 位协议
    isMessageCheck: false,
    slot: p.slot ?? '',
    isPlaceholder: p.placeholder ?? false,
  });
}

/**
 * 解析单个函数名（**纯函数**：只读入参与上面的词表）。
 *
 * @param filePath 可选文件来源。**只**用于给 `_KX` 占位符形态补回角色号
 *   （`…/REACT_04_羞恥_K14.ERB` → 14）；**不传 ⇒ 判定与旧版逐字一致**。
 *   本作路由完全不读路径（口径 1/2 的真盘依据），故除占位符外路径一律不参与判定。
 * @returns 与口上命名无关的函数返回 null（路由终端、引擎连写事件、作者私有函数、
 *   排版化石），绝不猜测。
 */
export function parseKojoFamily(rawName: string, filePath?: string): FamilyMatch | null {
  const trimmed = (rawName ?? '').replace(TRAILING_JUNK_RE, '');
  if (trimmed.length === 0) return null;
  // 只认 `KOJO_` 前缀域（口径 2：`ACT_ACTM_KOJO_CORRECTION_T` 一类伪命中在此就被挡掉）
  if (!/^KOJO_/i.test(trimmed)) return null;

  // 1) 带号形态
  const anchored = ANCHORED_RE.exec(trimmed);
  if (anchored) {
    const head = anchored[1]!;
    const no = Number.parseInt(anchored[2]!, 10);
    if (!Number.isFinite(no)) return null;
    const slot = (anchored[3] ?? '').replace(/^_/, '');
    // `KOJO_K{no}`：head 恰为 `KOJO` ⇒ 口上存在判定（声明形，对齐 plugin-api 的 'declare'）
    if (/^KOJO$/i.test(head)) {
      return make({ kind: 'declare', face: 'KOJO', no, slot, selector: 0 });
    }
    const { family, face } = splitStance(head.toUpperCase());
    return make({ kind: 'ok', face, family, no, slot });
  }

  // 2) 护栏：含 `[@…` 式 FORM 续行 / 方括号槽位 / 整句注释的，是排版化石而不是函数名（口径 6）
  if (NOT_A_NAME_RE.test(trimmed)) return null;

  // 3) 模板占位（`_KXX` / `_K{…}` / 光杆 `_K`）：形态合法、不归属角色
  const placeholder = PLACEHOLDER_RE.exec(trimmed);
  if (placeholder) {
    const head = placeholder[1]!;
    const slot = (placeholder[2] ?? '').replace(/^_/, '');
    if (!/^KOJO$/i.test(head)) {
      const { family, face } = splitStance(head.toUpperCase());
      return make({ kind: 'placeholder', face, family, no: null, slot, placeholder: true });
    }
    return make({ kind: 'placeholder', face: 'KOJO', no: null, slot, placeholder: true });
  }

  return null;
}

/**
 * 占位符形态按文件来源补回角色号（additive；非占位符 / 无路径 / 取不到号 ⇒ 原样返回）。
 * 逐个路径段试 `_K{数字}`（`REACT_04_羞恥_K14.ERB`、`KOJO_ACT_K1`、`限定無し_K14` 都在此列），
 * 与 `ERATOHOREVERSE.charaAnchor` 同判据，不做目录名号段解析。
 */
function alignPlaceholderToPath(match: FamilyMatch | null, filePath: string | undefined): FamilyMatch | null {
  if (!match || !match.isPlaceholder || filePath === undefined) return match;
  for (const rawSegment of filePath.split(/[\\/]/).reverse()) {
    const segment = rawSegment.replace(/\.[^.]*$/, '');
    const m = ERATOHOREVERSE.charaAnchor.exec(segment);
    if (m) {
      const no = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(no)) return Object.freeze({ ...match, characterNo: no });
    }
  }
  return match;
}

/**
 * 从函数名取角色号（与 `parseKojoFamily(...).characterNo` **同判据**，单独导出给
 * 「只要号」的消费方省一层结构）。
 *
 * 两类表现都要写清楚：
 * - `KOJO_COM_K1_12` / `KOJO_K1` → `1` / `1`（锚点是 `_K{数字}`，尾槽不影响取号）；
 * - 不带号的一律 null —— 包括路由终端 `KOJO_ACT`、模板化石 `KOJO_REACT_KXX_44`
 *   （占位符：形态合法但不归属角色）、作者私有 `WARD_A_K14`（带 `_K{数字}` 也不给号：
 *   本作路由只拼 `KOJO_`，私有函数的号不是家族归属）。
 */
export function characterNoOfFunction(fnName: string): number | null {
  return parseKojoFamily(fnName)?.characterNo ?? null;
}

/** 构造 eratohoReverse 家族识别规则（供 `GameAdapter.functionFamilyIndex` 使用） */
export function createEratohoreverseFamilyIndex(): FamilyIndexRule {
  return {
    name: 'eratohoreverse-family-index',
    match(fnName: string, filePath?: string): FamilyMatch | null {
      return alignPlaceholderToPath(parseKojoFamily(fnName), filePath);
    },
    faceLabels: ERATOHOREVERSE_FACE_LABELS,
    // 只有 COM 的尾槽是引擎指令号（`SELECTCOM` ↔ `CSV/Train.csv`）；
    // ACT/REACT/TRAIN_MESSAGE 的尾槽是 TFLAG:ACT 动作号，列进去会让条件矩阵凭空造列 ⇒ 不列。
    instructionFaces: ['COM'],
  };
}
