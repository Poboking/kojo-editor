/**
 * Kojo 2.0 切换阶段的**设置入口**（K2-CUTOVER-STAGE）——设计稿 §16.7 U6.7 / §K2-CUTOVER。
 *
 * ## 为什么是一个独立组件
 *
 * 设置页（`SettingsPanel.tsx`）是条件挂载的浮层、入口极多；把三态机 / override 清单直接
 * 塞进去会让那一页同时长出第二套偏好读写。本组件只认一件事：**切换控制器**（`kojo2-cutover`），
 * 自己订阅、自己渲染，挂到设置页的哪一节都不改那边的状态（`<Kojo2CutoverSettings />` 零 props
 * 即可用）。
 *
 * ## 它与既有开关的关系
 *
 * `ui/kojo2-flag.ts` 已改成**由阶段派生**（`stage !== 'v1-only'` = 2.0 切流语义开启；
 * LAU-3 起另有一枚 `stage !== '2.0-default'` = kojo1 可用，见 {@link kojo2StageAllowsLegacy}）。
 * 所以在这里改档，不需要另写一份"把 flag 打开"的代码：语言面 / 主题 / 诊断 / 预览 / 拖放清单
 * 全部读同一枚开关，订阅经 `subscribeKojo2Cutover` 即时反映。
 *
 * ## 阶段切换后必须做的两件事（否则"切了但没生效"）
 *
 * 1. **model 语言重挂**：`refreshAll()` 让已打开的标签按新阶段重新路由（`v1-only → dual`
 *    时已开的 `.kojo2` 从 plaintext 挂回 2.0）。宿主在 `App.tsx` 用
 *    {@link installKojo2CutoverStageEffects} 注入真身，本组件因此在 node 里可直接渲染
 *    （不认识 Monaco，也不 import `editor-model-pool-instance`）。
 * 2. **重载窗口提示**：语言 descriptor 表与主题规则是在**模块求值 / 主题装配那一刻**读的
 *    开关，跨过 `v1-only` 边界后不可能在这一窗里全部热更——{@link kojo2StageNeedsReload}
 *    把这条如实摆出来（铁律 4：不静默）。
 *
 * ## 样式
 *
 * 类名住 `../kojo2.css` 的 `.kojo2-cutover*` 一族（批次十一 L11 收编：此前整块内联
 * 样式常量 + 原生 `<input type="radio">`）。单选件直接用 **ui-kit 的 `KitRadio`**
 * （L14 已合流的真件，非 candidate）：视觉自绘点 + 隐藏真 radio input，键盘 / 读屏
 * 语义仍走原生。`ui-kit.css` 经 `main.tsx` 在样式族之后加载。
 */
import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from 'react';
import { KitRadio } from '../ui-kit/kit-radio';
import { Icon } from './icons';
import {
  getKojo2CutoverController,
  kojo2StageAllowsLegacy,
  kojo2StageAllowsSurface,
  KOJO2_CUTOVER_DEFAULT_STAGE,
  KOJO2_CUTOVER_STAGES,
  type Kojo2CutoverController,
  type Kojo2CutoverSnapshot,
  type Kojo2CutoverStage,
} from './kojo2-cutover';
import {
  clearKojo2CutoverLegacyFlag,
  isKojo2CutoverEnabled,
} from './kojo2-flag';
import '../kojo2.css';

/**
 * 本窗口启动时 2.0 面挂没挂（**模块求值读一次**）。
 *
 * 必须住在模块顶部：设置页在 App 里是静态 import，"这一窗开局那一拍"读到的就是
 * `languages.ts` / 主题装配同一个时间窗里的真值。之后档位再怎么切，它都不变——这正是
 * {@link kojo2StageNeedsReload} 判"跨没跨过 v1-only 边界"的基准。
 */
const BOOT_SURFACE_MOUNTED = isKojo2CutoverEnabled();

/* ============================== 阶段 → 人话 ============================== */

/** 三档的短名（单选标签；机器可读的整句仍在 `KOJO2_STAGE_LABELS`） */
const STAGE_TITLES: Readonly<Record<Kojo2CutoverStage, string>> = {
  'v1-only': '只认 v1',
  dual: '双轨',
  '2.0-default': '2.0 默认',
};

