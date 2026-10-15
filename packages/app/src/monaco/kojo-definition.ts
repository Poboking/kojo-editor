import type * as Monaco from 'monaco-editor';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

/**
 * 转到定义的**宿主接线**（2026-10-15 语言服务批）。
 *
 * 分层与 `kojo-hover` / `kojo-completion` 同款：**纯逻辑**（`collectDefinitionLocations`：
 * 按槽序问各贡献方、隔离抛错、去重）与 **Monaco 绑定**（`installDefinitionProvider`：
 * 位置进、位置出）分开——前者可单测，后者只做协议翻译。宿主**不认识** ERB / 家族 /
 * 角色：数据全部来自 `ui.editor.languageService` 槽，宿主只决定"跳去哪"。
 */

/**
 * 合并全部贡献方的定义目标。
 *
 * 隔离纪律与装饰器 / CodeAction 一致：**单个贡献抛错不影响其余**（能力出错退化可见，
 * 不让整条"转到定义"消失）；去重键含文件与行列——同一个目标被两个贡献方同时给出
 * （如 ERB 与糖两条线都命中）时不该出现两份。
 */
export function collectDefinitionLocations(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorSymbolLocation[] {
  const out: EditorSymbolLocation[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-definition] '${contribution.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    // `undefined` = 该贡献方不认这个文件（跳过）；空数组 = 认但不给目标（同样不加东西）
    if (!result || result.kind !== 'definition') continue;
    for (const location of result.locations) {
      const key = `${location.filePath}\u0000${location.line}\u0000${location.column ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(location);
    }
  }
  return out;
}

/** 宿主注入的两件事：怎么问（含糖视图判据）与怎么落地 */
export interface DefinitionHandlers {
  /** 位置 → 目标（宿主在此查槽；返回空数组 = 此处没有定义） */
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): EditorSymbolLocation[];
  /** 落地一次跳转（宿主注入；当前实现经 `editor.revealLocation` 复用既有导航通道） */
  navigate(location: EditorSymbolLocation): void;
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册 definition provider。
 *
 * **返回值刻意是 `undefined`**：目标常常在**尚未打开的另一个文件**里，而 Monaco 自带
 * 的跳转要按 URI 找已存在的 model——找不到就静默失败（甚至把浏览器甩到别的页面）。
 * 跨文件开文件 + 定位这件事宿主**已经有**一条法定通道（`editor.revealLocation`
 * → App 打开文件 → 编辑器滚动），所以这里只发意图，不另造机制、也不把业务塞进宿主。
 *
 * 多目标（重名函数的多处定义）取**第一个**落地：不弹选择器是刻意的保守——
 * 槽序已表达优先级，选一个确定的位置胜过让作者在列表里猜。
 */
export function installDefinitionProvider(
  monaco: typeof Monaco,
  handlers: DefinitionHandlers,
): Monaco.IDisposable {
  const provider: Monaco.languages.DefinitionProvider = {
    provideDefinition(model, position) {
      let locations: EditorSymbolLocation[];
      try {
        locations = handlers.resolve(model, position);
      } catch (e: unknown) {
        // 宿主自己的 resolve（查槽 + 组请求）出错也不能让 F12 崩掉编辑器
        console.warn(`[kojo-definition] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      if (locations.length === 0) return undefined;
      handlers.navigate(locations[0]!);
      return undefined;
    },
  };
  const subs = [
    monaco.languages.registerDefinitionProvider(ERB_LANGUAGE_ID, provider),
    monaco.languages.registerDefinitionProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
