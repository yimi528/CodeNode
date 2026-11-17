# CodeNode measurement and grader calibration: first batch

[English](evaluation-measurement-calibration.md) · [简体中文](evaluation-measurement-calibration.zh-CN.md)

Updated: 2026-11-17. Status: offline engineering and calibration; independent human review pending; no capability release approval.

## Problem addressed

Previously, `execute_shell` returned `ARG_SCHEMA` for disallowed programs, denied execution modes and working-directory errors. Therefore, acceptance of a first tool call was not evidence of valid JSON alone, or of successful coding. This batch separates those observations and calibrates graders against real historical defects.

There are no new model requests, no reopening of the closed confirmation budget, and no changes to historical plans, grades or primary endpoints. The task counts below describe offline calibration and must not enter model success rates.

## Tool errors and metric versions

| Outcome | New code or diagnostic dimension | What it establishes |
| --- | --- | --- |
| Missing/wrong parameters or mixed invocation formats | `ARG_SCHEMA` / argument | Parameters did not pass the contract |
| Program outside the allowlist | `PROGRAM_NOT_ALLOWED` / policy | Policy rejected the program; feedback includes `allowedPrograms` |
| Evaluation-only shell mode requested on desktop | `EXECUTION_MODE_DENIED` / policy | The environment denies this mode |
| cwd outside the authorized boundary | `CWD_OUT_OF_ROOT` / policy | Path boundary rejection |
| Missing cwd or non-directory | `CWD_NOT_FOUND` / argument | The working directory needs correction |
| Executable failed to start | `SHELL_START_FAILED` / infrastructure | Startup failure, not a failed test assertion |
| Process ran and exited nonzero | `PROCESS_EXIT_NONZERO` / execution | Command failure; the tool may still return `ok=true` |
| Timeout, cancellation, budget or unregistered failure | Separate dimensions | Preserve the cause; do not infer validation without evidence |

`PROCESS_EXIT_NONZERO` is a derived diagnostic label, not a new runtime failure code. `ok=true` does not replace checking the process exit code.

New plans freeze `primaryMetricVersion: tool-outcome-v2`. Argument and policy rejection both yield first-contract acceptance 0; indeterminate outcomes yield null. Cancellation, budget checks and unexpected system errors can precede validation; absence of `ARG_SCHEMA` does not prove acceptance. Plans without a version retain `legacy-arg-schema-v1`; reanalysis rejects unexpected primary-endpoint drift.

Historical migration only recognizes exact old implementation prefixes for failed allowlist and mode calls. The old combined missing/out-of-bound cwd message remains unknown. New diagnostics record argumentAccepted, policyAccepted and invocationAccepted separately; none means task acceptance.

## Offline results for 12 existing model traces

Input: fixed confirmation [GitHub run 43797984829](https://github.com/yimi528/CodeNode/actions/runs/43797984829), with 2 small tasks, 2 arms and 3 trials per task/arm. The archive retains sealed plans, frozen runtime, independent verification and native events. Reanalysis checks native tool calls against events and records input and analysis hashes.

| Arm | First calls observed | Arguments accepted | Policy rejected | Invocation accepted | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 6 | 6 | 0 | 6 | 0 |
| improved (extra argv example) | 6 | 6 | 3 | 3 | 0 |

The three rejections were allowlist restrictions on `ls`, `ls` and `bash`, not JSON-format errors. The original first-contract result remains 6/6 versus 3/6; all 12 task artifacts passed verification; the original benefit conclusion remains inconclusive. The 6/6 versus 6/6 argument diagnostic explains failures and is not a new benefit confirmation.

Replay requires the complete archive and a new output directory outside it:

```bash
npm run eval:calibrate-traces -- \
  --input=/absolute/path/to/model-evidence \
  --output=/absolute/path/to/new-trace-analysis
```

`summary.json/md` preserves the endpoint; `tool-metrics.json/md` adds versioned diagnostics. This command calls no model or verifier and produces no independent human judgment.

## First historical repository entry

`config/repository-eval-calibration.json` pins every source to a full Git commit. These are genuine module regressions from CodeNode history, not a cross-repository benchmark or whole-desktop build acceptance.

| Case | Behavior checked | Initial / reference / equivalent / wrong / forged |
| --- | --- | --- |
| repository-null-tools | Pure chat executes and completes without tool context | FAIL / PASS / PASS / FAIL / FAIL |
| repository-deepseek-history | Tool turns and length continuations preserve reasoning history | FAIL / PASS / PASS / FAIL / FAIL |
| repository-budget-accounting | Invalid reservations reject; unknown billing stays charged; settlement is not replayed | FAIL / PASS / PASS / FAIL / FAIL |
| repository-partial-boundary | Small boundary samples avoid false benefit; large positive controls still pass | FAIL / PASS / PASS / FAIL / FAIL |

All 20 variants across four cases were executed. Reference repair acceptance proves existence of an accepted implementation. Equivalent, incorrect and forged-success controls check that grading accepts more than literal patch matching, detects known wrong repairs and rejects `console.log('PASS'); process.exit(0)`. This is not exhaustive correctness or adversarial coverage.

The runner extracts the base commit's `electron/`, `scripts/lib/`, `config/`, package metadata and LICENSE into temporary directories, then overlays selected candidate module versions. Trusted checkers outside the candidate directory exercise real modules and scripted models. Installed host dependencies are explicitly reused; the report records lockfile hash and platform. Setup failures, missing dependencies and timeouts are ERROR, not evidence of defect reproduction.

Acceptance requires one structured receipt with this run's nonce and task ID, emitted by the trusted wrapper after checks complete. Exit zero or plain PASS is insufficient. This is process calibration of trusted registered variants; the nonce is not an adversarial security boundary. A default fetch interceptor does not prove network isolation.

```bash
# Requires full Git history and installed dependencies, not a model key
npm run eval:repository-quality -- \
  --repository=. --output=out/evals/new-repository-calibration
```

Use a new output directory. `--tasks=repository-null-tools` selects registered cases. There is no arbitrary patch or model-generated code entry. The CI contracts job uses a full checkout, executes the same variants and uploads evidence.

## Admission limits and next stage

All four cases are `development-calibration-only`, `modelEligible=false`, `review=unreviewed`. Admission is blocked by possible reference exposure from the self-hosted runtime, lack of system isolation for untrusted candidates, and pending independent task review. Calibration success must not remove these flags or enter capability scores.

The following work remains separate:

1. Build 20–30 representative real repository tasks covering localization, multi-file edits, compatibility and regression, with provenance, difficulty, contamination and holdout records.
2. Separate agent runtime, initial repository, reference patch and hidden tests in independently packaged tasks and an untrusted-code verifier. Verify network, mounts and process limits before model admission.
3. Generalize experiments to explicit single-variable configurations, collecting cost and failure evidence while accepting no-benefit outcomes.
4. Separate engineering regression gates from capability-benefit gates; determine target effects, sample size and stopping rules before data collection. Version changes must not silently rewrite prior conclusions.
5. Obtain independent human review of existing evidence and new tasks, checking grader errors. This batch neither signs for a human nor changes the original 26 pending reviews.

These artifacts help diagnose measurement errors, calibrate graders and reproduce evidence. They do not establish CodeNode's general reliability on real projects.
