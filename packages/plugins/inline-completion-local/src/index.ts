/**
 * `@kojo/plugin-inline-completion-local` 的入口。
 *
 * 判据怎么定的、第二家（外部模型源）怎么进来：**读 `src/plugin.ts` 的头注**（那一节是本包的
 * 交付面之一）。这里只交出口，不加第三份说明——两处各写一遍必然漂。
 */

export {
  declaredCatalog,
  declaredDirectives,
  functionCatalog,
  lowerBound,
  probePrefix,
  uniqueNameFor,
  type NameCatalog,
  type PrefixProbe,
} from './catalog';
export {
  createInlineCompletionLocalPlugin,
  type InlineCompletionLocalPluginOptions,
} from './plugin';
export {
  createLocalContribution,
  ERB_LANGUAGE_IDS,
  isServedLanguage,
  LOCAL_CANDIDATE_SOURCE_ID,
  LOCAL_SOURCE_ID,
  LOCAL_SOURCE_ORDER,
  localInlineCompletion,
  type LocalProviderDeps,
  type LocalProviderOptions,
  type LocalTrace,
} from './provider';
export {
  erbNameSlotAt,
  type ErbNameSlot,
  type SlotCatalog,
} from './slot-shape';
