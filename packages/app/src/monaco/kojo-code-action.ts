import type * as Monaco from 'monaco-editor';
import type {
  EditorCodeAction,
  EditorCodeActionContribution,
  GameProject,
  LineDecoration,
} from '@kojo/plugin-api';
import { decorationsToMarkers } from './kojo-language';

/**
 * 💡 快速修复的**宿主接线**（B9，2026-10-15 编辑器特性批）。
 *
 * 三件事，都是"把已有素材接上"而不是新造能力：
 *
 * 1. **声明本 provider 产出的动作类别**（`providedCodeActionKinds`）：Monaco 用它决定
 *    要不要调用 provider（`getCodeActionProviders` 按 kind 求交集），并写进
 *    `supportedCodeActions` 上下文键。波浪线上 `Ctrl+.` 是一条 `only=quickfix` 的
 *    **显式请求**，宿主必须说得出"我给的就是这个"。
 * 2. **把当前波浪线递给贡献方**（`CodeActionRequest.diagnostics`）：`Ctrl+.` 是
 *    **针对某一条诊断**的请求，"光标在哪一行"不足以回答它——一条跨列的诊断、一行里
 *    两条同族问题、光标停在波浪线旁边的空白列，都得有唯一答案。答案就是**面上正画着
 *    的那些 marker**：Monaco 的 standalone 包装层（`standaloneLanguages.js`
 *    `registerCodeActionProvider`）已经按请求区间求交、把 `context.markers` 填好了，
 *    宿主把它翻回契约的中性形状递出去即可。
 *    （**不另存一份诊断缓存**：宿主自己那一份与面上画出的东西是两个真源，
 *    去抖刷新没到期、标签路径做键、糖视图换 model……任何一处对不上就静默失灵。）
 * 3. **把诊断挂进动作**（`CodeAction.diagnostics`）：此前波浪线（markers）与动作是两条
 *    平行线——Monaco 不知道某个动作修的是哪一条诊断，于是"带诊断的修复优先排序"
 *    （`codeActionsComparator`）、"可自动修"（`hasAutoFix`）、"应用后高亮被修区间"
 *    （`codeActionController` 的 DECORATION）这些内建行为全都拿不到。
 *    贡献方在契约里给 `diagnostics`（`LineDecoration[]`），宿主翻成 Monaco 的 marker 形状。
 * 4. **唯一解才标 preferred**（R2，2026-10-15 列接线批）：本次请求的某条诊断**恰好只有一条
 *    快速修复**认领 ⇒ 该条 `isPreferred: true`；同一诊断多条认领一律不置（判据见 `pickPreferred`）。
 *
 * 分层同 `kojo-definition` / `kojo-hover`：**纯逻辑**（`markersToDecorations`、
 * `collectCodeActions`：问槽、隔离抛错、翻译形状）与 **Monaco 运行时**（`actionDiagnostics`：
 * 需要 model 做行列夹取）分开——前者可脱离编辑器单测。宿主**不认识** ERB / 糖 / 结构：
 * 动作与诊断一律来自槽 `ui.editor.codeAction` 与 `ui.editor.decorator`。
 */

/** Monaco 的 `CodeActionKind` 没走公开 API（0.57 只暴露字符串），字面量在此收口 */
export const QUICK_FIX_KIND = 'quickfix';
export const REFACTOR_KIND = 'refactor';

/**
 * 本 provider **实际**会产出的类别。
 *
 * 为什么不照"只声明 quickfix"写：槽里的贡献方两类都给（结构修复是 quickfix、`.kojo`
 * 的写法重写类动作是 refactor）。`mayIncludeActionsOfKind` 是**交集**判定——只声明
 * quickfix 会让 provider 在"重构"这条显式请求下不被调用，等于为了 Ctrl+. 把 💡 里
 * 原有的重构动作弄没了（那是回退，不是收益）。
 */
export const PROVIDED_CODE_ACTION_KINDS: readonly string[] = [QUICK_FIX_KIND, REFACTOR_KIND];

/** 契约里的 `kind` 是窄联合；缺省按 quickfix（与改动前宿主行为一致） */
export function monacoActionKind(kind: EditorCodeAction['kind']): string {
  return kind === REFACTOR_KIND ? REFACTOR_KIND : QUICK_FIX_KIND;
}

