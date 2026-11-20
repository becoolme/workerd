# VRT fork of `workerd`

This fork backs the Vibeploy Runtime (VRT): a self-hosted, Cloudflare-Workers-compatible
execution environment. Upstream is [`cloudflare/workerd`](https://github.com/cloudflare/workerd),
Apache-2.0; the upstream `LICENSE` applies to everything here.

We fork for one reason: `workerd serve` ships `NullIsolateLimitEnforcer` / `NullLimitEnforcer`,
so a stock binary enforces no per-Worker CPU, memory or subrequest budget. Cloudflare's
production embedder implements those interfaces; the interfaces themselves are upstream and
public. Our patches implement them for the standalone server and expose them in the config.

## Branches

| Branch | Content | How it changes |
| --- | --- | --- |
| `vrt` (default) | Upstream `main` + our patches + the workflows in this repo | Pull requests only, one topic per PR |
| `main` | Pure mirror of `cloudflare/workerd:main` | Force-updated by the sync workflow; never commit here |
| `sync/upstream-YYYYMMDD` | Throwaway branch for the weekly sync PR | Written by the sync workflow |
| `feat/*`, `fix/*` | Topic branches | Delete after merge |

`main` is a mirror so a sync PR reads as "everything upstream landed since the last sync".
Nothing builds from `main`; releases are cut from tags on `vrt`.

Do not use GitHub's "Sync fork" button. It fast-forwards the default branch, which is `vrt`;
use the `VRT sync upstream` workflow instead.

## Upstream sync

`.github/workflows/vrt-sync-upstream.yml` runs every Monday at 04:00 UTC and on demand:

1. force-updates `main` to upstream `main`;
2. exits if `vrt` already contains upstream;
3. otherwise merges upstream into `sync/upstream-<date>`:
   - **clean** — pushes the branch, opens a PR into `vrt`, and dispatches `VRT build`;
   - **conflict** — pushes a branch holding upstream's tree, opens a PR that shows the
     conflict, comments the conflicting paths, and labels it `sync-conflict`.

A conflict PR is resolved by a human (web editor or locally, see the PR body). The sync job
never commits conflict markers and never force-pushes `vrt`.

PRs opened with `GITHUB_TOKEN` are authored by `github-actions[bot]`, which GitHub treats as
untrusted: the `pull_request` run lands in `action_required` and a maintainer has to approve it
every week. Set a fine-grained PAT secret named `VRT_SYNC_TOKEN` (Contents: read/write, Pull
requests: read/write, limited to this repository) and the PR is opened as that user instead:
no approval prompt, and the normal `pull_request` build runs on its own.

Without the secret the job falls back to `GITHUB_TOKEN`: it opens the PR, and additionally
dispatches `VRT build` (the bot's own `pull_request` run is skipped by the build workflow).
The PR then shows an `action_required` run that can be ignored; the dispatched run is the real
check.

Keep our delta small and modular so sync conflicts stay rare:

- limits live in `src/workerd/server/standalone-*.{h,c++}` and `thread-cpu-clock.*`
  (self-contained, upstreamable);
- the wiring is a handful of lines in `server.c++` / `worker-factory.c++` and a `limits`
  field in `workerd.capnp`;
- avoid editing upstream's `.github/workflows/*` — configure the fork through the API instead
  (see "Disabled upstream automation").

After a sync merges, rebuild and re-tag; see below.

## Builds and releases

`.github/workflows/vrt-build.yml` builds on GitHub-hosted runners (`ubuntu-24.04` x64 and
`ubuntu-24.04-arm` arm64). Nothing builds locally.

- **Pull request** — release-config compile, `workerd --version`, and a serve smoke test.
  Bazel's disk cache is restored from the Actions cache, so a patch-only rebuild is minutes,
  a cold build an hour.
- **Push to `vrt`** — builds the merge commit (no release). This is the check that matters for
  a sync PR that was merged without waiting, and it catches a bad merge immediately.
- **`workflow_dispatch`** — same build; set `release_tag` to publish a release.
- **Tag `vrt-*`** — builds and publishes that tag's release.

A release contains, per architecture:

```
workerd-linux-x64.gz            workerd-linux-x64.gz.sha256
workerd-linux-arm64.gz          workerd-linux-arm64.gz.sha256
workerd.capnp                   workerd.capnp.sha256
manifest.json                   # tag, commits, binaries{arch: ELF sha256}, assets{file: sha256}
```

`manifest.binaries` is the digest of the decompressed ELF, which is what consumers pin;
`assets` covers the files actually uploaded. The schema asset lets a consumer check generated
configs against the exact runtime version it pinned.

`.vrt/upstream` in the tree records the `cloudflare/workerd` commit the current branch was
last synced to; the sync workflow writes it into the merge commit, and the release job resolves
it to the nearest upstream tag (Cloudflare tags `main` roughly daily, so the tag may be absent
when the sync is ahead of the newest release). Resolve a binary to an upstream version with:

```bash
gh release download <vrt-tag> --pattern manifest.json --repo becoolme/workerd -O -
```

Cut a release from a green `vrt` commit:

```bash
tag="vrt-$(date -u +%Y%m%d)-$(git rev-parse --short=7 vrt)"
git tag "$tag" vrt && git push origin "$tag"      # or dispatch the workflow with release_tag
```

## Pinning in the platform

Vibeploy records the tag, commit and per-asset sha256 in its workerd lock file and verifies the
digest when it downloads the binary. Never pin a branch, a run ID, or an unverified URL.

Compatibility with upstream Workers is measured against a compatibility date, not a workerd
version, so staying a few upstream releases behind is expected; staying months behind is not.

## Disabled upstream automation

Upstream workflows assume self-hosted runner labels (`ubuntu-24.04-16core`), Cloudflare
secrets and npm publishing. They are disabled through the Actions API, not by editing the
files, so syncs never conflict over them:

| Workflow | Why |
| --- | --- |
| `test.yml`, `lint.yml`, `coverage.yml`, `codspeed.yml` | Custom runners / remote execution we do not have |
| `internal-build.yml`, `cla.yml` | Cloudflare-internal policy |
| `daily-release.yml`, `release.yml` | Publishes upstream npm packages and tags |
| `deps-updater.yml`, `update-wpt.yml`, `semgrep.yml`, `wpt-report.yml` | Upstream dep/WPT automation |

If a workflow is re-enabled accidentally after a sync, disable it again:

```bash
gh workflow list --repo becoolme/workerd
gh workflow disable <name-or-id> --repo becoolme/workerd
```

## Workflow permissions

Bots need `contents: write` (mirror branch, sync branches, releases),
`pull-requests: write` (sync PRs) and `actions: write` (dispatch the build). The repository
setting "Allow GitHub Actions to create and approve pull requests" must stay enabled.

## Patches on top of upstream (keep this list current)

| Patch | Files | Purpose |
| --- | --- | --- |
| `limits` (W2) | `src/workerd/server/standalone-*`, `thread-cpu-clock.*`, `limit-enforcer.h`, `workerd.capnp`, `server.c++`, `worker-factory.c++` | Per-Worker CPU / memory / subrequest / outbound-connection limits with Cloudflare's error semantics |

Anything that changes public behaviour must also be reflected in Vibeploy's
`doc/platform/workers-runtime-quotas.md`.
