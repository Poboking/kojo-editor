import type { CharaInfo, FileIO, GameAdapter, GameProject, Plugin, VariableSchema } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERATW } from './constants';
import { parseCharaCsv, parseCharaNoFromFileName, parseKojoDirName } from './chara-csv';
import { createEratwFamilyIndex } from './family-index';
import { createEratwConventions } from './conventions';
import { loadEratwVariableSchema } from './variable-schema';
import { loadEratwCallProtocol, type EratwCallProtocol } from './call-protocol';

/**
 * eraTW 适配器插件 —— 本项目**唯一**允许知道"eraTW / 口上 / CHARA CSV / sav"这些字眼的地方。
 *
 * 职责（架构文档 §5.1 / §5.7）：
 * - detect：识别 eraTW 工程目录（黑盒，内核只调用不感知）；
 * - loadProject：解析 CHARA CSV 映射、定位口上域与 sav 目录、提议可写路径；
 * - （v0.2+）functionFamilyIndex / variableSchema / conventions / scaffold。
 *
 * 槽位与服务：注册 `game.adapter` 槽位（onboarding 轮询）；
 * 按 ADR-0002 **不** provide 全局 `game.adapter` 服务键（多适配器共存需要）。
 */
export function createEratwAdapterPlugin(): Plugin {
  return {
    id: 'eratw-adapter',
    version: '0.2.0',
    requires: ['kernel.io'],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');

      /** 变量字典（每次 loadProject 时按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 口上调用协议（v0.2 第十批；loadProject 时解析路由表，失败 → undefined 优雅降级） */
      let currentProtocol: EratwCallProtocol | undefined;

      const adapter: GameAdapter = {
        gameId: ERATW.gameId,
        displayName: ERATW.displayName,
        functionFamilyIndex: createEratwFamilyIndex(),
        // 覆盖规则消费已解析的路由协议（loadProject 时填充；缺省 → 规则降级）。
        conventions: createEratwConventions(() => currentProtocol),
        get variableSchema() {
          return currentSchema;
        },
        get kojoCallProtocol() {
          return currentProtocol;
        },

        async detect(rootDir: string): Promise<boolean> {
          // 特征组合：口上・消息域目录 + Chara CSV 目录（同时存在才成局）
          const kojoRoot = join(rootDir, ...ERATW.detect.kojoRoot);
          if (!(await io.exists(kojoRoot))) return false;
          const charaDir = join(rootDir, ...ERATW.detect.charaCsvDir);
          return io.exists(charaDir);
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERATW.detect.charaCsvDir);
          const personalKojo = join(rootDir, ...ERATW.paths.personalKojo);

          const charaIndex = new Map<number, CharaInfo>();

          // ---- 1. CHARA CSV → 编号 / 名前 / 呼び名 ----
          const csvEntries = await io.listDir(charaDir);
          const csvFiles = csvEntries.filter(
            (e) => !e.isDirectory && /\.csv$/i.test(e.name) && ERATW.charaCsvPattern.test(e.name),
          );

          for (const entry of csvFiles) {
            const noFromName = parseCharaNoFromFileName(entry.name, ERATW.charaCsvPattern);
            let parsed: ReturnType<typeof parseCharaCsv> = { no: null, name: null, callName: null };
            try {
              const tf = await io.readText(entry.path);
              parsed = parseCharaCsv(tf.text);
            } catch (err) {
              ctx.log.warn(`CHARA CSV 读取失败（跳过该文件）：${entry.path} — ${String(err)}`);
            }
            const no = parsed.no ?? noFromName;
            if (no === null) {
              ctx.log.warn(`无法确定角色编号（跳过）：${entry.name}`);
              continue;
            }
            // 名称回退链：名前 行 → 文件名剩余部分 → `Chara{n}`（显式回退，绝不静默丢弃）
            const nameFromFile = entry.name.replace(/\.csv$/i, '').replace(/^Chara\d+\s*/i, '').trim();
            const info: CharaInfo = {
              no,
              name: parsed.name ?? (nameFromFile.length > 0 ? nameFromFile : `Chara${no}`),
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. 個人口上目录 → 绑定 kojoDir ----
          const kojoEntries = await io.listDir(personalKojo);
          let bound = 0;
          for (const e of kojoEntries) {
            if (!e.isDirectory) continue;
            const parsed = parseKojoDirName(e.name);
            if (!parsed) {
              ctx.log.warn(`個人口上目录名不符合「{三位编号} {名称}」约定（跳过）：${e.name}`);
              continue;
            }
            const info = charaIndex.get(parsed.no);
            if (info) {
              info.kojoDir = e.path;
            } else {
              // 口上目录存在但 CSV 中无该编号：补最小条目（不猜测显示名，用目录 label）
              charaIndex.set(parsed.no, { no: parsed.no, name: parsed.label, kojoDir: e.path });
            }
            bound++;
          }

          // ---- 3. 变量字典（CFLAG/Talent/… 名称表；条件抽取的语义标注来源） ----
          currentSchema = await loadEratwVariableSchema({
            io,
            csvDir: join(rootDir, ...ERATW.csvDir),
            log: ctx.log,
          });

          // ---- 4. 口上调用协议（路由表 → 槽位语义表；失败降级 undefined） ----
          currentProtocol = await loadEratwCallProtocol({
            io,
            routeFile: join(rootDir, ...ERATW.paths.kojoMessageRoute),
            log: ctx.log,
          });

          ctx.log.info(
            `eraTW 工程加载完成：${charaIndex.size} 个角色（${bound} 个有口上目录），` +
              `口上根：${personalKojo}`,
          );

          return {
            rootDir,
            adapterId: ERATW.gameId,
            kojoPaths: [personalKojo],
            savDir: join(rootDir, ...ERATW.savDir),
            // 提议可写路径（用户批准后由内核 io 放行；见 ProjectService.approveWritablePaths）
            // sav 目录随 v0.2 第十五批加入提议：注入器写档需要（kernel 第一道闸
            // 判定域 = 批准的 writablePaths；Rust 第二道闸本就允许项目根整体）。
            writablePaths: [personalKojo, join(rootDir, ...ERATW.savDir)],
            charaIndex,
          };
        },
      };

      ctx.slots.register('game.adapter', { id: `${ERATW.gameId}-adapter`, adapter });
    },
  };
}
