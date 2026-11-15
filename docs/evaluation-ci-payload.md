# Evaluation CI scope and provenance

This branch runs the agent evaluation contracts and isolated verifier checks on GitHub Actions. It is based on origin/main and does not merge into either long-lived branch automatically.

## Included source

The evaluation implementation and the headless runtime it was tested against are included. Runtime prerequisites contain existing local workspace changes and previously unpushed module extractions; this branch does not attribute those implementations to the CI integration work. Desktop entry points, IPC, backend directories, renderer changes, icon generation, and license changes are outside this payload and retain their upstream versions.

No API keys, personal model properties, node_modules, virtual environments, generated model trials, or local instructions are added. Dependency versions and the upstream MIT license are unchanged.

## Running the focused workflow

The dedicated evaluation workflow is reusable. The existing CodeNode CI workflow exposes a manual evaluation_only input so the new workflow can run on a review branch without changing the default branch first:

```bash
gh workflow run ci.yml --repo yimi528/CodeNode --ref codex/agent-evaluation-ci -f evaluation_only=true
```

This dispatch skips application packaging and runs contracts plus isolated-verifier jobs. The live-model input is false and repository secrets are not inherited by the reusable call. Automatic push runs on this dedicated branch are excluded from the older CI and production workflows to avoid unrelated packaging or model work. Other branches keep the upstream trigger behavior.

The checks establish evaluation integration, not application release approval or an independently human-reviewed capability claim. Human review remains pending. Generated evidence is uploaded as workflow artifacts.
