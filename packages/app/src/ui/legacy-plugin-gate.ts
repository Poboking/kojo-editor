/**
 * kojo1（封存层）的**插件激活门**（LAU-3b，2026-10-27）。
 *
 * ## 为什么要有这一枚
 *
 * 封存层不只要"语言认领不上、命令不给"，它的**插件族本身就不该被实例化**：
 *
 * | 插件 | 提供什么 | 不装时的后果 |
 * | --- | --- | --- |
 * | `kojo-sugar` | `sugar.transpile` / `preview` / `lift` / `liftApply` + `.kojo` 槽应答 | `.kojo` 无人应答（本来就无人打开） |
 * | `ui-sugar-lift` | 升糖预览面板 | 面板/命令消失 |
 * | `ui-sugar-preview` | `.kojo` 预览面板 | 面板/命令消失 |
 * | `ui-sugar-editor` | `.kojo` 波浪线与糖判定面板 | 不再出 v1 诊断 |
 *
 * 其余插件对 `sugar.*` 的取用全是 `tryInject` / 惰性 provider（adapter、条件矩阵、
 * 约定校验），缺席时**可见降级**而不是崩——`convention-linter` 会如实报
 * 「sugar.transpile 服务缺席：本轮 `.kojo` 约定判定已跳过」。
 *
 * ## 判据只有一枚
 *
 * `isKojoLegacySyntaxEnabled()`（`ui/kojo2-flag.ts`）= 切流阶段 `v1-only` / `dual`。
 * 本文件不解析阶段、不读盘、不订阅——**切档不会热装热卸**：插件表在开项目那一刻取一次
 * （`bootstrap.ts` 的项目级插件清单缓存），设置页的提示会明说"重开项目/重载窗口后生效"。
 */
import { isKojoLegacySyntaxEnabled } from './kojo2-flag';

/** kojo1 插件族的**包名后缀**（`@kojo/plugin-` 之后那一段；测试与装配根共用一张名单） */
export const LEGACY_PLUGIN_IDS = [
  'kojo-sugar',
  'ui-sugar-lift',
  'ui-sugar-preview',
  'ui-sugar-editor',
] as const;

/** 这一刻该不该装 kojo1 插件族（默认档 `2.0-default` ⇒ false） */
export function legacyPluginFamilyEnabled(): boolean {
  return isKojoLegacySyntaxEnabled();
}
