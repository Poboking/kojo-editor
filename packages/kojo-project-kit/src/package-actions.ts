/**
 * 包操作控制器（2026-10-12 口上项目批 P-D 导出 / P-E 部署）。
 *
 * 面板上的「导出 / 部署」都是**异步且必须向用户交代结果**的动作，共用底部一条状态条。
 * 把这套时序（忙碌 → 成功自动收起 / 失败常驻等用户读原因）从插件闭包抽到本模块：
 * 插件只接线，逻辑无需渲染面板即可单测。
 *
 * 导出的落点在写白名单**之外**是设计意图（导出即落到桌面 / 发布目录）：授权来自
 * 用户在系统对话框里的显式选择，对话框与写盘绑定在同一平台命令内（JS 拿不到落点
 * 决定权）；工作区原件只读不动。
 *
 * 2026-10-12 导出批：导出从「整目录复制」改成「**制品 ZIP**」——工作区里的 `.kojo`
 * 先转译成 `.ERB` 再打包（引擎不认 `.kojo`），规则见 `artifact.ts`。转译在内存里做，
 * 且**先于**弹对话框完成：不会让用户选完落点才吃到一个错误。
 *
 * 部署正相反——落点在游戏目录内，**写白名单这道闸必须过**（详见 `deploy.ts`）。
 */

import {
  basename,
  buildZip,
  type FileIO,
  type Logger,
  type OpJournal,
  verifyZipRoundtrip,
  type ZipEntry,
} from '@kojo/plugin-api';
import {
  planArtifacts,
  readPackageSources,
  type ArtifactPlan,
  type KojoCompiler,
} from '@kojo/kojo-project-kit';
import { deployPackage, type DeployTargetOk, type PendingDeploy } from './deploy';

/** 包操作反馈种类 */
export type PanelStatusKind = 'busy' | 'ok' | 'err';

/** 包操作反馈内容（面板底部状态条；null = 无消息，不渲染不占版面） */
export interface PanelStatus {
  kind: PanelStatusKind;
  text: string;
}

/** 成功态自动收起延时；失败态不自动收起（原因要留给用户读完） */
export const STATUS_OK_DISMISS_MS = 8000;

export interface PackageActionsDeps {
  io: FileIO;
  log: Logger;
  /** 状态变化后通知面板重渲染 */
  notify(): void;
  /**
   * `.kojo` → 产物字节（来自 `SugarTranspileService.compileToBytes`）。
   * 语法糖服务缺席时它抛错 → 含 `.kojo` 的包被整体拒绝，绝不静默少转文件。
   */
  compileKojo: KojoCompiler;
  /**
   * 批操作 journal（2026-10-18 undo 覆盖批，additive 可选）：在场时部署整包进账，
   * OpsHistoryOverlay 可整批撤销；缺席 = 旧的不进账行为。
   */
  journal?: Pick<OpJournal, 'begin' | 'record' | 'commit' | 'abort'>;
}

/**
 * 组好一个发布 ZIP（**不碰目的地**：落点由后续的平台对话框决定）。
 *
 * 包内根 = 源目录名，于是作者解压出来就是一个文件夹，与 README 里
 * 「把本包整个文件夹放入游戏目录」的说法对得上。
 *
 * 两条往返契约（W14，规则见 `@kojo/plugin-api` 的 `zip.ts` 与共享表
 * `plugin-api/fixtures/zip-roundtrip/contract.json`）都在这里生效，**都在弹对话框之前**：
 * 1. `contract: 'extractable'`：条目名与规模先过一遍平台解包器的闸（无目录条目、
 *    深度/条目数/总字节不超限额、无重名含大小写折叠）——违例在写第一个字节前抛；
 * 2. `verifyZipRoundtrip`：把打好的字节读回来逐条目核名字 / 字节数 / CRC / 内容，
 *    导出链路因此第一次有了"我写出去的东西确实能被读回来"的验证回路。
 */
