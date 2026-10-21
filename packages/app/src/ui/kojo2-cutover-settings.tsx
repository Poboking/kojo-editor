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
 * `ui/kojo2-flag.ts` 已改成**由阶段派生**（`stage !== 'v1-only'` = 2.0 面开启）。所以在
 * 这里改档，不需要另写一份"把 flag 打开"的代码：语言面 / 主题 / 诊断 / 预览 / 拖放清单
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
 * 全内联、只用主题 token（`var(--fg)` / `var(--bg-2)` …），**不动 `styles.css`**（冲突热点）。
 * 与 `kojo2-migrate.tsx` 同一先例：要换设计系统类名时只改这里的 `styles` 常量。
 */
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import {
  getKojo2CutoverController,
  kojo2StageAllowsSurface,
  KOJO2_CUTOVER_STAGES,
  type Kojo2CutoverController,
  type Kojo2CutoverSnapshot,
  type Kojo2CutoverStage,
} from './kojo2-cutover';
import {
  clearKojo2CutoverLegacyFlag,
  isKojo2CutoverEnabled,
} from './kojo2-flag';

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

/** 每档的人话说明（作者面；不上 `stage` 这种机器词，只留能据以决策的事实） */
const STAGE_HINTS: Readonly<Record<Kojo2CutoverStage, string>> = {
  'v1-only': '老写法照旧，2.0 文件打不开（缺省：切不动比切错便宜）',
  dual: '老 .kojo 一行都不用动，只有 .kojo2 走 2.0；新写的口上文件用这一档',
  '2.0-default': '新 .kojo2 走 2.0，老 .kojo 看正文像不像 2.0 再决定；判不出来时按 v1 打开',
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
  return kojo2StageAllowsSurface(stage)
    ? '这一档已生效：已打开的标签会立刻按新档重挂。但语言面与配色是在窗口启动时装配的，重载窗口后新开的 .kojo2 才会完整上色、出诊断。'
    : '已退回「只认 v1」：已打开的标签会立刻回到老写法。2.0 面要重载窗口才会彻底摘掉（本窗口里已经挂上的那一套仍留着）。';
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
 *    `dual`，等于"恢复出厂了但 2.0 面还开着"；
 * 2. 控制器 `reset()`——回 `v1-only`、清空全部单文件破例、删掉盘上的计划。
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
 * 设置页里的「Kojo 2.0」分区：三态单选 + 每档人话 + 单文件破例清单（可撤）+ 恢复出厂。
 *
 * 订阅只订控制器一张表（阶段 / override / 持久化状态都在同一份快照里）；卸载即退订。
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
    <div style={styles.group} data-kojo2-cutover="root" data-kojo2-stage={snapshot.stage}>
      <div role="heading" aria-level={4} style={styles.title}>
        Kojo 2.0
      </div>
      <div style={styles.lead}>
        2.0 是新的口上写法；这一档决定编辑器认不认它。切档不动任何文件内容。
      </div>

      <div role="radiogroup" aria-label="Kojo 2.0 档位" style={styles.stageList}>
        {KOJO2_CUTOVER_STAGES.map((stage) => {
          const selected = snapshot.stage === stage;
          return (
            <label
              key={stage}
              data-kojo2-stage={stage}
              data-kojo2-selected={selected ? '1' : '0'}
              style={selected ? styles.stageRowSelected : styles.stageRow}
            >
              <input
                type="radio"
                name="kojo2-cutover-stage"
                value={stage}
                checked={selected}
                onChange={() => choose(stage)}
                style={styles.radio}
              />
              <span style={styles.stageBody}>
                <span style={styles.stageTitle}>
                  {STAGE_TITLES[stage]}
                  {selected ? <span style={styles.currentBadge}>当前</span> : null}
                </span>
                <span style={styles.hint}>{STAGE_HINTS[stage]}</span>
              </span>
            </label>
          );
        })}
      </div>

      {needsReload ? (
        <div style={styles.notice} role="status" data-kojo2-reload-notice="1">
          {kojo2ReloadNotice(snapshot.stage)}
        </div>
      ) : null}

      <div style={styles.subTitle}>单文件破例</div>
      {snapshot.overrides.length === 0 ? (
        <div style={styles.hint} data-kojo2-overrides="empty">
          还没有任何单文件破例：所有文件都按上面的档位走。
        </div>
      ) : (
        <ul style={styles.overrideList} data-kojo2-overrides={String(snapshot.overrides.length)}>
          {snapshot.overrides.map((entry) => (
            <li
              key={entry.filePath}
              style={styles.overrideRow}
              data-kojo2-override={entry.filePath}
            >
              <span style={styles.overridePath} title={entry.filePath}>
                {entry.filePath}
              </span>
              <span style={styles.overrideParser}>
                {entry.parser === 'kojo2' ? '按 2.0' : '按 v1'}
              </span>
              <button
                type="button"
                style={styles.linkButton}
                onClick={() => clearOverride(entry.filePath)}
                aria-label={`撤销 ${entry.filePath} 的单文件破例`}
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}

      <div style={styles.footer}>
        <button type="button" style={styles.ghostButton} onClick={factoryReset}>
          恢复出厂
        </button>
        <span style={styles.hint}>
          回到「只认 v1」并清空全部单文件破例；不动任何文件。
        </span>
      </div>

      {snapshot.persisted ? null : (
        <div style={styles.hint} data-kojo2-persisted="0">
          这次改动只在本会话生效：存储不可写（隐私模式 / 空间已满）。
        </div>
      )}
    </div>
  );
}

/* ============================== 样式（内联 token） ============================== */

const styles = {
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 14,
    paddingTop: 12,
    borderTop: '1px solid var(--border-subtle, #2f363d)',
  },
  title: {
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.02em',
    color: 'var(--fg, #d7dce2)',
  },
  lead: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--fg-dim, #8b949e)',
  },
  stageList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  stageRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '7px 9px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle, #2f363d)',
    background: 'var(--bg-2, #24292f)',
    cursor: 'pointer',
  },
  stageRowSelected: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '7px 9px',
    borderRadius: 6,
    border: '1px solid var(--accent, #4c8bf5)',
    background: 'var(--accent-dim, rgb(76 139 245 / 0.22))',
    cursor: 'pointer',
  },
  radio: {
    marginTop: 2,
    accentColor: 'var(--accent, #4c8bf5)',
  },
  stageBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  stageTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: 'var(--fg, #d7dce2)',
  },
  currentBadge: {
    padding: '0 5px',
    borderRadius: 999,
    fontSize: 10,
    lineHeight: '16px',
    color: 'var(--accent-text, #6ea8ff)',
    border: '1px solid var(--accent, #4c8bf5)',
  },
  notice: {
    padding: '7px 9px',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--fg, #d7dce2)',
    background: 'var(--bg-3, #2b3138)',
    borderLeft: '2px solid var(--accent, #4c8bf5)',
  },
  subTitle: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--fg, #d7dce2)',
  },
  hint: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--fg-dim, #8b949e)',
  },
  overrideList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  overrideRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    borderRadius: 6,
    background: 'var(--bg-2, #24292f)',
    border: '1px solid var(--border-subtle, #2f363d)',
  },
  overridePath: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    color: 'var(--fg, #d7dce2)',
  },
  overrideParser: {
    flexShrink: 0,
    fontSize: 11,
    color: 'var(--accent-text, #6ea8ff)',
  },
  linkButton: {
    flexShrink: 0,
    padding: '1px 6px',
    borderRadius: 5,
    fontSize: 11,
    color: 'var(--fg, #d7dce2)',
    background: 'transparent',
    border: '1px solid var(--border, #3a424b)',
    cursor: 'pointer',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  ghostButton: {
    padding: '3px 9px',
    borderRadius: 6,
    fontSize: 12,
    color: 'var(--fg, #d7dce2)',
    background: 'transparent',
    border: '1px solid var(--border-strong, #4a545f)',
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;
