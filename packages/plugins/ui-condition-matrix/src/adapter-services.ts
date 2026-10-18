/**
 * 条件矩阵对**当前适配器**的查询面（从 `index.ts` 的 `activate()` 原样迁出）。
 *
 * 六件事全部经 `game.adapter` 槽位贡献取（按 `adapterId` 精确匹配，多适配器共存
 * 天然正确）：家族规则、变量语义字典、指令表、面标签、状态键标签、单函数状态依赖。
 *
 * 铁律 3：本模块**不认识任何游戏名词**，也不 import 适配器插件——游戏知识只经
 * 槽位贡献流进来；缺贡献时一律回退 `null` / `undefined`，由消费方原样显示 token。
 */

import type {
  ConditionExtractorService,
  FamilyIndexRule,
  GameAdapter,
  GameProject,
  KojoFaceTable,
  KojoInstructionTable,
  ProjectService,
  SlotRegistry,
  StateDependency,
  StateLinePreset,
  VariableSchema,
} from '@kojo/plugin-api';

/** 查询面的签名口径见下方实现处的逐条注记（判据、缺省回退都写在那里） */
export interface AdapterServices {
  /** 当前激活的适配器（多适配器共存时按 adapterId 精确匹配；无 = undefined） */
  currentAdapter(): GameAdapter | undefined;
  currentFamilyIndex(): FamilyIndexRule | null;
  schemaLookup(): VariableSchema | undefined;
  instructionTable(): KojoInstructionTable | undefined;
  /** 分野模板表（.kojo 填空生成反查关键字用；缺省 = undefined） */
  faceTable(): KojoFaceTable | undefined;
  /** 剧情线预设（adapter 声明；缺省 = 空清单） */
  stateLinePresets(): readonly StateLinePreset[];
  faceLabels(): Readonly<Record<string, string>> | undefined;
  labelOf(key: string): string | null;
  depsOf(normalizedName: string): StateDependency[];
}

export function createAdapterServices(deps: {
  project: ProjectService;
  slots: SlotRegistry;
  conditionExtractor: ConditionExtractorService;
}): AdapterServices {
  const { project, slots, conditionExtractor } = deps;

  /** 当前激活适配器：多适配器共存时按 adapterId 精确匹配（无项目 = undefined） */
  const currentAdapter = (): GameAdapter | undefined => {
    const current: GameProject | null = project.current();
    if (!current) return undefined;
    for (const contribution of slots.query('game.adapter')) {
      if (contribution.adapter.gameId === current.adapterId) return contribution.adapter;
    }
    return undefined;
  };

  /** 当前激活适配器的家族规则（无规则 = null，消费方据此显式降级） */
  const currentFamilyIndex = (): FamilyIndexRule | null =>
    currentAdapter()?.functionFamilyIndex ?? null;

  /** 当前适配器的变量语义字典（与注入器同通道） */
  const schemaLookup = (): VariableSchema | undefined => currentAdapter()?.variableSchema;

  /** 当前适配器的指令表（编号 ↔ 中文名；缺省 → undefined） */
  const instructionTable = (): KojoInstructionTable | undefined =>
    currentAdapter()?.kojoInstructionTable;

  /** 当前适配器的分野模板表（.kojo 填空生成反查关键字；缺省 → undefined） */
  const faceTable = (): KojoFaceTable | undefined => currentAdapter()?.kojoFaceTemplates;

  /** 当前适配器声明的剧情线预设（缺省 = []，面板不显示快捷线） */
  const stateLinePresets = (): readonly StateLinePreset[] =>
    currentAdapter()?.stateLinePresets ?? [];

  /** 当前适配器的面 → 中文标签（与家族规则同源；缺省 → 消费方原样显示 token） */
  const faceLabels = (): Readonly<Record<string, string>> | undefined => currentFamilyIndex()?.faceLabels;

  /** 状态键标签：按首个 ':' 切出变量名与首下标，查变量字典 */
  const labelOf = (key: string): string | null => {
    const schema = schemaLookup();
    if (!schema) return null;
    const i = key.indexOf(':');
    const name = i < 0 ? key : key.slice(0, i);
    const firstIndex = i < 0 ? undefined : key.slice(i + 1).split(':')[0];
    return schema.lookup(name, firstIndex)?.description ?? null;
  };

  /** 单函数状态依赖（抽取索引未含该函数时为空数组） */
  const depsOf = (normalizedName: string): StateDependency[] =>
    conditionExtractor.functionConditions(normalizedName)?.dependencies ?? [];

  return {
    currentAdapter,
    currentFamilyIndex,
    schemaLookup,
    instructionTable,
    faceTable,
    stateLinePresets,
    faceLabels,
    labelOf,
    depsOf,
  };
}