export async function buildPackageZip(
  io: FileIO,
  absDir: string,
  compile: KojoCompiler,
): Promise<{ fileName: string; bytes: Uint8Array; plan: ArtifactPlan }> {
  const sources = await readPackageSources(io, absDir);
  const plan = planArtifacts(sources, compile);
  const root = basename(absDir.replace(/[\\/]+$/, ''));
  // 根路径（`/` 或 `C:\`）会得出 '' 或 '.' —— 与其打一个没有根目录的空包，
  // 让作者解压出一堆散落文件，不如直接报错
  if (root.length === 0 || root === '.' || root === '..') {
    throw new Error(`无法从源路径取到包目录名：${absDir}`);
  }
  const entries: ZipEntry[] = plan.entries.map((e) => ({
    name: `${root}/${e.relPath}`,
    data: e.bytes,
  }));
  const bytes = await buildZip(entries, { contract: 'extractable' });
  const problem = await verifyZipRoundtrip(bytes, entries);
  if (problem !== null) throw new Error(`导出的包没能通过往返自证：${problem}`);
  return { fileName: `${root}.zip`, bytes, plan };
}

export interface PackageActions {
  /** 当前反馈内容（null = 无） */
  status(): PanelStatus | null;
  /** 用户手动关闭反馈条 */
  dismiss(): void;
  /** 插件卸载时清理待触发的自动收起定时器 */
  dispose(): void;
  /** 导出包到用户选定的目录（平台对话框 + 整目录复制） */
  exportArtifact(absDir: string, displayName: string): void;
  /**
   * 部署包到游戏目录（P-E）。返回是否成功——向导据此决定自身是否关闭，
   * 失败时留着窗口让用户读状态条里的原因。
   */
  deployArtifact(pkg: PendingDeploy, target: DeployTargetOk): Promise<boolean>;
}

export function createPackageActions(deps: PackageActionsDeps): PackageActions {
  let current: PanelStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const set = (next: PanelStatus | null, autoDismissMs?: number): void => {
    clearTimer();
    current = next;
    if (next !== null && autoDismissMs !== undefined) {
      timer = setTimeout(() => {
        current = null;
        timer = null;
        deps.notify();
      }, autoDismissMs);
    }
    deps.notify();
  };

  return {
    status: () => current,
    dismiss: () => set(null),
    dispose: clearTimer,

    exportArtifact(absDir: string, displayName: string): void {
      set({ kind: 'busy', text: `正在导出「${displayName}」…` });
      // 打包（转译 + 组装 ZIP）与"选落点"是两件事：先全量在内存里做好，
      // 再弹对话框。这样**转译失败根本不会打扰用户**（不弹一个注定失败的框），
      // 而对话框一旦弹出就必然成功写盘——用户不会选完目录才吃到一个错误。
      void buildPackageZip(deps.io, absDir, deps.compileKojo)
        .then(({ fileName, bytes, plan }) => {
          if (bytes.length === 0) throw new Error('包是空的，没有可导出的文件');
          return deps.io
            .exportFile(fileName, bytes, { title: `导出「${displayName}」为…` })
            .then((target) => ({ target, plan }));
        })
        .then(({ target, plan }) => {
          // 对话框里取消：既非结果也非错误，收起忙碌态即可（不打扰）
          if (target === null) set(null);
          else
            set(
              {
                kind: 'ok',
                text: `已导出「${displayName}」${plan.transpiled} 个 .kojo 转译为 .ERB、` +
                  `${plan.passthrough} 个文件原样打包 → ${target}`,
              },
              STATUS_OK_DISMISS_MS,
            );
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          deps.log.warn(`导出失败：${absDir} — ${reason}`);
          set({ kind: 'err', text: `导出失败：${reason}` });
        });
    },

    async deployArtifact(pkg: PendingDeploy, target: DeployTargetOk): Promise<boolean> {
      set({ kind: 'busy', text: `正在部署「${pkg.displayName}」…` });
      try {
        const written = await deployPackage({
          io: deps.io,
          srcDir: pkg.absDir,
          targetDir: target.targetDir,
          compile: deps.compileKojo,
          journal: deps.journal,
        });
        set(
          {
            kind: 'ok',
            text: `已部署「${pkg.displayName}」${written} 个文件 → ${target.targetDir}`,
          },
          STATUS_OK_DISMISS_MS,
        );
        return true;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.log.warn(`部署失败：${pkg.absDir} → ${target.targetDir} — ${reason}`);
        set({ kind: 'err', text: `部署失败：${reason}` });
        return false;
      }
    },
  };
}
