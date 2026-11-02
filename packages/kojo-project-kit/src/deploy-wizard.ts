/**
 * 部署到游戏目录向导（2026-10-12 口上项目批 P-E；`ui.overlay` 贡献）。
 *
 * 链路：包行「部署」按钮 → 插件把待部署请求存入闭包（**overlay 组件无 props，
 * payload 不经组件**）→ 发 `ui.overlay.open` 打开本向导 → 选目标角色
 * （新建向导 P-C 写在制品 meta 里的角色号自动预选，导入的包由用户挑）
 * → 落点预览 `<角色口上目录>/<包目录名>/` → 用户确认 → 字节级复制 → 状态条交代结果。
 *
 * 双真相源的收口就在这一步：窗口里把「工作区为权威、游戏目录只是部署目标」讲明白，
 * 并把两道前置闸门做成**看得见的状态**——游戏目录只读（未批准写权限）与
 * 目标已存在，都直接禁用按钮并说明下一步，而不是让用户点下去吃异常。
 *
 * 第三道闸门是**发布诚实闸**（2026-11-02 KW-1，additive）：包里若还留着 Kojo 2.0 源，
 * 这一版**不会**把它们转译成游戏读得到的文件——原样写进去的结果还是"装了但不生效"。
 * 这条点名摆在**确认框里**（作者按「部署」之前），按钮照旧可用：出路不剥夺，
 * 只是不再让作者以为已经装好了。判据与清单都来自 `artifact.ts` 那一处（与导出腿同源，
 * 两腿共用同一枚 builder，不各抄一套）。
 */

import { createElement as h, useEffect, useMemo, useState } from 'react';
import type { GameProject } from '@kojo/plugin-api';
import { KOJO2_PROBE_FAILED_NOTICE, kojo2UntranspiledNotice, type Kojo2UntranspiledSource } from './artifact';
import { resolveDeployTarget, type DeployTargetOk, type PendingDeploy } from './deploy';

/**
 * 部署向导（`ui.overlay` 贡献的组件半边）。
 *
 * overlay 的**贡献 id** 由 adapter 定义并注册——共享层只管「这个窗长什么样、
 * 点了按钮做什么」，不认任何具体游戏的命名空间。
 */

export interface DeployKojoWizardDeps {
  /** 当前游戏项目（角色表 + 口上目录来源；无项目时向导显式不可用） */
  gameProject(): GameProject | null;
  /** 落点是否在内核写白名单内（游戏目录默认只读） */
  writable(targetDir: string): boolean;
  /** 落点是否已存在（**预览用**；真正的拒绝由 `deployPackage` 的前置守卫兜底） */
  checkTargetExists(targetDir: string): Promise<boolean>;
  /** 读取待部署请求（null = 无——向导显式降级） */
  pending(): PendingDeploy | null;
  /** 清除待部署请求（完成 / 取消时） */
  clearPending(): void;
  close(): void;
  /** 发起部署（控制器负责状态条与落盘）；返回是否成功，成功即关窗 */
  deploy(pkg: PendingDeploy, target: DeployTargetOk): Promise<boolean>;
  /**
   * 确认框用的**只读前置核对**（additive，2026-11-02 发布诚实闸）。
   *
   * 实现在共享层 `artifact.ts` 的 `listKojo2Sources`，由 adapter 用自己的 `io` 接上：
   * 只取路径、不读字节、一次都不叫转译器——作者此刻只是在"要不要发"之前看一眼。
   * 本向导因此依旧不碰磁盘（与 `checkTargetExists` 同一形态）。
   *
   * 缺席（adapter 没接）⇒ 这一行不出现，窗口与历史逐字一致；抛错 ⇒ 明说"没能核对"，
   * 不冒认"这个包没有 2.0 源"。
   */
  kojo2Sources?(absDir: string): Promise<readonly Kojo2UntranspiledSource[]>;
}

