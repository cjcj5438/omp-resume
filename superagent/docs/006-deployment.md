# 006 Deployment

Use this guide to enable, configure and operate Superagent under omp-resume. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

Throughout this guide, `data_dir` is `$OMP_RESUME_DATA_DIR` when set and non-empty, otherwise `~/Library/Application Support/omp-resume`. Superagent's state directory is `S = <data_dir>/superagent`.

## What runs

- **The Superagent daemon**, a single `dist/daemon.js` file that omp-resume hosts as a child process. Enable it with the switch on the Superagent › **服务** page; omp-resume starts it, watches it and restarts it after a crash. The switch is stored in `<data_dir>/superagent.json` (`{"version": 1, "enabled": bool}`), which the 服务 page edits for you.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

Each session is a child `omp --mode rpc` process, one per session, launched along these lines (the full template is in [007 Architecture](007-architecture.md)):

```sh
omp --mode rpc --no-ui --no-title --no-extensions \
  -e S/plugin/r<rev> \
  --config S/omp-overlay.yml \
  --session-dir S/sessions/<sessionId> \
  --cwd <dir> --approval-mode yolo --tools <list> \
  --append-system-prompt S/prompts/<sessionId>.r<rev>.md
```

- `--no-extensions -e <plugin>` loads only the generated Superagent plugin directory: the `superagent-inject` command and the session skills. Nothing else from your omp setup is loaded as an extension.
- `--config <overlay>` applies `S/omp-overlay.yml`, which switches the memory backend off, disables the advisor, and moves shell commands to the background after 5 seconds. The overlay affects only the processes Superagent starts.
- Superagent never writes your `~/.omp/agent` configuration; it reads it read-only. The child processes read your `config.yml`, `models.yml`, credentials, global skills and rules, and the repository's `AGENTS.md`, which is what lets them use your models and login. They still write omp's own runtime files (usage database, logs, caches, possibly prompt history); those writes change no configuration.

Sessions run with full access as the operator's OS user. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

Do not run two deployments against the same GitHub agent account and repository at the same time — for example a previous deployment and this one. Both would poll the same notifications, and the same request would be processed twice. Stop the old deployment first.

## Where state lives

| Path | Purpose |
| --- | --- |
| `S/superagent.sqlite` | The Store: Triggers, Threads, Tickets, settings, prompts, effects, receipts and the `kv` records |
| `<data_dir>/superagent.lock` | The process lock; a second daemon refuses to start while it is held |
| `S/sessions/<sessionId>/*.jsonl` | One directory per session, passed as `--session-dir`; the main session is `main`, workers are `worker-<ticket>` |
| `S/work/<name>/` | The default root for Ticket directories |
| `S/worker-bin/`, `S/worker-gitconfig` | The agent's `gh`/`lark-cli` shims and the isolated git configuration |
| `S/prompts/<sessionId>.r<rev>.md` | The prompt file passed with `--append-system-prompt` |
| `S/plugin/r<rev>/` | The generated omp plugin directory: extension plus skills |
| `S/omp-overlay.yml` | The overlay configuration passed with `--config`, rewritten at every daemon start |
| `S/logs/daemon.log` (`.1`) | The daemon's stdout/stderr, redirected by omp-resume; read its tail on the 服务 page |
| `S/daemon.sock` | The HTTP unix socket; when this path would exceed 100 bytes, `/tmp/omp-superagent-<uid>/daemon.sock` is used instead |

There is no machine configuration file. The machine limits (largest saved prompt 100,000 characters, admission context 10 pages within 15 seconds) are fixed, and the state directory is fixed at `S`. Back up `S/superagent.sqlite` before upgrades.

## Prerequisites

- An `omp` binary where omp-resume can resolve it. The 服务 page shows the resolved path; without one the daemon cannot start.
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the daemon relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- git 2.32 or later.
- A model provider configured for omp. Superagent uses omp's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot.

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because Superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. Superagent reads the login the same way.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   Do not run two deployments against the same Feishu app at the same time — for example a DSH-hosted Superagent and this one. Both would consume the same app's events, and the same message would be processed twice. A separate configuration directory does not prevent this, because duplicate delivery is per app, not per configuration directory. Coexisting deployments each need their own self-built app and robot; otherwise run only one event consumer at a time.

   Setup refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Enable, restart, stop