/**
 * 一条诊断的身份键：严重级 + 行 + 消息 + 诊断码，**刻意不含列**。
 *
 * 递给贡献方的诊断是从面上已渲染的 marker 反翻译来的（markersToDecorations），而 marker 的
 * 起止列在正向翻译时被补过默认值（行首 / 行尾）——同一条诊断两侧的列未必逐字相等。列进了键，
 * "这条动作修的正是面上那条红线"就会静默判成两条不同诊断，isPreferred 永远点不亮
 * （接了等于没接，比不接更难查）。
 */
export function diagnosticKey(decoration: LineDecoration): string {
  return [decoration.severity, decoration.line, decoration.message, decoration.code ?? ''].join('\u0000');
}

/** `pickPreferred` 的输入：一条候选动作的**中性事实**（已归一的 kind + 它自己声明关联的诊断） */
export interface PreferredCandidate {
  readonly kind: string;
  readonly diagnostics: readonly LineDecoration[];
}

/**
 * 哪些候选该置 `isPreferred`（R2；返回下标集合）。
 *
 * 规则收窄到**不猜**的一条：本次请求（面上正画着）的某条诊断，**恰好只有一条快速修复**
 * 认领它 ⇒ 那条修复 preferred；同一诊断有两条及以上认领 ⇒ 一律不置，多解时不替作者选。
 * 三个刻意的边界：
 * - 只算 quickfix：refactor 类动作不是"这条红线的解"，独一份也不给 preferred；
 * - 只认**本次请求里的**诊断：动作声明关联了别处/别的诊断 ⇒ 对这次请求不算唯一解（不猜）；
 * - 一条动作认领多条时要求**每条都唯一**：只要有另一条红线还有第二个解，把它顶到第一位
 *   就等于在另一条问题上替作者选了。
 * 给的是下标而不是布尔：调用方只在命中时补 `isPreferred: true`，**从不写 false**
 * （省略才是"没有唯一解"的原意，`false` 会被 Monaco 当成一个明确的否定）。
 */
export function pickPreferred(
  candidates: readonly PreferredCandidate[],
  requested: readonly LineDecoration[],
): Set<number> {
  const owners = new Map<string, number[]>();
  for (const decoration of requested) {
    const key = diagnosticKey(decoration);
    if (!owners.has(key)) owners.set(key, []); // 同一诊断画成两条重叠 marker 也只算一个问题
  }
  // 一条动作对同一条诊断的认领只计一次（贡献方重复列同一条关联不算"第二个解"）
  const claims = candidates.map((candidate, index) =>
    candidate.kind === QUICK_FIX_KIND
      ? [...new Set(candidate.diagnostics.map(diagnosticKey))].filter((key) => owners.has(key))
      : [],
  );
  for (const [index, keys] of claims.entries()) {
    for (const key of keys) owners.get(key)!.push(index);
  }
  const preferred = new Set<number>();
  for (const [index, keys] of claims.entries()) {
    if (keys.length > 0 && keys.every((key) => owners.get(key)!.length === 1)) preferred.add(index);
  }
  return preferred;
}

/**
 * 一条动作要关联的诊断 → Monaco marker 形状；贡献方没给关联就返回 `undefined`（**不编**）。
 *
 * 行/列夹取复用 `decorationsToMarkers` 同一条口径：诊断来自插件对**当时那份文本**的计算，
 * Monaco 请求动作时文本可能已经变了，越界值不该让整条动作消失。
 */
export function actionDiagnostics(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  action: EditorCodeAction,
): Monaco.editor.IMarkerData[] | undefined {
  const provided = action.diagnostics;
  if (!provided || provided.length === 0) return undefined;
  return decorationsToMarkers(monaco, model, provided);
}

/**
 * Monaco marker → 契约诊断形状（`LineDecoration`）：**面上画着什么，就是递给贡献方的什么**。
 *
 * 为什么要反方向翻译一遍：契约不许长 Monaco 的形状（插件不该知道 `MarkerSeverity` 是数字），
 * 而诊断的**权威来源**只能是已渲染的 marker ——宿主另存一份就要和它赛跑（去抖、切标签、
 * 糖视图换 model 都会让两份错位）。`code` 走 `decorationsToMarkers` 的正向口径（B9 起
 * 诊断码进 marker 的 `code` 字段），这里原路取回；`{ value, target }` 形态取 `value`
 * （本仓不产链接码，但公开 API 允许，就不赌它永远是字符串）。
 *
 * 跨行 marker 取起始行：`LineDecoration` 是行级契约，而当前发布方逐行发布，不存在跨行形状。
 */