/**
 * 每档的人话说明（作者面；不上 `stage` 这种机器词，只留能据以决策的事实）。
 *
 * LAU-3（2026-10-27）起这一档还**决定 kojo1 的开合**：`2.0-default` ⇒ kojo1 成为封存层
 * （`.kojo` 不再被认领、`.kojo 预览` 一起停用），前两档 ⇒ kojo1 照常可用。这句必须写在
 * 屏上：它是本档唯一的**削功能**后果，藏着就是静默（铁律 4）。判据仍只有一份
 * （`kojo2-cutover.ts::kojo2StageAllowsLegacy`），这里只是把它说出来。
 */
const STAGE_HINTS: Readonly<Record<Kojo2CutoverStage, string>> = {
  'v1-only':
    '只按老写法认文件：.kojo 恒按 v1 解析；.kojo2 照常高亮、照常出诊断，但写回 / 迁移 / 2.0 存储命令不启用。kojo1 可用。',
  dual: '老 .kojo 一行都不用动，只有 .kojo2 走 2.0；两套语法同时在册。kojo1 可用。',
  '2.0-default':
    '缺省档：.kojo2 走 2.0，老 .kojo 看正文像不像 2.0 再决定（判不出来时按 v1 打开）。' +
    'kojo1 在这一档封存——.kojo 不再被认作 kojo1，「.kojo 预览」随之停用（偏好不清零，退档即恢复）。',
};

/**
 * 这一档要不要重载窗口才完整生效。
 *
 * `bootMounted` = 本窗口启动时 2.0 面挂没挂（模块求值读一次）。切换档位只要**跨过**
 * `v1-only` 边界，语言 descriptor 表与主题规则就需要重载窗口才能全部换过来。
 */
export function kojo2StageNeedsReload(
  stage: Kojo2CutoverStage,
  bootMounted: boolean = BOOT_SURFACE_MOUNTED,
): boolean {
  return kojo2StageAllowsSurface(stage) !== bootMounted;
}

/** 重载提示的人话（两个方向各一句；都明说"现在就生效的部分"与"要重载的部分"） */
export function kojo2ReloadNotice(stage: Kojo2CutoverStage): string {
  if (!kojo2StageAllowsSurface(stage)) {
    return '已退回「只认 v1」：已打开的标签会立刻回到老写法。2.0 面要重载窗口才会彻底摘掉（本窗口里已经挂上的那一套仍留着）。';
  }
  const sealed = kojo2StageAllowsLegacy(stage)
    ? ''
    : '这一档同时把 kojo1 封存了：已经打开的 .kojo 保持原样（不当场抽走高亮），新开的 .kojo 不再按 kojo1 认领，「.kojo 预览」停用；kojo1 的插件族要重载窗口才会彻底卸掉。';
  return `这一档已生效：已打开的标签会立刻按新档重挂。但语言面与配色是在窗口启动时装配的，重载窗口后新开的 .kojo2 才会完整上色、出诊断。${sealed}`;
}

/* ============================== 阶段效果注入口 ============================== */

/** 阶段切换后宿主必须做的事（真身只在 `App.tsx` 装配一次） */
export interface Kojo2CutoverStageEffects {
  /** 重挂所有已开 model 的语言（真身 = `editor-model-pool-instance.kojo2ModelLanguage.refreshAll`） */
  readonly refreshAll: () => void;
}

/** 缺省效果 = 什么都不做（node 测试 / 无宿主环境直接渲染本组件时用） */
const NO_STAGE_EFFECTS: Kojo2CutoverStageEffects = { refreshAll: () => undefined };

let stageEffects: Kojo2CutoverStageEffects = NO_STAGE_EFFECTS;

/**
 * 注入阶段效果（**宿主装配一次**；传 `null` 摘掉）。
 *
 * 为什么不在本模块直接 import `editor-model-pool-instance`：那模块一加载就摸 Monaco 的
 * `window`，会让设置页（以及它在 node 里的渲染测试）在 import 阶段就炸。注入把"谁知道
 * Monaco"留在 `App.tsx`，本组件只管"什么时候该叫它"。
 */
export function installKojo2CutoverStageEffects(
  effects: Kojo2CutoverStageEffects | null,
): void {
  stageEffects = effects ?? NO_STAGE_EFFECTS;
}

/**
 * 改档的**唯一**执行入口：设阶段 → 阶段真变了才 `refreshAll()` 一次 → 返回新快照。
 *
 * 同一档再点一次不算切换（不制造第二遍全量 tokenize）；`refreshAll` 只在真跨档时叫一次，
 * 测试按"被调用一次"钉住。
 */
