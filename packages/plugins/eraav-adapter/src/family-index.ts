/**
 * eraAV 函数家族识别规则（`FamilyIndexRule` 实现）—— **全部 eraAV 领域知识只住本包**。
 *
 * ## 命名体系：三种形态并存（既非 eraTW 中缀 `M_KO_K{n}_{家族}`，也非 eratohok 纯后缀 `_K{n}`）
 *
 * 真盘实测（`C:/game/eraAV`，2026-10-26；口上域 `ERB/Lines/` 17 份扁平 `.ERB`）：
 *
 * ```
 * KOJO_MESSAGE_COM_{1}          ← 指令口上（裸尾号，**无 K**；17 个定义）
 * KOJO_MESSAGE_PALAMCNG_{1}     ← 状态变化口上（16 个；30 号角色缺）
 * KOJO_MESSAGE_MARKCNG_{1}      ← 刻印变化口上（16 个；30 号角色缺）
 * SELF_KOJO_K{10}               ← 自慰口上（带 K；16 个）
 * SINGLE_ENDING_K{10}           ← 单体结局（带 K；真盘 0 个正体定义，16 处全部被 `;@` 注释）
 * KOJO_LESPLAY_{n}              ← 百合玩法（主路由 `EVENT_K.ERB:96` 驱动；真盘 0 定义）
 * KOJO_NTR_STAFF_{n}            ← NTR 职员（主路由 `EVENT_K.ERB:102` 驱动；真盘 0 定义）
 * K{01}_KOJO2                   ← 作者工具族（**前缀 + 零填充**，17 个定义；脏名实例 `EVENT_K10_桐生歌音.ERB:335`、`EVENT_K30_文野柚香.ERB:224,341`）
 * ```
 *
 * ## 覆盖率读数（P1 验收物，由 `tests/family-index.test.ts` 真盘闸逐行复核）
 *
 * `ERB/Lines/` 17 份文件、行首 `@` 定义共 **150** 个；`parseKojoFamily` 命中 **82 / 150 = 54.7%**。
 * 未命中 68 个**全部**是引擎钩子 `@EVENTTRAIN`（34）与 `@EVENTEND`（34）——每角色文件各定义两次
 * （第一次 `#PRI` 存在判定、第二次正体 `SIF NO:TARGET != n RETURN 0`），是训练循环的引擎入口、
 * **不是口上家族**，家族索引有意不收（收了会把引擎钩子算进每个角色的口上面）。
 * 真盘 150 个定义里没有第三种未命中形态（`xingxuandelei加笔…` 这类 `@` 出现在 `;` 注释行行中，
 * 定义抽取正则 `^\s*@` 天然不取）。
 *
 * ## 五条解析口径
 *
 * 1. **「缺定义」是本盘常态，不是装载错误**：`SINGLE_ENDING_K{n}`／`KOJO_LESPLAY_{n}`／
 *    `KOJO_NTR_STAFF_{n}` 真盘 0 正体定义（主路由照样 TRYCALLFORM），30 号角色缺
 *    SELF/PALAMCNG/MARKCNG ⇒ 规则只按**形态**裁决，绝不假设齐族、也绝不为凑齐编造家族
 *    （面清单 = 主路由 `EVENT_K.ERB` 逐行给实的驱动面，多一个都不收）。
 * 2. **脏名先剥尾再接正则**：实盘存在 `@K10_KOJO2 ;因为是歌音的番号是10…`、
 *    `@KOJO_MESSAGE_COM_30 ;因为是由加子的番号是45…`（注释里的号与实号**矛盾**）
 *    ⇒ 从首个空白 / `;` / `,` / `(` 起整段裁掉后再判，注释里的数字永远进不了 `characterNo`。
 * 3. **号只认函数名，不认文件名**：`EVENT_K01_宮間かなで.ERB:384` 定义的是
 *    `KOJO_MESSAGE_COM_1` 一类尾号，工具族却写零填充前缀 `@K01_KOJO2` ⇒ `filePath`
 *    参数保留（对齐契约 additive 第二参）但**不参与判定**。
 * 4. **伪家族一律 null**：`EVENTTRAIN`／`EVENTEND`（引擎钩子）、`EVENT_SEITSU`／
 *    `BLACKGIRL_EVENT` 等 48 个 `EVENT` 打头的作者助手、`MAEKOJO_LESPLAY`／`MAEKOJO_NTR_STAFF`
 *    （全局兜底、无角色号）、无前号的裸路由 `KOJO_MESSAGE_COM` ⇒ 白名单形态之外的名字
 *    不硬塞角色（fail-visible，不猜）。
 * 5. **`K{n}_KOJO2` 判 `kind:'kn'`**：与契约 `FamilyParseKind` 的「`K{n}_` 前缀私货形态」
 *    逐字同义（eraTW 先例），零填充 `K01` 与非填充 `K1` 归一为同一个号（`parseInt`）。
 *
 * ## 指令承载面裁决：**不声明 `instructionFaces`**
 *
 * 全盘 2,279 个 `@` 定义里形如 `_{号}_{指令号}` 的指令号尾槽 **0 个**（2026-10-26 实测）；
 * 指令分流在函数体内 `IF SELECTCOM == 0 …` 长链（`EVENT_K01_宮間かなで.ERB:398-431`）。
 * eraTW 的「一指令一拆函数」模型在本作**没有对应物**——声明 `instructionFaces` 会让条件
 * 矩阵把 `MESSAGE_COM` 拆成一堆不存在的列，故留空（整面成列）。
 */

