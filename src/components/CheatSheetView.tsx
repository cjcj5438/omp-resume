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
import { OMP_CLI_COMMANDS } from "../ompCliCommands";
import { OMP_LEARNING_PATHS } from "../ompLearningPaths";
import { OMP_COMBOS, filterOmpCombos } from "../ompCombos";
import { copyText } from "../clipboard";
import { EmptyState, Ico } from "./ui";
import { PageHeader, Seg } from "./page";
import { Check, Search, SearchX } from "lucide-react";
import { useAlive } from "./useOmpOp";
import "./CheatSheet.css";

interface CheatSheetViewProps {
  /** 本机已安装 omp 版本；null/缺省表示未知，不做版本提示。 */
  installedVersion?: string | null;
}

type Seg = "all" | "slash" | "cli" | "paths" | "combos";

const SEGS: { key: Seg; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "slash", label: "斜杠命令" },
  { key: "cli", label: "终端子命令" },
  { key: "paths", label: "学习路径" },
  { key: "combos", label: "组合用法" },
];

const COPIED_MS = 1500;
const FAILED_MS = 4000;

export function CheatSheetView({ installedVersion = null }: CheatSheetViewProps) {
  const [seg, setSeg] = useState<Seg>("all");
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    filterRef.current?.focus();
  }, []);
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

  /** 复制按钮：同一套「已复制 + Check 图标」时序，key 唯一即可。 */
  const copyButton = (key: string, text: string, label: string, aria: string): ReactNode => (
    <button
      type="button"
      className="cheatsheet-copy"
      aria-label={aria}
      title={aria}
      onClick={() => void copy(key, text)}
    >
      {copied === key ? <>已复制 <Ico icon={Check} size={12} /></> : label}
    </button>
  );

  /** 跨段跳到某条命令：切到斜杠段并把过滤框设成它。 */
  function jumpToCommand(name: string): void {
    setSeg("slash");
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
  const showSlash = seg === "all" || seg === "slash";
  const showCli = seg === "all" || seg === "cli";
  const showPaths = seg === "all" || seg === "paths";
  const showCombos = seg === "combos";
  const matchText = query.trim() === "" ? null : `匹配 ${shown + cli.length} / ${total + OMP_CLI_COMMANDS.length} 条`;
  const head = `基于 omp ${OMP_VERSION} · 共 ${total} 条斜杠命令（内置 ${builtin} + 扩展 ${total - builtin}）· ${OMP_CLI_COMMANDS.length} 个终端子命令`;

  return (
    <div className="view">
      <PageHeader
        kicker="工具 · 参考"
        title="速查表"
        sub={head}
        actions={
          <>
            <span className="badge badge-quiet">omp {OMP_VERSION}</span>
            {installedVersion !== null && !versionMismatch(installedVersion) ? (
              <span className="badge badge-ok"><span className="dot ok" aria-hidden="true" />版本匹配</span>
            ) : null}
          </>
        }
      />
      <div className="cheatsheet-page">
      {versionMismatch(installedVersion) ? (
        <p className="cheatsheet-version-note">
          你安装的是 {installedVersion}，速查基于 {OMP_VERSION}，个别命令可能有差异
        </p>
      ) : null}
      <div className="cheatsheet-toolbar">
        <label className="search-box">
          <Ico icon={Search} size={14} />
          <input
            ref={filterRef}
            type="search"
            placeholder="搜索命令、别名或说明"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="过滤命令"
            data-autofocus
          />
        </label>
        <Seg label="速查分类" value={seg} onChange={setSeg} options={SEGS.map((s) => ({ value: s.key, label: s.label }))} />
        <span className="spacer" />
        <span className="meta">{matchText ?? `${shown + cli.length} 条 · ${OMP_CLI_COMMANDS.length} 个终端子命令`}</span>
      </div>
      {copyFailed ? (
        <p className="cheatsheet-copy-error" role="status">
          复制失败：剪贴板不可用，请手动选择文本复制
        </p>
      ) : null}
      <div className="cheatsheet-list">
        {showPaths ? (
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
        ) : null}
        {showSlash ? (
          <>
            {shown === 0 ? (
              <EmptyState
                icon={SearchX}
                title="没有匹配的命令"
                action={<button type="button" className="btn btn-ghost btn-small" onClick={() => { setQuery(""); setSeg("all"); }}>清除筛选</button>}
              >
                换个关键词，或清除筛选看全部。
              </EmptyState>
            ) : null}
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
        ) : null}
        {showCli ? (
          <>
            {cli.length === 0 ? <EmptyState icon={SearchX} title="没有匹配的终端子命令" action={<button type="button" className="btn btn-ghost btn-small" onClick={() => { setQuery(""); setSeg("all"); }}>清除筛选</button>}>换个关键词，或清除筛选看全部。</EmptyState> : null}
            <section className="cheatsheet-group">
              <h3 className="cheatsheet-group-title">
                终端子命令<span className="cheatsheet-group-count">{cli.length}</span>
              </h3>
              <ul className="cheatsheet-rows">
                {cli.map((c) => (
                  <li className="cheatsheet-row" key={c.name}>
                    <div className="cmd-row">
                      <div className="cmd-left">
                        <span className="mono cmd-cmd">omp {c.name}</span>
                        <span className="mono cmd-alias">—</span>
                      </div>
                      <div className="cmd-mid">
                        <span className="cmd-desc">{c.zh}</span>
                        {c.examples.length > 0 ? <code className="cmd-ex">{c.examples[0]}</code> : null}
                      </div>
                      <span className="badge badge-quiet cmd-tag">{c.tag}</span>
                    </div>
                    <div className="cheatsheet-line cheatsheet-copyline">
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
                    {c.examples.length > 1 ? (
                      <dl className="cheatsheet-detail">
                        <dt className="cheatsheet-label">更多示例</dt>
                        <dd>
                          <ul className="cheatsheet-examples">
                            {c.examples.slice(1).map((ex, i) => (
                              <li className="cheatsheet-example" key={`${c.name}:${i + 1}`}>
                                <span className="mono">{ex}</span>
                                {copyButton(`cli:${c.name}:${i + 1}`, ex, "复制", `复制示例 ${ex}`)}
                              </li>
                            ))}
                          </ul>
                        </dd>
                      </dl>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
        {showCombos ? (
          <>
            {combos.length === 0 ? <EmptyState icon={SearchX} title="没有匹配的场景" action={<button type="button" className="btn btn-ghost btn-small" onClick={() => { setQuery(""); setSeg("all"); }}>清除筛选</button>}>换个关键词，或清除筛选看全部。</EmptyState> : null}
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
        ) : null}
      </div>
      <p className="cheatsheet-foot">
        <span>{builtin} 个内置斜杠命令 · {total - builtin} 个扩展命令 · {OMP_CLI_COMMANDS.length} 个终端子命令</span>
        <span className="mono">更新于 omp {OMP_VERSION} 数据</span>
      </p>
      </div>
    </div>
  );
}

interface CommandRowProps {
  group: string;
  command: OmpCommand;
  copied: string | null;
  copy: (key: string, text: string) => Promise<void>;
  onJump: (name: string) => void;
}

/** 一条命令：三列 grid（命令+别名 / 说明+首示例 / tag 徽章）+ 点击展开详情。 */
function CommandRow({ group, command: c, copied, copy, onJump }: CommandRowProps): ReactNode {
  const detail = findOmpDetail(c.name);
  const cmdKey = `cmd:${group}:${c.name}`;
  const tplKey = `tpl:${group}:${c.name}`;
  const [open, setOpen] = useState(false);
  const hasDetail =
    c.args !== "" ||
    c.aliases.length > 0 ||
    detail?.when !== undefined ||
    (detail?.params !== undefined && detail.params.length > 0) ||
    (detail?.cautions !== undefined && detail.cautions.length > 0) ||
    c.examples.length > 0 ||
    (detail?.related !== undefined && detail.related.length > 0);
  const aliasLine = c.aliases.length > 0 ? `别名 ${c.aliases.join("、")}` : "—";
  return (
    <li className="cheatsheet-row" key={c.name}>
      <div
        className="cmd-row"
        role="button"
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? open : undefined}
        onClick={() => { if (hasDetail) setOpen((v) => !v); }}
        onKeyDown={(e) => {
          if (!hasDetail) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <div className="cmd-left">
          <span className="mono cmd-cmd">/{c.name}</span>
          <span className="mono cmd-alias">{aliasLine}</span>
        </div>
        <div className="cmd-mid">
          <span className="cmd-desc">{c.zh}</span>
          {c.examples.length > 0 ? <code className="cmd-ex">{c.examples[0]}</code> : null}
        </div>
        <span className="badge badge-quiet cmd-tag">{c.tag}</span>
      </div>
      <div className="cheatsheet-line cheatsheet-copyline">
        <span className="cheatsheet-actions">
          <button
            type="button"
            className="cheatsheet-copy"
            aria-label={`复制 /${c.name}`}
            title={`复制 /${c.name}`}
            onClick={() => void copy(cmdKey, `/${c.name}`)}
          >
            {copied === cmdKey ? <>已复制 <Ico icon={Check} size={12} /></> : "复制"}
          </button>
          {c.args ? (
            <button
              type="button"
              className="cheatsheet-copy"
              aria-label={`复制 /${c.name} 的含参数模板`}
              title={`复制 /${c.name} ${c.args}`}
              onClick={() => void copy(tplKey, `/${c.name} ${c.args}`)}
            >
              {copied === tplKey ? <>已复制 <Ico icon={Check} size={12} /></> : "参数"}
            </button>
          ) : null}
        </span>
      </div>
      {hasDetail && open ? (
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
                        {copied === `ex:${group}:${c.name}:${i}` ? <>已复制 <Ico icon={Check} size={12} /></> : "复制"}
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
