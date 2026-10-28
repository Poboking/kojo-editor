/**
 * 封存层（kojo1）**首次打开说明**（LAU-3b，2026-10-27）。
 *
 * ## 为什么要有这一条
 *
 * `2.0-default` 档下 kojo1 被封存：`.kojo1` 新开时落 `plaintext`——没有高亮、
 * 没有结构面、没有诊断，`.kojo 预览` 也停用。今天这件事只写在状态栏语言菜单那一行，
 * 作者打开一份旧文件看到的是"一整块白字"，很容易以为是编辑器坏了（真壳体感反馈）。
 *
 * 所以第一次遇到时给一条**可执行**的说明：说清"这是封存，不是损坏"，并给一个直达设置页
 * 的按钮。只讲一次（`localStorage` 台账），之后不再打扰；改档、重载都算作者自己的决定。
 *
 * ## 判据
 *
 * - 路径是 kojo1 源（`.kojo1`，取契约层的 `KOJO_V1_SOURCE_EXTENSIONS`）；
 * - 此刻 kojo1 **封存关闭**；
 * - 这份 model 的语言确实是 `plaintext`；
 * - 本窗口还没说过。
 *
 * 无 `window`（node 测试 / 非浏览器）⇒ 视作已说过（`true`），绝不弹。
 */
import { KOJO_SOURCE_EXTENSION, KOJO_V1_SOURCE_EXTENSIONS } from '@kojo/plugin-api';
import type { Kojo2SourceFlavor } from './kojo2-cutover';

/** 已说明台账的存储键（版本化：文案换代时可重新问一次） */
export const LEGACY_SEALED_NOTICE_KEY = 'kojo.ui.legacySealedNotice.v1';

/** localStorage 访问器（隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 是否已经说明过（无 window ⇒ true） */
export function loadLegacySealedNoticePrompted(): boolean {
  const s = storage();
  if (s === null) return true;
  try {
    return s.getItem(LEGACY_SEALED_NOTICE_KEY) === '1';
  } catch {
    return true;
  }
}

/** 记下"已说明"（写不进去不算错：大不了下次再提示一次） */
export function markLegacySealedNoticePrompted(): void {
  const s = storage();
  if (s === null) return;
  try {
    s.setItem(LEGACY_SEALED_NOTICE_KEY, '1');
  } catch {
    /* 隐私模式 / 配额满：本次提示仍有效 */
  }
}

/** 测试用：清掉台账（生产代码不调用） */
export function resetLegacySealedNoticePrompted(): void {
  const s = storage();
  if (s === null) return;
  try {
    s.removeItem(LEGACY_SEALED_NOTICE_KEY);
  } catch {
    /* 同上 */
  }
}

export interface LegacySealedNoticeInput {
  readonly path: string;
  /** 这份 model 实际的 Monaco 语言 id */
  readonly languageId: string;
  /** kojo1 此刻可用吗（`isKojoLegacySyntaxEnabled()`） */
  readonly legacyOn: boolean;
  /** 本窗口已经说明过吗 */
  readonly prompted: boolean;
}

/** 是否该弹这一条（纯函数；判定顺序 = 从便宜到贵，全部命中才 true） */
export function shouldExplainLegacySealedOpen(input: LegacySealedNoticeInput): boolean {
  if (input.legacyOn || input.prompted) return false;
  if (input.languageId !== 'plaintext') return false;
  const lower = input.path.toLowerCase();
  return KOJO_V1_SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 作者面文案（标题 / 正文各一份；调用方原样上屏，不自己拼） */
export const LEGACY_SEALED_NOTICE_TITLE = 'kojo1 已封存，这份文件按纯文本打开';

export const LEGACY_SEALED_NOTICE_MESSAGE =
  '这是一份命令式旧写法（kojo1）的文件。kojo1 已封存且默认关闭，所以现在没有高亮、诊断和「.kojo 预览」；文件本身没有被改动。要按旧语法查看或编辑，到设置 →「Kojo 2.0 档位」选「双轨」或「只认 v1」，并按提示重开项目或重载窗口。长期更推荐用「Kojo 2.0 迁移向导」把它改成 2.0 写法。';

/* ============================== `.kojo` 仍是旧写法 ============================== */

/**
 * LAU-3b-FLIP 的另一半：`.kojo` 当场归了 2.0，但盘上大量老文件还叫 `.kojo`、内容仍是
 * v1 写法——按 2.0 打开会满屏报错，作者同样会以为编辑器坏了。这一条在**首次打开**时
 * 说清"文件没坏、是写法没迁"，并给两条可执行出路（迁移向导 / 改名回 .kojo1）。
 *
 * 判据与改名工具**同一枚**：`fingerprintKojo2Source` 判 `v1` 才算（`kojo2` / `ambiguous` /
 * `empty` 都不弹——"拿不准"不打扰作者）。台账独立于封存说明，各自只讲一次。
 */
export const LEGACY_KOJO_V1_CONTENT_NOTICE_KEY = 'kojo.ui.legacyKojoV1ContentNotice.v1';

export function loadLegacyKojoV1ContentNoticePrompted(): boolean {
  const s = storage();
  if (s === null) return true;
  try {
    return s.getItem(LEGACY_KOJO_V1_CONTENT_NOTICE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markLegacyKojoV1ContentNoticePrompted(): void {
  const s = storage();
  if (s === null) return;
  try {
    s.setItem(LEGACY_KOJO_V1_CONTENT_NOTICE_KEY, '1');
  } catch {
    /* 隐私模式 / 配额满：本次提示仍有效 */
  }
}

/** 测试用：清掉台账（生产代码不调用） */
export function resetLegacyKojoV1ContentNoticePrompted(): void {
  const s = storage();
  if (s === null) return;
  try {
    s.removeItem(LEGACY_KOJO_V1_CONTENT_NOTICE_KEY);
  } catch {
    /* 同上 */
  }
}

export interface LegacyKojoV1ContentNoticeInput {
  readonly path: string;
  /** `fingerprintKojo2Source(...).flavor`（与改名工具同一判据） */
  readonly flavor: Kojo2SourceFlavor;
  /** 本窗口已经说明过吗 */
  readonly prompted: boolean;
}

/**
 * 是否该弹这一条（纯函数；`.kojo1` 不在内——那是封存说明的另一条）。
 *
 * 不查 model 语言：`.kojo` 的 descriptor 无条件登记（任何档位都挂 `kojo2`），
 * 路径判完就够了；这样也让本模块不碰语言 id 名单（`audit:language` 的 M2 棘轮）。
 */
export function shouldExplainLegacyKojoV1Content(
  input: LegacyKojoV1ContentNoticeInput,
): boolean {
  if (input.prompted) return false;
  if (input.flavor !== 'v1') return false;
  return input.path.toLowerCase().endsWith(KOJO_SOURCE_EXTENSION);
}

export const LEGACY_KOJO_V1_CONTENT_NOTICE_TITLE = '这份 .kojo 还是旧写法（kojo1）';

export const LEGACY_KOJO_V1_CONTENT_NOTICE_MESSAGE =
  '`.kojo` 现在归 2.0，按 2.0 读这份旧写法会满屏报错（文件本身没有被改动）。两条出路：用「Kojo 2.0 迁移向导」把内容改成 2.0；或者用「把旧 .kojo 改名为 .kojo1」让它回到封存的 kojo1（只改文件名，逐份先备份）。';