import type { FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';

/** 面 → 中文标签（游戏知识，只住本包）。未收录的面消费方原样显示 token。 */
export const ERAAV_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  MESSAGE_COM: '指令口上',
  MESSAGE_PALAMCNG: '状态变化口上',
  MESSAGE_MARKCNG: '刻印变化口上',
  SELF_KOJO: '自慰口上',
  SINGLE_ENDING: '单体结局',
  LESPLAY: '百合玩法',
  NTR_STAFF: 'NTR职员口上',
  KOJO2: '口上2.0追加',
});

/**
 * 入参 / 注释裁剪：真盘定义行存在 `@K10_KOJO2 ;中文注释`、`@KOJO_LESPLAY,ARG,ARG:1`
 * （形参表紧贴名字）两类脏形 ⇒ 从首个空白 / `;` / `,` / `(`（含全角括号、全角逗号）起整段裁掉。
 */
const TRAILING_JUNK_RE = /[\s,(;（，].*$/;

/** 主族裸尾号：`KOJO_MESSAGE_{COM|PALAMCNG|MARKCNG}_{角色号}`（**无 K**，本盘最难认的一条） */
const MESSAGE_TAIL_RE = /^KOJO_MESSAGE_(COM|PALAMCNG|MARKCNG)_(\d+)$/i;

/** 主路由驱动的其它裸尾号面：`KOJO_{LESPLAY|NTR_STAFF}_{角色号}`（真盘 0 定义，形态有路由实证） */
const KOJO_TAIL_RE = /^KOJO_(LESPLAY|NTR_STAFF)_(\d+)$/i;

/** 自慰口上：`SELF_KOJO_K{角色号}`（带 K） */
const SELF_RE = /^SELF_KOJO_K(\d+)$/i;

/** 单体结局：`SINGLE_ENDING_K{角色号}`（带 K；真盘定义全被 `;@` 注释，形态仍合法） */
const SINGLE_RE = /^SINGLE_ENDING_K(\d+)$/i;

/** 作者工具族：`K{零填充角色号}_KOJO2`（前缀形态 → 契约 `kind:'kn'`） */
const KN_KOJO2_RE = /^K(\d+)_KOJO2$/i;

function make(p: {
  kind: FamilyParseKind;
  prefix: string;
  face: string;
  no: number | null;
}): FamilyMatch {
  return Object.freeze({
    kind: p.kind,
    prefix: p.prefix,
    // 本作没有 NTR 一类并列家族维度；家族恒空，语义全部由面承载
    family: '',
    characterNo: p.no,
    selector: 0,
    face: p.face,
    sub: '',
    isMessageCheck: false,
    slot: '',
    isPlaceholder: false,
  });
}

/**
 * 解析单个函数名（**纯函数**：只读入参与模块常量表）。
 *
 * @param filePath 可选文件来源；本作号只认函数名（文件名号 ≠ 函数号，见文件头口径 3），
 *   参数保留仅为对齐 `FamilyIndexRule.match` 的 additive 第二参。
 * @returns 非白名单形态（`EVENTTRAIN` / `EVENTEND` / `EVENT_*` 助手 / `MAEKOJO_*` /
 *   无前号裸路由）返回 null，绝不猜测。
 */
export function parseKojoFamily(rawName: string, filePath?: string): FamilyMatch | null {
  void filePath; // 本作用：路径不参与判定（不删参数是对齐契约签名）
  const trimmed = (rawName ?? '').replace(TRAILING_JUNK_RE, '');
  if (trimmed.length === 0) return null;

  let m = MESSAGE_TAIL_RE.exec(trimmed);
  if (m) return make({ kind: 'ok', prefix: 'KOJO', face: `MESSAGE_${m[1]!.toUpperCase()}`, no: Number.parseInt(m[2]!, 10) });

  m = KOJO_TAIL_RE.exec(trimmed);
  if (m) return make({ kind: 'ok', prefix: 'KOJO', face: m[1]!.toUpperCase(), no: Number.parseInt(m[2]!, 10) });

  m = SELF_RE.exec(trimmed);
  if (m) return make({ kind: 'ok', prefix: 'SELF', face: 'SELF_KOJO', no: Number.parseInt(m[1]!, 10) });

  m = SINGLE_RE.exec(trimmed);
  if (m) return make({ kind: 'ok', prefix: 'SINGLE', face: 'SINGLE_ENDING', no: Number.parseInt(m[1]!, 10) });

  m = KN_KOJO2_RE.exec(trimmed);
  if (m) return make({ kind: 'kn', prefix: '', face: 'KOJO2', no: Number.parseInt(m[1]!, 10) });

  return null;
}

/**
 * 从函数名取角色号（三形态通用；解析不出返回 null）。
 * 与 `parseKojoFamily(...).characterNo` 同判据，单独导出给「只要号」的消费方省一层结构。
 */
export function characterNoOfFunction(fnName: string): number | null {
  return parseKojoFamily(fnName)?.characterNo ?? null;
}

/** 构造 eraAV 家族识别规则（供 `GameAdapter.functionFamilyIndex` 使用） */
export function createEraavFamilyIndex(): FamilyIndexRule {
  return {
    name: 'eraav-family-index',
    match(fnName: string, filePath?: string): FamilyMatch | null {
      return parseKojoFamily(fnName, filePath);
    },
    faceLabels: ERAAV_FACE_LABELS,
    // 无 instructionFaces：本作指令分流在函数体 IF SELECTCOM 链里，一指令一函数不存在（见文件头裁决）
  };
}
