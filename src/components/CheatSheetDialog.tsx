/**
 * omp 命令速查：入门路径 / 全部命令 / 组合用法 / 终端命令四个视图，支持过滤与一键复制。
 * 版本提示：传入本机已安装版本，与速查基准版本不一致时在头部提示一行。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  OMP_COMMANDS,
  OMP_PINNED_COMMANDS,
  OMP_VERSION,
  filterOmpCommands,
  findOmpCommand,
  versionMismatch,
  type OmpCommand,
} from "../ompCommands";
import { findOmpDetail } from "../ompCommandDetails";
import { OMP_CLI_COMMANDS, OMP_CLI_VERSION } from "../ompCliCommands";
import { OMP_LEARNING_PATHS } from "../ompLearningPaths";
import { OMP_COMBOS, filterOmpCombos } from "../ompCombos";
import { copyText } from "../clipboard";
import { Modal } from "./ui";
import { useAlive } from "./useOmpOp";
import "./CheatSheet.css";

interface CheatSheetDialogProps {
  onClose: () => void;
  /** 本机已安装 omp 版本；null/缺省表示未知，不做版本提示。 */
  installedVersion?: string | null;
}

type Tab = "paths" | "commands" | "combos" | "cli";

const TABS: { key: Tab; label: string }[] = [
  { key: "paths", label: "入门路径" },
  { key: "commands", label: "全部命令" },
  { key: "combos", label: "组合用法" },
  { key: "cli", label: "终端命令" },
];

const COPIED_MS = 1500;
const FAILED_MS = 4000;

