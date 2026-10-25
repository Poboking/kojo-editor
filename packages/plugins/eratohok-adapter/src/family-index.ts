/**
 * eratohoK 函数家族识别规则（`FamilyIndexRule` 实现）—— **全部 eratohoK 领域知识只住本包**。
 *
 * ## 命名体系：`KOJO_{面}[_{状态}]_K{角色号}[_{口上号}]` + `KOJO_DAILY_K{n}_{事件名}`
 *
 * 全量实测（`ERB/口上` 694 份 / 2,413 个 `KOJO_` 函数定义，2026-10-25；
 * `D:/game/eratohoK`）：
 *
 * ```
 * KOJO_TRAIN_START_K1                       ← 训练开始（158 处，状态无关形）
 * KOJO_TRAIN_START_A1_K1                    ← 训练开始（KOJO_STATE= A1：会いに行く）
 * KOJO_TRAIN_START_A1_K1_3                  ← 同上 + 口上号（CFLAG:2999 的尾段）
 * KOJO_TRAIN_END_K1                         ← 训练结束（158 处）
 * KOJO_EXIST_K1                             ← 口上存在判定（118 处）
 * KOJO_COM_BEFORE_K1                        ← 指令前（29 处）
 * KOJO_COM_BEFORE_TARGET_K1                 ← 指令前·对象侧（84 处）
 * KOJO_COM_BEFORE_PLAYER_K1                 ← 指令前·主角侧（84 处）
 * KOJO_COM_K1                               ← 指令（75 处）
 * KOJO_COM_TARGET_K1 / KOJO_COM_PLAYER_K1   ← 指令·两侧（109 / 108 处）
 * KOJO_COM_AFTER_K1                         ← 指令后（113 处）
 * KOJO_COM_THIRD_*_K1                       ← 第三者介入（各 2 处）
 * KOJO_EVENT_K1(ARG)                        ← 事件（39 处；事件号走**实参**，不进函数名）
 * KOJO_SINGLE_ENDING_K1 / KOJO_DEAD_ENDING_K1   ← 结局（39 / 38 处）
 * KOJO_DAILY_K1_NAUGHTY_MAIDEN              ← 每日事件正文（310 个家族）
 * KOJO_DAILY_K1_NAUGHTY_MAIDEN_RATE         ← 同一事件的触发率 / 判定 / 分类 / 目标
 * DATE_EVENT_K134(場所) / DATE_EVENT_K134_mizuumi(湖)   ← 约会事件（20 个定义）
 * SEXVOICE_TARGET_K141 / SEXVOICE_PLAYER_K141           ← 性行为语音（独立族）
 * ```
 *
 * ## 五条解析口径（都由真盘倒推，宁可不标也不标错）
 *
 * 1. **`_K` 之后必须是数字**：`_KXXX`（`_KOJO_PATTERN.ERB` 的模板占位）与
 *    `_K{対象NO}`（分派器里的占位）标 `isPlaceholder`、`characterNo = null`；
 *    其余解析不出的一律返回 null（`KOJO_HAIR_NAME` / `KOJO_ASK_RESET` 这类无号
 *    公共函数不硬塞角色）。
 * 2. **状态段只认单字母 + 可选数字**（`A` / `B` / `C` / `A1` / `A2`）：来源是
 *    `_KOJO_SYSTEM.ERB:22 @KOJO_STATE`，它按 `FLAG:調教モード` 返回
 *    `A1|A2|A3|A4|B|C|D`（明细形）或 `A|B|C|D`（分组形）。`_TARGET` / `_BEFORE`
 *    这类多字母段是**面名的一部分**，不是状态段。
 * 3. **`DAILY` 是先判的特殊族**：`KOJO_DAILY_K{n}_{事件名}[_RATE|_DECISION|_GENRE|_SETTARGET]`，
 *    事件名大小写混排（`Industrialization` / `Moonshine_Wine`）⇒ 大小写不敏感匹配，
 *    `slot` 保留原样（作者看得懂的那个名字）。
 * 4. **事件号不进函数名**：`KOJO_EVENT_K{n}` 的事件号由 `TRYCALLFORM …(ARG:1)` 传入
 *    ⇒ 本作**没有**「事件号写进函数名」的形态，家族解析也不编一个。
 * 5. **`DATE_EVENT` / `SEXVOICE` 不是 `KOJO_` 前缀族**，但同样按角色号路由
 *    （`_KOJO_SYSTEM.ERB:928 TRYCCALLFORM DATE_EVENT_K{LOCAL:5}`），单独收成面。
 *
 * ## 面 token 与指令承载面
 *
 * 本作**没有**「一条指令一个函数」的命名形态：分派器只按目标号拼 `KOJO_COM_K{n}`，
 * 具体指令在函数体内用 `SELECTCASE SELECTCOM` 展开 ⇒ **不声明 `instructionFaces`**
 * （声明了会让条件矩阵把整面拆成不存在的列）。
 */