Everything is on the Superagent › **服务** page:

- The **enable switch** starts and stops the daemon. After enabling, the state moves from Starting to Running once the daemon answers, within 60 seconds.
- **Restart** stops the daemon gracefully and starts it again; it is available only while enabled.
- The **state panel** shows the state, process id, start time, restart count and the last error. The states are Disabled, Starting, Running, Stopping, Stopped and Crashed.
- The **paths panel** lists the state directory, socket, log, assets directory and omp binary, each with a reveal button.
- The **log panel** shows the tail of `S/logs/daemon.log` with a refresh button.

A crashed daemon restarts automatically with a backoff of 1, 2, 5, 10, 30, then 60 seconds — except after exit code 3, which means another daemon already holds the state directory or its socket, and is never retried. Exit code 2 means a missing startup argument, which only a broken install can cause.

For reference, omp-resume starts the daemon as:

```sh
BUN_BE_BUN=1 <ompBin> run <assets>/dist/daemon.js --state-dir <S> --socket <sock> --omp <ompBin>
```

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and the agent's `gh` command: the wrapper's absolute path, or a command name on `PATH`, whose config directory holds only the agent's login. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. A typical command gives each Ticket a checkout of the repository: `git -C <repo> worktree add "$OMP_SUPERAGENT_DIR"`, for example:

   ```sh
   git -C /home/me/src/widgets worktree add "$OMP_SUPERAGENT_DIR"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel talks to the daemon over its unix socket, and agents can call the same API there. With the socket path from the 服务 page:

```sh
sock="$HOME/Library/Application Support/omp-resume/superagent/daemon.sock"
curl -s --unix-socket "$sock" http://x/orchestrator/api/state
```

Requests go to `http://x/orchestrator/api/<path>`. There is no origin check: the socket file's `0600` permissions are the access boundary.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET sessions` | The sessions: `items`, each with `id`, `role`, `ticketId`, `title`, `sessionFile` and `state` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting Superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
sock="$HOME/Library/Application Support/omp-resume/superagent/daemon.sock"
rev=$(curl -s --unix-socket "$sock" http://x/orchestrator/api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT --unix-socket "$sock" -H 'content-type: application/json' http://x/orchestrator/api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup probes run the way worker shells do. Setup removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `S/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `S/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that Superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `S/superagent.sqlite`.
3. Upgrade omp-resume, which ships the new daemon assets, and restart the daemon from the 服务 page.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After the upgrade, the daemon regenerates its plugin directory and prompt files; sessions pick up the new revision on their next start.

### Prompt revisions

Each prompt revision generates `S/plugin/r<rev>` with the session extension and skills; the daemon removes older versions at startup. The main Session closes itself once settled when a newer revision exists, so the next delivery restarts it on the new text. Workers restart on their next delivery.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration Superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by Superagent` | Move the named file out of `S/worker-bin` or `S/worker-gitconfig` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| The 服务 page shows Crashed | `lastError` names the cause and the log panel shows the daemon's last lines; fix it and press Restart. The supervisor also retries automatically with backoff |
| `another Superagent daemon holds <S>`, exit code 3 | A second daemon is already using the state directory or its socket. Stop it first; two daemons must never share one state directory |
| The 服务 page reports `omp` was not found | Install omp where omp-resume resolves it; without one the daemon cannot start |
| The 服务 page reports the resource directory is missing | `dist/daemon.js` is not in the assets directory; reinstall omp-resume |
| The panel cannot reach the Superagent service | The daemon is disabled, restarting or crashed; the 服务 page shows its state and log |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The same request is processed twice | Two deployments poll the same GitHub account and repository, or two consumers read the same Feishu app; stop one of them, or give each deployment its own Feishu app |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