export function commitKojo2CutoverStage(
  stage: Kojo2CutoverStage,
  options: {
    readonly controller?: Kojo2CutoverController;
    readonly effects?: Kojo2CutoverStageEffects;
  } = {},
): Kojo2CutoverSnapshot {
  const controller = options.controller ?? getKojo2CutoverController();
  const effects = options.effects ?? stageEffects;
  const before = controller.getStage();
  const after = controller.setStage(stage);
  if (after !== before) effects.refreshAll();
  return controller.getSnapshot();
}

/**
 * 恢复出厂（**两件必须一起做**，顺序也写死）：
 *
 * 1. 删旧布尔键——计划一旦被删，旧键 `'on'` 会让 `resolveKojo2CutoverStage()` 又回到
 *    `dual`，等于"恢复出厂了但档位不是缺省档"；
 * 2. 控制器 `reset()`——回缺省档（LAU-3 起 = `2.0-default`，kojo1 封存）、清空全部单文件
 *    破例、删掉盘上的计划（连带清掉"v1 计划升上来"的一次性回执）。
 *
 * 只删不动任何文件内容；返回重置后的快照（组件据此重渲染）。
 */
export function resetKojo2CutoverAll(
  controller: Kojo2CutoverController = getKojo2CutoverController(),
): Kojo2CutoverSnapshot {
  clearKojo2CutoverLegacyFlag();
  controller.reset();
  return controller.getSnapshot();
}

/* ============================== 组件 ============================== */

export interface Kojo2CutoverSettingsProps {
  /** 控制器（缺省 = 进程级单例；测试注入独立实例） */
  readonly controller?: Kojo2CutoverController;
  /**
   * 本窗口启动时 2.0 面挂没挂（缺省 = 模块求值那一刻的真实读数）。
   * 显式传入只为测试与"宿主自己知道得更多"的场合。
   */
  readonly bootSurfaceMounted?: boolean;
}

/**
 * 设置页里的「Kojo 2.0」分区：三态单选 + 每档人话 + kojo1 开合读数 + 迁移回执
 * + 单文件破例清单（可撤）+ 恢复出厂。
 *
 * 订阅只订控制器一张表（阶段 / override / 持久化状态 / 迁移回执都在同一份快照里）；卸载即退订。
 */
