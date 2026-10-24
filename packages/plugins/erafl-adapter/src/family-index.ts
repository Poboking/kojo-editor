/**
 * eraFL 函数家族识别规则（`FamilyIndexRule` 实现）—— **全部 eraFL 领域知识只住本包**。
 *
 * ## 命名体系：后缀式 `{家族}_K{编号}`
 *
 * eraFL 的口上主形态是 XML，ERB 里只剩**注册壳函数**（`@KOJO_DEFINE_K1099` 内
 * `CALL KOJO_XML_REGISTER(...)` 把 XML 挂进引擎）。故家族集合是**固定五族**：
 *
 * ```
 * KOJO_DEFINE_K1099              ← 口上注册（135 处实测）
 * KOJO_DEFINE_NAME_K1099         ← 口上选择画面的显示名（96）
 * KOJO_FOR_MALE_K1099            ← 男性主角是否可用（26）
 * KOJO_FOR_FEMALE_K1099          ← 女性主角是否可用（26）
 * KOJO_DEFINE_KOJO_INFO_K1099    ← 口上信息（示例台词 / 特征，96）
 * ```
 *
 * ## 三条形态事实（决定本文件为什么这么短）
 *
 * 1. **head 本身就是家族**：eraAkumaMaid 的 head 是「面」（`KOJO_MESSAGE_COM_K1`），
 *    本游戏没有面这一层 ⇒ 家族表穷举即可，不需要回退链 / 面 token 表。
 * 2. **无 KX 占位符**：全树实测 0 处 `_KX{n}`（新角色模板包机制在 eraFL 不存在）。
 * 3. **无指令号尾槽**：口上按 XML 节点组织，`{i}` 指令号不进函数名 ⇒
 *    `instructionFaces` 显式声明为空数组（"本游戏无此概念"，消费方据此不细分）。
 *
 * ## 尾段口径
 *
 * `_K{n}` 之后若还有 `_{尾段}`（实盘未见于五族，但魔改可能追加），**不影响家族判定**：
 * 家族段已经写在名字最前面，尾段只是作者私货后缀，不能因此丢掉归属；尾段原样进
 * `FamilyMatch.slot` 供导航显示（信息不丢）。
 *
 * ## 为什么不做 memo
 *
 * eraAkumaMaid 的 memo 是给"多条回退链 × 全库四遍"用的；这里只有五条定长前缀正则、
 * 命中即返回，单次解析是常数级小开销，加一层缓存反而多一份失效面。
 */

import type { FamilyIndexRule, FamilyMatch } from '@kojo/plugin-api';

/**
 * 家族表（**长名在前**）。
 *
 * 顺序是防御性的：`KOJO_DEFINE` 是 `KOJO_DEFINE_NAME` / `KOJO_DEFINE_KOJO_INFO` 的
 * 前缀，虽然 `_K` 锚点本身已排除歧义（`KOJO_DEFINE_NAME_K1` 在 `KOJO_DEFINE` 之后
 * 紧跟的是 `_NAME` 而不是 `_K`），但按长度降序可保证将来加入 `KOJO_DEFINE_X` 时
 * 不必重新推导顺序。
 */
export const ERAFL_FAMILIES: readonly string[] = Object.freeze([
  'KOJO_DEFINE_KOJO_INFO',
  'KOJO_DEFINE_NAME',
  'KOJO_FOR_FEMALE',
  'KOJO_FOR_MALE',
  'KOJO_DEFINE',
]);

/**
 * 家族 → 中文标签（游戏知识，只住本包）。键与 `ERAFL_FAMILIES` 一一对应，
 * 消费方（函数树 / 导航）按 `FamilyMatch.face` 取用。
 */
export const ERAFL_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  KOJO_DEFINE: '口上注册',
  KOJO_DEFINE_NAME: '口上显示名',
  KOJO_FOR_MALE: '男性主角适配',
  KOJO_FOR_FEMALE: '女性主角适配',
  KOJO_DEFINE_KOJO_INFO: '口上信息',
});

/**
 * 入参声明 / 注释裁剪：Emuera 函数名不含逗号、空白、括号，实盘存在
 * `@KOJO_DEFINE_KOJO_INFO_K1099(CHARA_ID)` 与 `, ARGS` 形态 ⇒ 从首个分隔符起裁掉。
 */
const TRAILING_JUNK_RE = /[\s,(;].*$/;

/** 预编译五条锚点（`i`：引擎标识符大小写不敏感） */
const FAMILY_PATTERNS: ReadonlyArray<{ family: string; re: RegExp }> = ERAFL_FAMILIES.map((family) => ({
  family,
  re: new RegExp(`^${family}_K(\\d+)(?:_(.+))?$`, 'i'),
}));

/**
 * 解析单个函数名（纯函数；与五族命名无关的函数返回 null，绝不猜测）。
 *
 * @returns `family` = head 家族；`face` 同取家族（本游戏没有独立的面层，消费方按
 *   `face` 分组即可拿到中文标签）；`characterNo` = `_K{n}` 的 n。
 */
export function parseKojoFamily(rawName: string): FamilyMatch | null {
  const name = (rawName ?? '').replace(TRAILING_JUNK_RE, '');
  if (name.length === 0) return null;

  for (const { family, re } of FAMILY_PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    const no = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(no)) return null;
    return Object.freeze({
      kind: 'ok',
      prefix: 'KOJO',
      family,
      characterNo: no,
      selector: 0,
      // 本游戏没有面层：face 直接取家族，让消费方的"按面分组 + 中文标签"两条能力都有值
      face: family,
      sub: '',
      isMessageCheck: false,
      slot: m[2] ?? '',
      isPlaceholder: false,
    });
  }
  return null;
}

/**
 * 构造 eraFL 家族识别规则（供 `GameAdapter.functionFamilyIndex` 使用）。
 *
 * `instructionFaces: []` 是**显式声明**而非遗漏：本游戏口上按 XML 节点组织，
 * 函数名里没有指令号尾槽（见头注 3），消费方据此整面成列。
 */
export function createEraflFamilyIndex(): FamilyIndexRule {
  return {
    name: 'erafl-family-index',
    match(fnName: string): FamilyMatch | null {
      return parseKojoFamily(fnName);
    },
    faceLabels: ERAFL_FACE_LABELS,
    instructionFaces: [],
  };
}
