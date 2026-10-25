# dsh-plan-runner

Step-by-step plan runner for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH), built for
**small local models** that lose the thread on long tasks. A **Plan** agent writes the steps; the
runner then executes each step in a **fresh child conversation** that only sees the objective, its
own instructions, short summaries of earlier steps and the files it needs, and verifies the result
with checks the harness runs itself.

> **Maintenance:** best-effort. Issues may go unanswered; forks are welcome.

## How it works

1. Choose the **Plan** preset. The agent explores read-only, then records the steps with
   `plan_begin`, `plan_add_step` (one call per step) and `plan_show`. A step that would exceed 60 %
   of its model's context window is refused, so it has to be split. The plan is also saved as
   `PLAN-<name>.md`.
2. Approve the plan and press **Run step by step** (plan review card, or the strip above the composer).
   Each step runs in its own conversation (native DSH subagent) with:
   - its own **model** (see Configuration),
   - its own **access level**: `read`, `read-shell` (read-only shell commands only), `write`
     (files, limited to the step's declared outputs) or `full`,
   - a worker persona and a fixed final report (`Summary / Files / Decisions / Open questions`).
3. After each step the harness runs the **checks** of the step: `exists: <path>`,
   `contains: <path> :: <text>`, `words: <path> >= <n>`, `count: <glob> >= <n>`,
   `command: <shell command>` (exit 0 = ok). Important steps also get a read-only **reviewer** that
   ends with `VERDICT: OK` or `VERDICT: PROBLEMS - ...`.
4. A failing step gets **one retry** with the cause and a lesson; after a second failure a finer
   split is proposed and nothing changes until you accept it.
5. `for_each` steps run once per file or item, each in a short conversation, and write one result
   file per item. Steps marked `stop` pause the run so you can check the result.
6. Loops (the same tool call repeated) abort the step; a plan interrupted by a restart is paused
   and resumes from the current step.

State is kept in `<working folder>/.plan-<name>/state.json` (readable by humans) and an index of
plans per conversation in `<DSH_HOME>/plan-runner/index.json`. Files a step overwrites are backed up
under `.plan-<name>/backups/`.

Steps cannot ask for approval (DSH rejects approval requests in a subagent): an action the
conversation's permission mode does not allow without asking is refused and the step fails. For
steps that write, put the conversation in an auto or workspace-write mode.

## Install

```sh
dsh plugin --profile web add dsh-plan-runner
# or straight from GitHub:
dsh plugin --profile web add github:MathieuPortmann/dsh-plan-runner
```

Restart the profile afterwards. The bundle adds its own
**Plan** preset (id `plan`); do not combine it with another bundle that defines a preset with the
same id.

## Configuration

Row `plan-runner` in your profile's `cordis.patch.yml`; every key is optional.

```yaml
- id: plan-runner
  config:
    models:                      # models a step may use; empty = the plan conversation's own model
      my-local-model:
        provider: ollama
        window: 32768            # context window in tokens
        description: good reasoning, slow   # shown to the Plan agent
    defaultModel: my-local-model
    splitModel: my-local-model   # proposes the finer split after two failures
    auditModel: ''               # reviewer of important steps ('' = the step's own model)
    pauseOnBattery: false        # pause the run on battery power
    ollamaUrl: http://127.0.0.1:11434
    commandTimeoutMs: 120000     # timeout of `command:` checks
    loopRepeats: 3               # identical tool calls in a step that count as a loop
```

When a model's provider is `ollama`, the run pauses if `ollamaUrl` stops answering. Token budgets
use `basePromptTokens`, `outputReserve`, `unknownFileTokens`, `itemOutputTokens` and
`summaryTokens` (defaults tuned for 32k windows).

## Compatibility

| Component | Supported |
|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` (`engines.node`) |
| DSH | `>=0.2.0-rc.2 <0.3.0`; declared as optional `peerDependencies` on `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools`, the only DSH packages the plugin imports |
| Platform | Linux (tested); pure JavaScript, no native addon. `command:` checks need a POSIX `sh` |

Tested with DSH `0.2.0-rc.2` on Node 22.23 (see [Verification](#verification)).

## Permissions and external services

Everything the plugin can touch, and what happens when it fails:

| Capability | Where | Used for | If it fails |
|---|---|---|---|
| **Files (read)** | `lib/checks.js`, `index.js` | `exists` / `contains` / `words` / `count` checks, file sizes for the token budget, `/sys/class/power_supply` (only with `pauseOnBattery`); every path is resolved inside the working folder | the check fails or the file counts as missing |
| **Files (write)** | `lib/store.js`, `lib/plan-file.js`, `index.js` | `<cwd>/.plan-<slug>/state.json` and `backups/`, `<DSH_HOME>/plan-runner/index.json`, `PLAN-<name>.md` in the working folder; a step's own result files are written by the step's child conversation, restricted to its declared `outputs` | the plan stays in its previous state |
| **Commands** | `lib/checks.js` (`spawn('sh', ['-c', …])`) | `command:` checks, written by you or by the Plan agent, run in the working folder with a timeout (`commandTimeoutMs`); the Plan agent is told to keep them read-only | a timeout kills the command and its children; the check fails |
| **Network** | `index.js` (`fetch`) | only `GET <ollamaUrl>/api/tags` when a step uses an `ollama` model | an unreachable server pauses the run |
| **Dynamic module loading** | `index.js`, `lib/plan-tools.js` | loads `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` from the DSH installation that runs the plugin (a synchronous `require` of an ES module fails on Node 22); nothing is downloaded and no code is evaluated from text | both are required: the plugin fails to load without them |
| **Subagents** | `index.js` (`ctx.subagents`) | one child conversation per step, with a tool filter per access level (`read`, `read-shell`, `write`, `full`) | the step fails and follows the retry rule |

The plan state is plain JSON under `.plan-<slug>/`; delete the folder to forget a plan.

## Verification

Checked on a disposable profile (`DSH_HOME` pointing at a temporary folder, profile cloned with
`dsh <name> --from-default-profile web`, so the real profile is never touched):

```sh
npm pack
dsh plugin --profile t add file:$PWD/dsh-plan-runner-0.1.0.tgz   # install
dsh --profile t --no-open --port 3095                              # start: plugin loads, no error
```

`npm test` runs 42 standalone tests (state, parsing, checks, store, runner, scope guard,
read-only shell, config) with no DSH installation needed. A real run with a 9B local model created
a plan with `plan_begin` / `plan_add_step`, ran its step in a child conversation and verified the
result with a `words:` check.

## Develop

```sh
npm test
```

## License

MIT
