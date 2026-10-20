/**
 * omp 内置命令速查：全部命令 / 组合用法两个视图，支持过滤与一键复制。
 * 版本提示：传入本机已安装版本，与速查基准版本不一致时在头部提示一行。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { OMP_COMMANDS, OMP_PINNED_COMMANDS, OMP_VERSION, filterOmpCommands, findOmpCommand, versionMismatch } from "../ompCommands";
import { OMP_COMBOS, filterOmpCombos } from "../ompCombos";
import { copyText } from "../clipboard";
import { Modal } from "./ui";
import "./CheatSheet.css";

interface CheatSheetDialogProps {
  onClose: () => void;
  /** 本机已安装 omp 版本；null/缺省表示未知，不做版本提示。 */
  installedVersion?: string | null;
}

const COPIED_MS = 1500;
const FAILED_MS = 4000;

export function CheatSheetDialog({ onClose, installedVersion = null }: CheatSheetDialogProps) {
  const [tab, setTab] = useState<"commands" | "combos">("commands");
  const [query, setQuery] = useState("");
  // 已复制按钮的 key（1.5 秒后还原）；复制失败改为同屏可见提示。
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const feedbackTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    },
    [],
  );

  async function copy(key: string, text: string) {
    const ok = await copyText(text);
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    if (!ok) {
      setCopied(null);
      setCopyFailed(true);
      feedbackTimer.current = window.setTimeout(() => setCopyFailed(false), FAILED_MS);
      return;
    }
    setCopyFailed(false);
    setCopied(key);
    feedbackTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  }

  const groups = useMemo(() => filterOmpCommands(OMP_COMMANDS, query), [query]);
  const combos = useMemo(() => filterOmpCombos(OMP_COMBOS, query), [query]);
  const total = OMP_COMMANDS.reduce((n, g) => n + g.commands.length, 0);
  const shown = groups.reduce((n, g) => n + g.commands.length, 0);
  // 空查询时在顶部加一个「常用」分组（引用同一批命令对象，不计入总数）；过滤时隐藏，避免重复行。
  const pinnedGroup = useMemo(
    () => ({
      group: "常用",
      commands: OMP_PINNED_COMMANDS.map((n) => findOmpCommand(n)).filter((c) => c !== undefined),
    }),
    [],
  );
  const displayGroups = query.trim() === "" ? [pinnedGroup, ...groups] : groups;

  return (
    <Modal
      title="命令速查"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <p className="cheatsheet-head">
        {tab === "commands"
          ? query.trim() === ""
            ? `基于 omp ${OMP_VERSION} · 共 ${total} 条内置命令`
            : `基于 omp ${OMP_VERSION} · 匹配 ${shown} / ${total} 条`
          : `基于 omp ${OMP_VERSION} · ${combos.length} 个场景`}
      </p>
      {versionMismatch(installedVersion) ? (
        <p className="cheatsheet-version-note">
          你安装的是 {installedVersion}，速查基于 {OMP_VERSION}，个别命令可能有差异
        </p>
      ) : null}
      <div className="cheatsheet-toolbar">
        <div className="cheatsheet-tabs" role="tablist" aria-label="速查视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "commands"}
            className={tab === "commands" ? "cheatsheet-tab is-active" : "cheatsheet-tab"}
            onClick={() => setTab("commands")}
          >
            全部命令
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "combos"}
            className={tab === "combos" ? "cheatsheet-tab is-active" : "cheatsheet-tab"}
            onClick={() => setTab("combos")}
          >
            组合用法
          </button>
        </div>
        <input
          type="search"
          className="filter-input cheatsheet-filter"
          placeholder={tab === "commands" ? "按命令名、参数或中文说明过滤" : "按场景、命令或说明过滤"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="过滤命令"
          data-autofocus
        />
      </div>
      {copyFailed ? (
        <p className="cheatsheet-copy-error" role="status">
          复制失败：剪贴板不可用，请手动选择文本复制
        </p>
      ) : null}
      <div className="cheatsheet-list">
        {tab === "commands" ? (
          <>
            {shown === 0 ? <div className="pane-note">没有匹配的命令</div> : null}
            {displayGroups.map((g) => (
              <section className="cheatsheet-group" key={g.group}>
                <h3 className="cheatsheet-group-title">
                  {g.group}（{g.commands.length}）
                </h3>
                <ul className="cheatsheet-rows">
                  {g.commands.map((c) => (
                    <li className="cheatsheet-row" key={c.name}>
                      <div className="cheatsheet-main">
                        <div>
                          <span className="mono">/{c.name}</span>
                          {c.aliases.length > 0 ? (
                            <span className="cheatsheet-alias"> 别名 {c.aliases.join("、")}</span>
                          ) : null}
                        </div>
                        {c.args ? (
                          <div className="mono cheatsheet-args">
                            {c.args.split("|").map((p, i, a) => (
                              <Fragment key={i}>
                                {p}
                                {i < a.length - 1 ? (
                                  <>
                                    |<wbr />
                                  </>
                                ) : null}
                              </Fragment>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <span className="cheatsheet-zh">{c.zh}</span>
                      <span className="cheatsheet-actions">
                        <button
                          type="button"
                          className="cheatsheet-copy"
                          aria-label={`复制 /${c.name}`}
                          title={`复制 /${c.name}`}
                          onClick={() => void copy(`cmd:${g.group}:${c.name}`, `/${c.name}`)}
                        >
                          {copied === `cmd:${g.group}:${c.name}` ? "已复制 ✓" : "复制"}
                        </button>
                        {c.args ? (
                          <button
                            type="button"
                            className="cheatsheet-copy"
                            aria-label={`复制 /${c.name} 的含参数模板`}
                            title={`复制 /${c.name} ${c.args}`}
                            onClick={() => void copy(`tpl:${g.group}:${c.name}`, `/${c.name} ${c.args}`)}
                          >
                            {copied === `tpl:${g.group}:${c.name}` ? "已复制 ✓" : "参数"}
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        ) : (
          <>
            {combos.length === 0 ? <div className="pane-note">没有匹配的场景</div> : null}
            {combos.map((combo) => (
              <section className="cheatsheet-combo" key={combo.id}>
                <header className="cheatsheet-combo-head">
                  <div>
                    <h3 className="cheatsheet-combo-title">{combo.title}</h3>
                    <p className="cheatsheet-combo-when">{combo.when}</p>
                  </div>
                  <button
                    type="button"
                    className="cheatsheet-copy cheatsheet-copy-all"
                    aria-label={`复制全部：${combo.title}`}
                    title="按顺序复制全部命令，每步一行"
                    onClick={() =>
                      void copy(
                        `combo:${combo.id}`,
                        combo.steps.map((s) => s.cmd).join("\n"),
                      )
                    }
                  >
                    {copied === `combo:${combo.id}` ? "已复制 ✓" : "复制全部"}
                  </button>
                </header>
                <ol className="cheatsheet-steps">
                  {combo.steps.map((s, i) => (
                    <li className="cheatsheet-step" key={`${combo.id}:${i}`}>
                      <span className="mono cheatsheet-step-cmd">{s.cmd}</span>
                      <span className="cheatsheet-step-note">{s.note}</span>
                      <button
                        type="button"
                        className="cheatsheet-copy"
                        aria-label={`复制步骤：${s.cmd}`}
                        title={`复制 ${s.cmd}`}
                        onClick={() => void copy(`step:${combo.id}:${i}`, s.cmd)}
                      >
                        {copied === `step:${combo.id}:${i}` ? "已复制 ✓" : "复制"}
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </>
        )}
      </div>
      <p className="cheatsheet-foot">
        自定义命令、技能（/skill:xxx）和插件命令不在此列；实时补全以在 omp 中输入 /
        为准。
      </p>
    </Modal>
  );
}