export function markersToDecorations(
  monaco: typeof Monaco,
  markers: readonly Monaco.editor.IMarkerData[],
): LineDecoration[] {
  return markers.map((m) => {
    const code = typeof m.code === 'string' ? m.code : m.code?.value;
    const severity: LineDecoration['severity'] =
      m.severity === monaco.MarkerSeverity.Error
        ? 'error'
        : m.severity === monaco.MarkerSeverity.Warning
          ? 'warning'
          : 'info';
    return {
      line: m.startLineNumber,
      severity,
      message: m.message,
      startColumn: m.startColumn,
      endColumn: m.endColumn,
      ...(code !== undefined ? { code } : {}),
    };
  });
}

/**
 * 一次 💡 请求的中性事实（宿主把 Monaco 的 model/range 翻成这里，纯逻辑才测得动）。
 *
 * `diagnostics` 是**必填**（空数组 = 该区间没有波浪线）：让"宿主有没有给诊断"成为
 * 一个显式参数而不是可选的猜测。其余字段与契约 `provideActions` 的入参逐一对应。
 */
export interface CodeActionRequest {
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly line?: number;
  readonly lineCount?: number;
  readonly diagnostics: readonly LineDecoration[];
}

/** `collectCodeActions` 的落地点：动作本体的反查表 + marker 翻译器（都由宿主注入） */
export interface CodeActionSink {
  /** 登记待执行动作，返回 Monaco command 的反查 id（宿主 `pendingActionsRef`） */
  register(contributionId: string, action: EditorCodeAction): string;
  /** 关联诊断 → Monaco marker；没有关联就返回 `undefined`（**不给就是没有**） */
  markerDataFor(action: EditorCodeAction): Monaco.editor.IMarkerData[] | undefined;
}

/**
 * 问槽 → 隔离抛错 → 翻成 Monaco 形状。
 *
 * 隔离纪律与装饰器 / 转到定义一致：**单个贡献抛错不影响其余**（能力出错退化可见，
 * 不让整个 💡 消失）。这里刻意不做任何"动作去重"：两个贡献方给出同名动作是**语义分歧**，
 * 该在贡献方收敛，宿主偷偷合并等于把 bug 藏进菜单。
 */
export function collectCodeActions(
  contributions: readonly EditorCodeActionContribution[],
  request: CodeActionRequest,
  sink: CodeActionSink,
  commandId: string,
): Monaco.languages.CodeAction[] {
  const actions: Monaco.languages.CodeAction[] = [];
  const candidates: PreferredCandidate[] = [];
  for (const contribution of contributions) {
    let provided: EditorCodeAction[];
    try {
      provided = contribution.provideActions({
        path: request.path,
        text: request.text,
        project: request.project,
        lineCount: request.lineCount,
        ...(request.line !== undefined ? { line: request.line } : {}),
        diagnostics: [...request.diagnostics],
      });
    } catch (e: unknown) {
      console.warn(
        `[kojo-code-action] '${contribution.id}' provideActions 抛错：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      continue;
    }
    for (const action of provided) {
      const actionId = sink.register(contribution.id, action);
      const diagnostics = sink.markerDataFor(action);
      const kind = monacoActionKind(action.kind);
      candidates.push({ kind, diagnostics: action.diagnostics ?? [] });
      actions.push({
        title: action.title,
        kind,
        command: { id: commandId, title: action.title, arguments: [actionId] },
        // 省略而不是给空数组：空数组在 Monaco 里同样算"无关联"，但 `undefined`
        // 才是"这条动作不是冲着某条诊断来的"的原意
        ...(diagnostics ? { diagnostics } : {}),
      });
    }
  }
  // R2：唯一解才 preferred（判据见 `pickPreferred`）——波浪线上 `Ctrl+.` 直接命中，
  // 多解时一律不置，让作者自己在 💡 里选。
  for (const index of pickPreferred(candidates, request.diagnostics)) {
    actions[index]!.isPreferred = true;
  }
  return actions;
}