export function Kojo2CutoverSettings(props: Kojo2CutoverSettingsProps): ReactElement {
  const controller = props.controller ?? getKojo2CutoverController();
  const [snapshot, setSnapshot] = useState<Kojo2CutoverSnapshot>(() => controller.getSnapshot());

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  const choose = useCallback(
    (stage: Kojo2CutoverStage): void => {
      setSnapshot(commitKojo2CutoverStage(stage, { controller }));
    },
    [controller],
  );

  const clearOverride = useCallback(
    (filePath: string): void => {
      controller.clearOverride(filePath);
      setSnapshot(controller.getSnapshot());
    },
    [controller],
  );

  const factoryReset = useCallback((): void => {
    // 两件一起做：旧布尔键（否则计划一删，旧键 'on' 会把解析拉回 dual）+ 控制器计划
    setSnapshot(resetKojo2CutoverAll(controller));
  }, [controller]);

  const bootMounted = props.bootSurfaceMounted ?? BOOT_SURFACE_MOUNTED;
  const needsReload = kojo2StageNeedsReload(snapshot.stage, bootMounted);

  return (
    <div className="kojo2-cutover" data-kojo2-cutover="root" data-kojo2-stage={snapshot.stage}>
      <div role="heading" aria-level={4} className="kojo2-cutover__title">
        Kojo 2.0
      </div>
      <div className="kojo2-cutover__lead">
        2.0 是新的口上写法；这一档决定编辑器认不认它。切档不动任何文件内容。
      </div>

      <div role="radiogroup" aria-label="Kojo 2.0 档位" className="kojo2-cutover__stages">
        {KOJO2_CUTOVER_STAGES.map((stage) => {
          const selected = snapshot.stage === stage;
          return (
            <div
              key={stage}
              className="kojo2-cutover__stage-row"
              data-kojo2-stage={stage}
              data-kojo2-selected={selected ? '1' : '0'}
            >
              <KitRadio
                name="kojo2-cutover-stage"
                value={stage}
                checked={selected}
                label={STAGE_TITLES[stage]}
                onChange={(on) => {
                  if (on) choose(stage);
                }}
              >
                <span className="kojo2-cutover__stage-title">
                  {STAGE_TITLES[stage]}
                  {selected ? <span className="kojo2-cutover__badge">当前</span> : null}
                  {/* 缺省标记跟着 `KOJO2_CUTOVER_DEFAULT_STAGE` 走（LAU-3 起在「2.0 默认」那一档）：
                      不写字面档名，免得"恢复出厂"与这一格各说一套 */}
                  {stage === KOJO2_CUTOVER_DEFAULT_STAGE ? (
                    <span className="kojo2-cutover__badge" data-kojo2-default-stage={stage}>
                      缺省
                    </span>
                  ) : null}
                </span>
                <span className="kojo2-cutover__hint">{STAGE_HINTS[stage]}</span>
              </KitRadio>
            </div>
          );
        })}
      </div>

      {/* kojo1（封存层）此刻的开合——本档唯一的削功能后果，逐档现算、不抄档名 */}
      <div className="kojo2-cutover__hint" data-kojo2-legacy={kojo2StageAllowsLegacy(snapshot.stage) ? 'on' : 'sealed'}>
        kojo1（老写法）当前{kojo2StageAllowsLegacy(snapshot.stage) ? '可用' : '已封存'}：
        {kojo2StageAllowsLegacy(snapshot.stage)
          ? '.kojo 按 kojo1 认领，「.kojo 预览」照常。'
          : '.kojo 不再按 kojo1 认领（新开的落纯文本），「.kojo 预览」停用；已打开的标签保持原样，不当场抽走高亮。'}
        <br />
        kojo1 的插件族（转译 / 预览 / 升糖 / 糖编辑）不随切档热装热卸：重开项目（或重载窗口）后才按新档生效。
      </div>

      {/* v1 计划升上来的一次性回执（铁律 4：抬了作者的档位就必须说；写回 v2 后下次开机不再出现） */}
      {snapshot.migratedFromV1Plan ? (
        <div className="kojo2-cutover__notice" role="status" data-kojo2-migrated="1">
          <span className="kojo2-cutover__notice-icon" aria-hidden="true">
            <Icon name="info" size="sm" />
          </span>
          <span>
            你原来停在旧的缺省档（只认 v1）。本版把缺省档换成了「2.0 默认」，已按新缺省为你切换；
            想回到从前的行为，选上面的「只认 v1」或「双轨」即可（不动任何文件内容）。
          </span>
        </div>
      ) : null}

      {needsReload ? (
        <div className="kojo2-cutover__notice" role="status" data-kojo2-reload-notice="1">
          <span className="kojo2-cutover__notice-icon" aria-hidden="true">
            <Icon name="info" size="sm" />
          </span>
          <span>{kojo2ReloadNotice(snapshot.stage)}</span>
        </div>
      ) : null}

      <div className="kojo2-cutover__sub-title">单文件破例</div>
      {snapshot.overrides.length === 0 ? (
        <div className="kojo2-cutover__hint" data-kojo2-overrides="empty">
          还没有任何单文件破例：所有文件都按上面的档位走。
        </div>
      ) : (
        <ul className="kojo2-cutover__overrides" data-kojo2-overrides={String(snapshot.overrides.length)}>
          {snapshot.overrides.map((entry) => (
            <li
              key={entry.filePath}
              className="kojo2-cutover__override-row"
              data-kojo2-override={entry.filePath}
            >
              <span className="kojo2-cutover__override-path" title={entry.filePath}>
                {entry.filePath}
              </span>
              <span className="kojo2-cutover__override-parser">
                {entry.parser === 'kojo2' ? '按 2.0' : '按 v1'}
              </span>
              <button
                type="button"
                className="small kojo2-cutover__clear"
                onClick={() => clearOverride(entry.filePath)}
                aria-label={`撤销 ${entry.filePath} 的单文件破例`}
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="kojo2-cutover__footer">
        <button type="button" className="small" onClick={factoryReset}>
          恢复出厂
        </button>
        <span className="kojo2-cutover__hint">
          回到缺省档「{STAGE_TITLES[KOJO2_CUTOVER_DEFAULT_STAGE]}」并清空全部单文件破例；不动任何文件。
        </span>
      </div>

      {snapshot.persisted ? null : (
        <div className="kojo2-cutover__hint" data-kojo2-persisted="0">
          这次改动只在本会话生效：存储不可写（隐私模式 / 空间已满）。
        </div>
      )}
    </div>
  );
}