import type { FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';

/** 面 → 中文标签（游戏知识，只住本包）。未收录的面消费方原样显示 token。 */
export const ERATOHOK_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  TRAIN_START: '训练开始',
  TRAIN_END: '训练结束',
  EXIST: '存在判定',
  COM_BEFORE: '指令前',
  COM_BEFORE_TARGET: '指令前·对象侧',
  COM_BEFORE_PLAYER: '指令前·主角侧',
  COM: '指令',
  COM_TARGET: '指令·对象侧',
  COM_PLAYER: '指令·主角侧',
  COM_AFTER: '指令后',
  COM_AFTER_TARGET: '指令后·对象侧',
  COM_AFTER_PLAYER: '指令后·主角侧',
  COM_THIRD: '第三者指令',
  COM_THIRD_BEFORE: '第三者指令前',
  COM_THIRD_AFTER: '第三者指令后',
  COM_THIRD_TARGET: '第三者指令·对象侧',
  COM_THIRD_PLAYER: '第三者指令·主角侧',
  COM_THIRD_BEFORE_TARGET: '第三者指令前·对象侧',
  COM_THIRD_BEFORE_PLAYER: '第三者指令前·主角侧',
  COM_THIRD_AFTER_TARGET: '第三者指令后·对象侧',
  COM_THIRD_AFTER_PLAYER: '第三者指令后·主角侧',
  COM_NAME_TARGET: '指令名·对象侧',
  COM_NAME_PLAYER: '指令名·主角侧',
  COM_CHECK: '指令可执行判定',
  EVENT: '事件',
  DAILY: '每日事件',
  DAILY_HOOK: '每日事件钩子',
  DATE_EVENT: '约会事件',
  SEXVOICE: '性行为语音',
  SINGLE_ENDING: '单结局',
  DEAD_ENDING: '死亡结局',
  ASK: '提问',
  ASK_RESET: '提问重置',
  DESCRIPTION_CHARA: '角色说明',
  HAIR_NAME: '发型名',
  TRAIN: '训练',
});

/**
 * 入参 / 注释裁剪：Emuera 函数名不含逗号、空白、括号，实盘存在
 * `@KOJO_EVENT_K30(ARG)` 与 `@KOJO_STATE(ARG:0 = 0)` 形态 ⇒ 从首个分隔符起整段裁掉。
 */
