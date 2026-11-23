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
| `main` | Frozen mirror of `cloudflare/workerd:main`, last updated 2026-11-23 | Not updated any more; do not commit here either |
| `sync/upstream-YYYYMMDD` | Throwaway branch for the weekly sync PR | Written by the sync workflow |
| `feat/*`, `fix/*` | Topic branches | Delete after merge |

The sync no longer writes a `main` mirror. A mirror push is a pure upstream tree, so it always
carries `.github/workflows/*` changes, and a `GITHUB_TOKEN` push is refused without `workflows`
permission — the mirror was the only step that ever failed. Compare `vrt` against
`upstream/main` (the sync commit message records the upstream SHA) instead of reading `main`.

Do not use GitHub's "Sync fork" button. It fast-forwards the default branch, which is `vrt`;
use the `VRT sync upstream` workflow instead.

## Upstream sync

`.github/workflows/vrt-sync-upstream.yml` runs every Monday at 04:00 UTC and on demand:

1. exits if `vrt` already contains upstream `main`;
2. otherwise merges `upstream/main` into `sync/upstream-<date>`:
   - **clean** — keeps `.github/workflows/**` and `.github/actions/**` exactly as `vrt` has
     them (see below), pushes the branch, opens a PR into `vrt`, and dispatches `VRT build`;
   - **include-only conflict** — `.vrt/resolve-includes.py` accepts both sides' `#include`
     lines and the merge is committed, then treated as clean. This is the only conflict that
     recurs: both sides add an include at the same anchor;
   - **conflict** — pushes a branch holding upstream's tree, opens a PR that shows the
     conflict, comments the conflicting paths, and labels it `sync-conflict`.

`.gitattributes` marks `.github/workflows/**` and `.github/actions/**` as `merge=ours`, and the
sync job restores both trees from `vrt` after the merge (dropping files upstream added). That
keeps our `vrt-*` workflows and upstream's disabled files byte-identical across a sync, so the
push never needs `workflows` permission and a sync PR never shows workflow churn. A local merge
of upstream must configure the driver first, or git refuses to merge those paths:

```bash
git config merge.ours.driver true
```

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

- limits live in `src/workerd/server/vrt-limits.{h,c++}` (self-contained, including the thread CPU
  clock and the cross-thread watchdog, so upstream syncs see new files rather than edits);
- the wiring is a handful of lines in the Rust config path (`worker.rs`, `bridge.rs`), the factory
  (`worker-factory.c++`) and a `limits` group in `workerd.capnp`;
- the outbound-connection budget needs one hook in the shared I/O core — the default
  `LimitEnforcer::newOutboundConnection()` in `io/limit-enforcer.h`, its call in
  `io/io-context.c++`, and the lease-awaiting client wrapper in `io/worker-interface.{h,c++}`. The
  other three dimensions stay entirely in `vrt-limits`. Keep this surface as small as possible;
- avoid editing upstream's `.github/workflows/*` — configure the fork through the API instead
  (see "Disabled upstream automation"). `.gitattributes` keeps that tree ours during a sync, so
  the rules above only matter for local commits on `vrt`.

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

Bots need `contents: write` (sync branches, releases), `pull-requests: write` (sync PRs) and
`actions: write` (dispatch the build). The repository setting "Allow GitHub Actions to create and
approve pull requests" must stay enabled. They deliberately do not need `workflows`: the sync
keeps `.github/workflows/**` and `.github/actions/**` identical to `vrt`, which is the only reason
a `GITHUB_TOKEN` push is accepted at all.

## Patches on top of upstream (keep this list current)

| Patch | Files | Purpose |
| --- | --- | --- |
| `limits` (W2) | `src/workerd/server/vrt-limits.{h,c++}`, `thread-*` helpers in the same file, `workerd.capnp`, `worker.rs`, `bridge.rs`, `loader.rs`, `config.rs`, `run.rs`, `worker-factory.c++`, `io/limit-enforcer.h`, `io/io-context.c++`, `io/worker-interface.{h,c++}` | Per-Worker CPU / memory / subrequest / outbound-connection limits with Cloudflare's error semantics, plus Cloudflare's fixed 1 second startup CPU budget (each startup entry point runs under the same thread-CPU watchdog; an overrun fails startup with the exceeded-CPU exception instead of hanging the process). `memoryMb` counts V8's external memory (ArrayBuffer/WebAssembly backing stores) as well as the JS heap, checked at each turn boundary, and aborts the request with the memory-limit error; SQLite/DO storage stays outside the budget. Dynamically loaded Workers honor `WorkerCode.limits` and `getEntrypoint()`/`getDurableObjectClass()` `options.limits` (the documented lower-of-the-two merge), capped by the loading Worker's `limits` group. `limits.outboundConnections` (@24) preserves Cloudflare's "the request past the cap waits" behavior: `LimitEnforcer::newOutboundConnection()` hands out a lease that `IoContext::getSubrequest()` attaches to the client, so the slot is held until the caller drops it (normally when the response body is read) and the next request takes it over |
| `loader-quotas` | `workerd.capnp`, `bindings.rs`, `loader.rs`, `config.rs`, `bindings-test.rs` | `workerLoader.maxWorkers`: bounds the live dynamic workers one loader may hold (loading, loaded or serving, named or not); `get()`/`load()` past the bound fail until a worker's handles are released. `maxWorkers` is a fork field number (@29) — upstream may not reuse it. The quota error carries a `jsg.Error:` prefix so it tunnels to tenant JS instead of surfacing as a sanitized `internal error` |
| `bind-fatal` | `src/workerd/server/server/listen/mod.rs` | A socket that fails to bind kills the process, even under `--watch`. Upstream's tolerant `Reporter` serves with `sockets[i] = None`, so a `--watch` re-exec that hits stale binds stays alive serving nothing; VRT's swap-unix flow relies on the image dying so the supervisor can preclear and relaunch. Pure config errors (no address, `--socket-fd` on UDP) stay tolerant — they are fixable by editing the watched config. Removal: upstream makes listener bind failures fatal again or grows a flag with that meaning |

Anything that changes public behaviour must also be reflected in Vibeploy's
`doc/platform/workers-runtime-quotas.md`.