export function CheatSheetDialog({ onClose, installedVersion = null }: CheatSheetDialogProps) {
  const [tab, setTab] = useState<Tab>("paths");
  const [query, setQuery] = useState("");
  // 已复制按钮的 key（1.5 秒后还原）；复制失败改为同屏可见提示。
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const feedbackTimer = useRef<number | null>(null);
  const alive = useAlive();

  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    },
    [],
  );

  async function copy(key: string, text: string) {
    const ok = await copyText(text);
    if (!alive.current) return;
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

  /** 复制按钮：同一套「已复制 ✓」时序，key 唯一即可。 */
  const copyButton = (key: string, text: string, label: string, aria: string): ReactNode => (
    <button
      type="button"
      className="cheatsheet-copy"
      aria-label={aria}
      title={aria}
      onClick={() => void copy(key, text)}
    >
      {copied === key ? "已复制 ✓" : label}
    </button>
  );

  /** 跨视图跳到某条命令：切到命令页并把过滤框设成它。 */
  function jumpToCommand(name: string): void {
    setTab("commands");
    setQuery(name);
  }

  const groups = useMemo(() => filterOmpCommands(OMP_COMMANDS, query), [query]);
  const combos = useMemo(() => filterOmpCombos(OMP_COMBOS, query), [query]);
  const total = OMP_COMMANDS.reduce((n, g) => n + g.commands.length, 0);
  const builtin = OMP_COMMANDS.filter((g) => g.group !== "扩展命令").reduce((n, g) => n + g.commands.length, 0);
  const shown = groups.reduce((n, g) => n + g.commands.length, 0);
  const paths = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return OMP_LEARNING_PATHS;
    return OMP_LEARNING_PATHS.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.goal.toLowerCase().includes(q) ||
        p.steps.some((s) => s.cmd.toLowerCase().includes(q) || s.why.toLowerCase().includes(q)),
    );
  }, [query]);
  // 终端子命令：名称/参数/中文说明/示例做子串匹配（单组，保持字母序）。
  const cli = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return OMP_CLI_COMMANDS;
    return OMP_CLI_COMMANDS.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.args.toLowerCase().includes(q) ||
        c.zh.toLowerCase().includes(q) ||
        c.examples.some((ex) => ex.toLowerCase().includes(q)),
    );
  }, [query]);
  // 空查询时在顶部加一个「常用」分组（引用同一批命令对象，不计入总数）；过滤时隐藏，避免重复行。
  const pinnedGroup = useMemo(
    () => ({
      group: "常用",
      commands: OMP_PINNED_COMMANDS.map((n) => findOmpCommand(n)).filter((c) => c !== undefined),
    }),
    [],
  );
  const displayGroups = query.trim() === "" ? [pinnedGroup, ...groups] : groups;
  const head =
    tab === "commands"
      ? query.trim() === ""
        ? `基于 omp ${OMP_VERSION} · 共 ${total} 条斜杠命令（内置 ${builtin} + 扩展 ${total - builtin}），逐条带用法说明`
        : `基于 omp ${OMP_VERSION} · 匹配 ${shown} / ${total} 条`
      : tab === "combos"
        ? `基于 omp ${OMP_VERSION} · ${combos.length} 个场景，按顺序照抄即可`
        : tab === "paths"
          ? `${paths.length} 条学习路径 · 从「第一小时」开始，每条都能现在就试`
          : query.trim() === ""
            ? `基于 omp ${OMP_CLI_VERSION} · 共 ${OMP_CLI_COMMANDS.length} 个终端子命令`
            : `基于 omp ${OMP_CLI_VERSION} · 匹配 ${cli.length} / ${OMP_CLI_COMMANDS.length} 个终端子命令`;

  return (
    <Modal
      title="命令速查"
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <p className="cheatsheet-head">{head}</p>
      {versionMismatch(installedVersion) ? (
        <p className="cheatsheet-version-note">
          你安装的是 {installedVersion}，速查基于 {OMP_VERSION}，个别命令可能有差异
        </p>
      ) : null}
      <div className="cheatsheet-toolbar">
        <div className="cheatsheet-tabs" role="tablist" aria-label="速查视图">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? "cheatsheet-tab is-active" : "cheatsheet-tab"}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="filter-input cheatsheet-filter"
          placeholder={
            tab === "commands"
              ? "按命令名、参数、示例或中文说明过滤"
              : tab === "combos"
                ? "按场景、命令或说明过滤"
                : tab === "paths"
                  ? "按路径、命令或说明过滤"
                  : "按子命令、参数或中文说明过滤"
          }
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
        {tab === "paths" ? (
          <>
            {paths.length === 0 ? <div className="pane-note">没有匹配的路径</div> : null}
            {paths.map((p, pi) => {
              const prev = p.after === undefined ? undefined : OMP_LEARNING_PATHS.find((x) => x.id === p.after);
              return (
                <section className="cheatsheet-combo cheatsheet-path" key={p.id}>
                  <header className="cheatsheet-combo-head">
                    <div>
                      <h3 className="cheatsheet-combo-title">
                        <span className="cheatsheet-path-index">{pi + 1}</span>
                        {p.title}
                      </h3>
                      <p className="cheatsheet-combo-when">目标：{p.goal}</p>
                      {prev !== undefined ? (
                        <p className="cheatsheet-path-after">建议先学：{prev.title}</p>
                      ) : null}
                    </div>
                    {copyButton(
                      `path:${p.id}`,
                      p.steps.map((s) => s.tryIt).join("\n"),
                      "复制全部",
                      `复制路径全部命令：${p.title}`,
                    )}
                  </header>
                  <ol className="cheatsheet-steps">
                    {p.steps.map((s, i) => (
                      <li className="cheatsheet-step" key={`${p.id}:${i}`}>
                        <button
                          type="button"
                          className="cheatsheet-link mono cheatsheet-step-cmd"
                          title={`查看 /${s.cmd} 的完整说明`}
                          onClick={() => jumpToCommand(s.cmd)}
                        >
                          /{s.cmd}
                        </button>
                        <span className="cheatsheet-step-note">{s.why}</span>
                        {copyButton(`pathtry:${p.id}:${i}`, s.tryIt, "复制", `复制 ${s.tryIt}`)}
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })}
          </>
        ) : tab === "commands" ? (
          <>
            {shown === 0 ? <div className="pane-note">没有匹配的命令</div> : null}
            {displayGroups.map((g) => (
              <section className="cheatsheet-group" key={g.group}>
                <h3 className="cheatsheet-group-title">
                  {g.group}
                  <span className="cheatsheet-group-count">{g.commands.length}</span>
                </h3>
                <ul className="cheatsheet-rows">
                  {g.commands.map((c) => (
                    <CommandRow
                      key={`${g.group}:${c.name}`}
                      group={g.group}
                      command={c}
                      copied={copied}
                      copy={copy}
                      onJump={jumpToCommand}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        ) : tab === "cli" ? (
          <>
            {cli.length === 0 ? <div className="pane-note">没有匹配的终端子命令</div> : null}
            <section className="cheatsheet-group">
              <h3 className="cheatsheet-group-title">
                终端子命令<span className="cheatsheet-group-count">{cli.length}</span>
              </h3>
              <ul className="cheatsheet-rows">
                {cli.map((c) => (
                  <li className="cheatsheet-row" key={c.name}>
                    <div className="cheatsheet-line">
                      <div className="cheatsheet-main">
                        <span className="mono cheatsheet-cmd">omp {c.name}</span>
                        <span className="cheatsheet-zh">{c.zh}</span>
                      </div>
                      <span className="cheatsheet-actions">
                        {copyButton(`clicmd:${c.name}`, `omp ${c.name}`, "复制", `复制 omp ${c.name}`)}
                        {c.args
                          ? copyButton(
                              `clitpl:${c.name}`,
                              `omp ${c.name} ${c.args}`,
                              "参数",
                              `复制 omp ${c.name} 的参数模板`,
                            )
                          : null}
                      </span>
                    </div>
                    {c.args || c.examples.length > 0 ? (
                      <dl className="cheatsheet-detail">
                        {c.args ? (
                          <>
                            <dt className="cheatsheet-label">用法</dt>
                            <dd className="mono cheatsheet-sig">
                              omp {c.name} {c.args}
                            </dd>
                          </>
                        ) : null}
                        {c.examples.length > 0 ? (
                          <>
                            <dt className="cheatsheet-label">示例</dt>
                            <dd>
                              <ul className="cheatsheet-examples">
                                {c.examples.map((ex, i) => (
                                  <li className="cheatsheet-example" key={`${c.name}:${i}`}>
                                    <span className="mono">{ex}</span>
                                    {copyButton(`cli:${c.name}:${i}`, ex, "复制", `复制示例 ${ex}`)}
                                  </li>
                                ))}
                              </ul>
                            </dd>
                          </>
                        ) : null}
                      </dl>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
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
                  {copyButton(
                    `combo:${combo.id}`,
                    combo.steps.map((s) => s.cmd).join("\n"),
                    "复制全部",
                    `复制全部：${combo.title}`,
                  )}
                </header>
                <ol className="cheatsheet-steps">
                  {combo.steps.map((s, i) => (
                    <li className="cheatsheet-step" key={`${combo.id}:${i}`}>
                      <span className="mono cheatsheet-step-cmd">{s.cmd}</span>
                      <span className="cheatsheet-step-note">{s.note}</span>
                      {copyButton(`step:${combo.id}:${i}`, s.cmd, "复制", `复制步骤：${s.cmd}`)}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </>
        )}
      </div>
      <p className="cheatsheet-foot">
        以上为 omp 斜杠命令与终端子命令；`/skill:xxx` 技能命令、自定义命令与插件命令不在此列，
        实时补全以在 omp 中输入 / 为准。
      </p>
    </Modal>
  );
}

interface CommandRowProps {
  group: string;
  command: OmpCommand;
  copied: string | null;
  copy: (key: string, text: string) => Promise<void>;
  onJump: (name: string) => void;
}

/** 一条命令：摘要行（命令 + 一句话 + 复制）+ 两列定义网格详情（用法/别名/何时用/参数/注意/示例/相关）。 */
function CommandRow({ group, command: c, copied, copy, onJump }: CommandRowProps): ReactNode {
  const detail = findOmpDetail(c.name);
  const cmdKey = `cmd:${group}:${c.name}`;
  const tplKey = `tpl:${group}:${c.name}`;
  const hasDetail =
    c.args !== "" ||
    c.aliases.length > 0 ||
    detail?.when !== undefined ||
    (detail?.params !== undefined && detail.params.length > 0) ||
    (detail?.cautions !== undefined && detail.cautions.length > 0) ||
    c.examples.length > 0 ||
    (detail?.related !== undefined && detail.related.length > 0);
  return (
    <li className="cheatsheet-row" key={c.name}>
      <div className="cheatsheet-line">
        <div className="cheatsheet-main">
          <span className="mono cheatsheet-cmd">/{c.name}</span>
          <span className="cheatsheet-zh">{c.zh}</span>
        </div>
        <span className="cheatsheet-actions">
          <button
            type="button"
            className="cheatsheet-copy"
            aria-label={`复制 /${c.name}`}
            title={`复制 /${c.name}`}
            onClick={() => void copy(cmdKey, `/${c.name}`)}
          >
            {copied === cmdKey ? "已复制 ✓" : "复制"}
          </button>
          {c.args ? (
            <button
              type="button"
              className="cheatsheet-copy"
              aria-label={`复制 /${c.name} 的含参数模板`}
              title={`复制 /${c.name} ${c.args}`}
              onClick={() => void copy(tplKey, `/${c.name} ${c.args}`)}
            >
              {copied === tplKey ? "已复制 ✓" : "参数"}
            </button>
          ) : null}
        </span>
      </div>
      {hasDetail ? (
        <dl className="cheatsheet-detail">
          {c.args ? (
            <>
              <dt className="cheatsheet-label">用法</dt>
              <dd className="mono cheatsheet-sig">
                /{c.name} {c.args}
              </dd>
            </>
          ) : null}
          {c.aliases.length > 0 ? (
            <>
              <dt className="cheatsheet-label">别名</dt>
              <dd className="cheatsheet-alias">{c.aliases.join("、")}</dd>
            </>
          ) : null}
          {detail?.when !== undefined ? (
            <>
              <dt className="cheatsheet-label">何时用</dt>
              <dd className="cheatsheet-when">{detail.when}</dd>
            </>
          ) : null}
          {detail?.params !== undefined && detail.params.length > 0 ? (
            <>
              <dt className="cheatsheet-label">参数</dt>
              <dd>
                <dl className="cheatsheet-params">
                  {detail.params.map((p) => (
                    <div className="cheatsheet-param" key={p.token}>
                      <dt>
                        <code className="mono">{p.token}</code>
                      </dt>
                      <dd>{p.zh}</dd>
                    </div>
                  ))}
                </dl>
              </dd>
            </>
          ) : null}
          {detail?.cautions !== undefined && detail.cautions.length > 0 ? (
            <>
              <dt className="cheatsheet-label">注意</dt>
              <dd>
                <ul className="cheatsheet-cautions">
                  {detail.cautions.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {c.examples.length > 0 ? (
            <>
              <dt className="cheatsheet-label">示例</dt>
              <dd>
                <ul className="cheatsheet-examples">
                  {c.examples.map((ex, i) => (
                    <li className="cheatsheet-example" key={`${c.name}:${i}`}>
                      <span className="mono">{ex}</span>
                      <button
                        type="button"
                        className="cheatsheet-copy"
                        aria-label={`复制示例 ${ex}`}
                        title={`复制示例 ${ex}`}
                        onClick={() => void copy(`ex:${group}:${c.name}:${i}`, ex)}
                      >
                        {copied === `ex:${group}:${c.name}:${i}` ? "已复制 ✓" : "复制"}
                      </button>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {detail?.related !== undefined && detail.related.length > 0 ? (
            <>
              <dt className="cheatsheet-label">相关</dt>
              <dd>
                <span className="cheatsheet-related">
                  {detail.related.map((r) => {
                    const target = findOmpCommand(r);
                    if (target === undefined) return null;
                    return (
                      <button
                        key={r}
                        type="button"
                        className="cheatsheet-link mono"
                        title={`查看 /${target.name} 的完整说明`}
                        onClick={() => onJump(target.name)}
                      >
                        /{target.name}
                      </button>
                    );
                  })}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}