/** 部署向导 overlay 组件（createElement 风格；壳层 PanelBody 无 props 渲染） */
export function createDeployKojoWizard(deps: DeployKojoWizardDeps): () => unknown {
  return function DeployKojoWizard(): unknown {
    const pending = deps.pending();
    const gameProject = deps.gameProject();

    const [charaNo, setCharaNo] = useState<number | null>(pending?.charaNo ?? null);
    const [exists, setExists] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    /**
     * 确认框里的 2.0 源点名（发布诚实闸）。
     * `null` = 还没核完 / 本 adapter 没接这格 ⇒ 不渲染；`''` = **核对过、这个包没有** ⇒ 不渲染；
     * 其余 = 要上屏的那句白话（含数量与相对路径，或"没能核对"本身）。
     */
    const [kojo2Notice, setKojo2Notice] = useState<string>('');

    // 换包重新打开时回到该包自己的角色（导入的包无 meta → 回到未选）
    useEffect(() => {
      setCharaNo(pending?.charaNo ?? null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending?.absDir]);

    const target = useMemo(
      () => resolveDeployTarget(gameProject, charaNo, pending?.dirName ?? ''),
      [gameProject, charaNo, pending?.dirName],
    );
    const targetDir = target.ok ? target.targetDir : '';

    useEffect(() => {
      if (!targetDir) {
        setExists(null);
        return;
      }
      let cancelled = false;
      setExists(null);
      deps
        .checkTargetExists(targetDir)
        // 探测失败按「不存在」放行：这只是预览，真正的「不覆盖」由 deployPackage 守卫
        .catch(() => false)
        .then((v) => {
          if (!cancelled) setExists(v);
        });
      return () => {
        cancelled = true;
      };
    }, [deps, targetDir]);

    const charas = useMemo(() => {
      if (!gameProject) return [];
      return [...gameProject.charaIndex.values()].sort((a, b) => a.no - b.no);
    }, [gameProject]);

    // 发布诚实闸的只读前置核对（同「换包重开」的口径：按包目录重算，不看角色）。
    // 判据 / 文案都住在 `artifact.ts`，本窗口只负责把它摆进确认框——两腿共用同一枚清单。
    useEffect(() => {
      const absDir = pending?.absDir;
      const probe = deps.kojo2Sources;
      if (absDir === undefined || probe === undefined) {
        setKojo2Notice('');
        return;
      }
      let cancelled = false;
      setKojo2Notice('');
      probe(absDir)
        .then((items) => {
          if (!cancelled) setKojo2Notice(kojo2UntranspiledNotice(items) ?? '');
        })
        // 核对失败 ≠ "这个包没有 2.0 源"（读不到就冒认干净，比不核对更糟）
        .catch(() => {
          if (!cancelled) setKojo2Notice(KOJO2_PROBE_FAILED_NOTICE);
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deps, pending?.absDir]);

    /* ---------- 降级：无待部署请求 / 无游戏项目（不静默，各自讲清下一步） ---------- */
    if (!pending) {
      return h(
        'div',
        { className: 'wizard' },
        h('h3', null, '部署到游戏目录'),
        h('p', { className: 'dim' }, '当前没有要部署的包。请在「我的口上项目」中选择一个作者包再部署。'),
        h(
          'div',
          { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭'),
        ),
      );
    }

    if (!gameProject) {
      return h(
        'div',
        { className: 'wizard' },
        h('h3', null, '部署到游戏目录'),
        h('p', { className: 'dim' }, '当前无打开的游戏项目。落点来自项目里的角色口上目录，请先打开项目。'),
        h(
          'div',
          { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: deps.close }, '关闭'),
        ),
      );
    }

    const writable = targetDir.length > 0 && deps.writable(targetDir);

    const submit = async (): Promise<void> => {
      if (!target.ok) return;
      setBusy(true);
      const ok = await deps.deploy(pending, target);
      setBusy(false);
      if (ok) {
        deps.clearPending();
        deps.close();
      }
    };

    const cancel = (): void => {
      deps.clearPending();
      deps.close();
    };

    return h(
      'div',
      { className: 'wizard' },
      h('h3', null, '部署到游戏目录'),

      // 源（只读展示）
      h(
        'div',
        { className: 'wizard-preview' },
        h(
          'div',
          null,
          h('span', { className: 'wizard-label' }, '工作区包'),
          h('code', null, pending.absDir),
        ),
        h('div', { className: 'dim' }, '部署 = 把这一份副本写进游戏目录；工作区仍是权威，改回来请改工作区。'),
      ),

      // 目标角色（meta 里有就预选）
      h(
        'label',
        { className: 'wizard-field' },
        h('span', { className: 'wizard-label' }, '目标角色'),
        h(
          'select',
          {
            value: charaNo === null ? '' : String(charaNo),
            onChange: (e: { target: { value: string } }) =>
              setCharaNo(e.target.value === '' ? null : Number(e.target.value)),
          },
          h('option', { value: '' }, charas.length > 0 ? '选择角色…' : '（游戏项目无角色表）'),
          charas.map((c) =>
            h(
              'option',
              { key: c.no, value: String(c.no) },
              c.kojoDir ? `#${c.no} ${c.name}` : `#${c.no} ${c.name}（无口上目录）`,
            ),
          ),
        ),
      ),

      // 落点预览 / 无法解析的原因
      h(
        'div',
        { className: 'wizard-preview' },
        h(
          'div',
          null,
          h('span', { className: 'wizard-label' }, '落点'),
          h('code', null, target.ok ? target.targetDir : '—'),
        ),
        !target.ok ? h('div', { className: 'wizard-warn' }, target.reason) : null,
      ),

      // 两道前置闸门：可见的状态，而不是等用户点下去吃异常
      target.ok && !writable
        ? h(
            'div',
            { className: 'wizard-warn' },
            '游戏目录当前只读：请先在项目视图批准该角色口上目录的写权限，再回来部署。',
          )
        : null,
      target.ok && writable && exists === true
        ? h(
            'div',
            { className: 'wizard-warn' },
            '目标目录已存在：部署不会覆盖。请先在游戏目录里移除或改名，或换个包名再部署。',
          )
        : null,
      target.ok && writable && exists === null
        ? h('div', { className: 'dim' }, '正在确认目标是否已存在…')
        : null,

      // 第三道闸门：包里的 Kojo 2.0 源（这一版不转译）。**不禁用按钮**——出路照旧在作者手里，
      // 但"部署成功"从此不再等于"游戏里有了东西"。同一句白话由 `artifact.ts` 的单源 builder
      // 给出，与导出腿、与部署结果通知完全同形（判据只此一处）。
      kojo2Notice !== '' ? h('div', { className: 'wizard-warn' }, kojo2Notice) : null,

      // 动作
      h(
        'div',
        { className: 'wizard-actions' },
        h('button', { className: 'ghost small', onClick: cancel, disabled: busy }, '取消'),
        h(
          'button',
          {
            className: 'small primary',
            // 写权限没批 / 目标已存在 / 落点无法解析 → 禁用，且上面已说明下一步
            disabled: !target.ok || busy || !writable || exists !== false,
            onClick: () => void submit(),
          },
          busy ? '部署中…' : '部署到游戏目录',
        ),
      ),
    );
  };
}
