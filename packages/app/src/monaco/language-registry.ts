/**
 * 语言描述符与注册表（LANG-REGISTRY，2026-10-20）。
 *
 * 宿主此前按 `KOJO_LANGUAGE_ID` / `ERB_LANGUAGE_ID` 分支选语言、挂 Monaco 面；
 * 每加一门语言要改 model 池、EditorPane、树层与若干 provider。现在**语言事实**
 * 收进一枚 descriptor：id、认路判据、一次性 Monaco 注册。宿主只按表查，不认识
 * 任何具体语言名。
 *
 * 纪律：
 * - 注册表是**进程级只增表**；同 id 重复注册直接抛错（不静默覆盖，铁律 4）。
 * - 认路按**注册顺序**取第一条命中；若两枚 descriptor 的判据重叠，那是判据本身
 *   写错了（由测试钉住），这里不做投票。
 * - 认不出 = `plaintext` 兜底（与收口前 `languageFor` 的最后一格逐字相同）：
 *   猜成任何 DSL 都会把别的语言的补全 / 悬停塞进不相干文件。
 */
import type * as Monaco from './entry';
import type { LanguageCapability } from './language-capabilities';
import type { StructureLanguageRuntime } from './tree-sitter/structure-runtime';

export const FALLBACK_LANGUAGE_ID = 'plaintext';

/**
 * 可以「只挂槽腿」的**能力名**（B2 起，additive）。
 *
 * 取值 = `ui.editor.languageService` 槽里**集合型**的判别成员名（`documentSymbol` /
 * `definition` / `references` / `foldingRange` / `inlayHint`）。单答型（`hover` /
 * `formatting` / `signatureHelp` / `rename`）不在其中：它们"第一家说了算"，多语言共用
 * 一枚 provider 时谁先答取决于注册表顺序——那不是能力声明能决定的事。
 */
export type SlotServiceKind =
  | 'definition'
  | 'documentSymbol'
  | 'references'
  | 'foldingRange'
  | 'inlayHint';

export interface LanguageDescriptor {
  /** Monaco 语言 id（也是 `ITextModel.getLanguageId()` 的返回值） */
  readonly id: string;
  /** 人读名（设置 / 诊断用；宿主不据此分支） */
  readonly label: string;
  /** 认领文件路径（大小写不敏感由各 descriptor 自己保证） */
  readonly matchesPath: (filePath: string) => boolean;
  /** 一次性挂 Monaco 面（Monarch / 配置 / 主题）；必须幂等 */
  readonly register: (monaco: typeof Monaco) => void;
  /**
   * 是否参与**宿主通用语言服务**的双注册（definition / references / symbols / folding /
   * hover / signature / codeLens / inlayHint / semanticToken）。缺省 = false：
   * JSON 这类只读保留面不挂，免得空结果顶掉 Monaco 的缩进折叠与内建行为。
   */
  readonly languageServices?: boolean;
  /**
   * **只挂这几条槽腿**（additive，B2）：与 {@link languageServices} 的分工是**粒度**——
   * 后者是"v1 语义的 11 枚 provider 全铺"，前者是"只挂点名的这几种能力，应答全来自
   * `ui.editor.languageService` 槽"。
   *
   * 为什么需要它（而不是让 kojo2 直接声明 `languageServices: true`）：那 11 枚里有几枚
   * 的**空结果会顶掉 Monaco 内建行为**——最典型是折叠：注册了 `FoldingRangeProvider`
   * 之后 Monaco 的缩进折叠就不再兜底，供方不认这篇时作者会看到"整个文件都不能折叠"。
   * kojo2 的折叠 / 悬停 / 补全归它自己的插件，宿主不该替它铺满。
   *
   * 与 `languageServices` 是**并集**关系：声明了 `languageServices: true` 的语言即使
   * 不写这一格，也参与全部槽腿（v1 的 ERB / .kojo 就是这种）。
   */
  readonly slotServices?: readonly SlotServiceKind[];
  /**
   * 结构层（tree-sitter）资源。**按需加载**：`load()` 里必须用动态 import，
   * 不然 worker / wasm / 查询会跟着主线程静态图一起进首屏，违背"默认关 = 不存在"。
   * 缺省 = 这门语言没有结构层，叠层不会为它注册任何 provider。
   */
  readonly structure?: {
    readonly load: () => Promise<StructureLanguageRuntime>;
  };
  /**
   * 这门语言**已交付**的语言面（LANG-PARITY-GATE，additive：旧 descriptor 零改动）。
   *
   * 取值 = `monaco/language-capabilities.ts` 的 `ERB_CAPABILITIES` / `KOJO2_CAPABILITIES`
   * （矩阵的行由同一份声明对拍生成）。这里**只列已交付的**：已知缺口在矩阵里以
   * `{ exempt }` 记，不写进这一格——声明是"有"，不是"想要"。
   *
   * 宿主今天不按它分支行为（注册点的注册行才是真源）；它是闸门对账的声明面：
   * `language-parity.test.ts` 逐项断言「声明的面 = 矩阵里非豁免的面 = 注册点取证得到的面」。
   */
  readonly capabilities?: readonly LanguageCapability[];
}

const descriptors: LanguageDescriptor[] = [];

export function registerLanguage(descriptor: LanguageDescriptor): void {
  if (descriptors.some((existing) => existing.id === descriptor.id)) {
    throw new Error(
      `[language-registry] 语言 id "${descriptor.id}" 重复注册（${descriptor.label}）`,
    );
  }
  descriptors.push(descriptor);
}

export function descriptorForPath(filePath: string): LanguageDescriptor | null {
  return descriptors.find((descriptor) => descriptor.matchesPath(filePath)) ?? null;
}

/** 全部已登记 descriptor（顺序 = 注册顺序；供宿主按能力批量挂面） */
export function languageDescriptors(): readonly LanguageDescriptor[] {
  return descriptors;
}

export function descriptorForLanguageId(languageId: string): LanguageDescriptor | null {
  return descriptors.find((descriptor) => descriptor.id === languageId) ?? null;
}

export function languageIdForPath(filePath: string): string {
  return descriptorForPath(filePath)?.id ?? FALLBACK_LANGUAGE_ID;
}

/** 把每门已登记语言的 Monaco 面挂上（各 descriptor 的 `register` 自带幂等） */
export function registerAllLanguageSurfaces(monaco: typeof Monaco): void {
  for (const descriptor of descriptors) descriptor.register(monaco);
}