const TRAILING_JUNK_RE = /[\s,(;].*$/;

/** `KOJO_DAILY_K{no}_{事件名}[_{尾段}]`（事件名大小写混排，非贪婪 + 已知尾段锚） */
const DAILY_RE = /^KOJO_DAILY_K(\d+)_(.+?)(?:_(RATE|DECISION|GENRE|SETTARGET|NAME|ALLOW_WHEN_WANDERING))?$/i;

/** `DATE_EVENT_K{no}[_{场所}]` */
const DATE_EVENT_RE = /^DATE_EVENT_K(\d+)(?:_(.+))?$/i;

/** `SEXVOICE_{TARGET|PLAYER}_K{no}` */
const SEXVOICE_RE = /^SEXVOICE_(TARGET|PLAYER)_K(\d+)$/i;

/** 每日事件的引擎钩子：`EVENTTRAIN_KOJO_DAILY_K{no}_{事件名}` / `EVENTEND_…` */
const DAILY_HOOK_RE = /^(EVENTTRAIN|EVENTEND)_(KOJO_DAILY_K\d+_.+)$/i;

/** 占位令牌：`XXX`（模板文件）/ `{…}`（分派器里的表达式，如 `{対象NO}`） */
const PLACEHOLDER_TOKEN = '(?:XXX|\\{[^}]*\\})';

/** 占位形态（通用）：`KOJO_{面}_K<占位>` */
const PLACEHOLDER_RE = new RegExp(`^KOJO_(.+?)_K${PLACEHOLDER_TOKEN}$`, 'i');

/** 占位形态（每日事件）：`KOJO_DAILY_K<占位>_{事件名}[_{尾段}]` */
const DAILY_PLACEHOLDER_RE = new RegExp(
  `^KOJO_DAILY_K${PLACEHOLDER_TOKEN}_(.+?)(?:_(RATE|DECISION|GENRE|SETTARGET|NAME|ALLOW_WHEN_WANDERING))?$`,
  'i',
);

/** 通用锚：`KOJO_{面}_K{数字}`（`.+?` 惰性 + 末尾 `_K数字` 锚，取**最后**一个锚点） */
const GENERIC_RE = /^KOJO_(.+?)_K(\d+)$/i;

/**
 * 带口上号尾段的形态：`KOJO_{面}[_{状态}]_K{角色号}_{口上号}`。
 *
 * 来源 `_KOJO_SYSTEM.ERB:123`：`TRYCALLFORM KOJO_TRAIN_START_K{LOCAL:5}_{CFLAG:(LOCAL:5):2999}`
 * ——`CFLAG:2999` 是「该角色使用第几套口上」的每角色槽位。
 * **真盘 0 个定义**（这一档口上作者普遍没写，分派器另有 `IF CFLAG:2999` 守卫），
 * 但形态合法、魔改会用到 ⇒ 解析出来（`slot` = 尾段），不留给「认不出」。
 */
const TAIL_RE = /^KOJO_(.+?)_K(\d+)_(\d+)$/i;

/** 状态段：单字母 + 可选数字（`A` / `A1` / `B` / `C2`） */
const VARIANT_RE = /^(.*?)_([A-Z]\d*)$/;

function make(p: {
  prefix: string;
  face: string;
  no: number | null;
  sub?: string;
  slot?: string;
  placeholder?: boolean;
}): FamilyMatch {
  return Object.freeze({
    kind: 'ok' as FamilyParseKind,
    prefix: p.prefix,
    // 本作没有 NTR 一类并列家族；家族维度恒空，面负责区分语义
    family: '',
    characterNo: p.no,
    selector: 0,
    face: p.face,
    sub: p.sub ?? '',
    isMessageCheck: false,
    slot: p.slot ?? '',
    isPlaceholder: p.placeholder ?? false,
  });
}

/** 面名 → token：剥掉 `KOJO_` 前缀；`KOJO` 单独出现时是口上根面 */
function faceOf(head: string): string {
  const h = head.toUpperCase();
  if (h === 'KOJO') return 'KOJO';
  return h.startsWith('KOJO_') ? h.slice('KOJO_'.length) : h;
}

/**
 * 解析单个函数名（**纯函数**：只读入参与模块常量表）。
 *
 * @param filePath 可选文件来源；本作的路由只认函数名里的 `_K{n}`，文件路径不参与判定
 *   （保留签名以对齐 `FamilyIndexRule.match` 的 additive 第二参）。
 * @returns 与口上命名无关的函数返回 null（`KOJO_HAIR_NAME` / `KOJO_ASK_RESET` /
 *   `CREATE_KOJO_DAILY_MAP_K1` 一类助手），绝不猜测。
 */
export function parseKojoFamily(rawName: string, _filePath?: string): FamilyMatch | null {
  const trimmed = (rawName ?? '').replace(TRAILING_JUNK_RE, '');
  if (trimmed.length === 0) return null;

  // 1) 每日事件钩子（引擎在 EVENTTRAIN/EVENTEND 里按日名回调）
  const hook = DAILY_HOOK_RE.exec(trimmed);
  if (hook) {
    const inner = /^KOJO_DAILY_K(\d+)_(.+)$/i.exec(hook[2]!);
    if (inner) {
      return make({
        prefix: 'KOJO',
        face: 'DAILY_HOOK',
        no: Number.parseInt(inner[1]!, 10),
        slot: inner[2]!,
      });
    }
  }

  // 2) 每日事件族（先于通用族：事件名里可能含 `_RATE` 之外的任意段）
  const dailyPlaceholder = DAILY_PLACEHOLDER_RE.exec(trimmed);
  if (dailyPlaceholder) {
    return make({
      prefix: 'KOJO',
      face: 'DAILY',
      no: null,
      slot: dailyPlaceholder[1]!,
      sub: (dailyPlaceholder[2] ?? '').toUpperCase(),
      placeholder: true,
    });
  }
  const daily = DAILY_RE.exec(trimmed);
  if (daily) {
    return make({
      prefix: 'KOJO',
      face: 'DAILY',
      no: Number.parseInt(daily[1]!, 10),
      slot: daily[2]!,
      sub: (daily[3] ?? '').toUpperCase(),
    });
  }

  // 3) 约会事件（非同前缀族，但按角色号路由）
  const date = DATE_EVENT_RE.exec(trimmed);
  if (date) {
    return make({
      prefix: 'DATE',
      face: 'DATE_EVENT',
      no: Number.parseInt(date[1]!, 10),
      slot: date[2] ?? '',
    });
  }

  // 4) 性行为语音（同上）
  const voice = SEXVOICE_RE.exec(trimmed);
  if (voice) {
    return make({
      prefix: 'SEXVOICE',
      face: 'SEXVOICE',
      no: Number.parseInt(voice[2]!, 10),
      sub: voice[1]!.toUpperCase(),
    });
  }

  if (!/^KOJO_/i.test(trimmed)) return null;

  // 5) 模板占位（`_KXXX` / `_K{対象NO}`）：不归属任何角色，但形态合法
  const placeholder = PLACEHOLDER_RE.exec(trimmed);
  if (placeholder) {
    const head = placeholder[1]!;
    const v = VARIANT_RE.exec(head.toUpperCase()) ? VARIANT_RE.exec(head)! : null;
    return make({
      prefix: 'KOJO',
      face: faceOf(v ? v[1]! : head),
      no: null,
      sub: v ? v[2]! : '',
      placeholder: true,
    });
  }

  // 6) 带口上号尾段：`KOJO_…_K{角色号}_{口上号}`
  const tail = TAIL_RE.exec(trimmed);
  if (tail) {
    const head = tail[1]!;
    const variant = VARIANT_RE.exec(head);
    return make({
      prefix: 'KOJO',
      face: faceOf(variant ? variant[1]! : head),
      no: Number.parseInt(tail[2]!, 10),
      sub: variant ? variant[2]! : '',
      slot: tail[3]!,
    });
  }

  // 7) 通用 `KOJO_{面}[_{状态}]_K{角色号}`
  const m = GENERIC_RE.exec(trimmed);
  if (!m) return null;
  const head = m[1]!;
  const variant = VARIANT_RE.exec(head);
  return make({
    prefix: 'KOJO',
    face: faceOf(variant ? variant[1]! : head),
    no: Number.parseInt(m[2]!, 10),
    sub: variant ? variant[2]! : '',
  });
}

/** 构造 eratohoK 家族识别规则（供 `GameAdapter.functionFamilyIndex` 使用） */
export function createTohokFamilyIndex(): FamilyIndexRule {
  return {
    name: 'eratohok-family-index',
    match(fnName: string, filePath?: string): FamilyMatch | null {
      return parseKojoFamily(fnName, filePath);
    },
    faceLabels: ERATOHOK_FACE_LABELS,
    // 无 instructionFaces：本作指令口上是单函数内 SELECTCOM 展开，不是一指令一函数
  };
}
