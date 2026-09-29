# NSCF 1.3.1-beta.1 — Trio read optimization test branch

Branch: `1.3.1`. Based on the published `v1.3.0-beta.2` source. This is a branch-only testing publication, with no new GitHub Release, installer update, schema migration, or automatic upgrade of existing instances.

## What changed

- Legacy v1 device-status writes update the same bounded query cache used by API3 instead of invalidating it after every upload.
- Unchanged treatment, Profile and food queries reuse raw ordered prefixes even when a response budget stops a cursor early. Normalization, event selection and output budgets still run for every response.
- Recent treatments preserve ascending LIMIT semantics, including the previously unseen 101st row. Profile Switch caching expires at future activation and age boundaries and invalidates on writes/rollback.
- Synchronous polling dequeue reuses the session and FIFO prefix already read; public WebSocket acknowledgement retains its stored-prefix validation.

## Same-fixture SQL comparison

Synthetic local workerd SQLite, 163 v1 status uploads, advancing clock, realistic prediction arrays, no client-created created_at field, browser polling and heartbeats. The baseline below already includes the earlier v1 cache repair, so it isolates the subsequent auxiliary-query/dequeue improvement.

| Fixture | Rows read before | Rows read after | Rows written before / after |
| --- | ---: | ---: | ---: |
| No treatment history | 10,530 | 6,123 | 3,111 / 3,111 |
| 2,000 synthetic treatment history rows | 3,490,578 | 6,123 | 3,111 / 3,111 |

The browser first loads history before this measured burst. Its initial load in the second case was 26,793 → 24,783 reads. Cold starts, writes to the cached collections, cache limits and different data sizes can require fresh SQL. These are synthetic measurements, not observed customer bills or guaranteed savings. The original authentication failure is not confirmed without its server-side HTTP/exception record.

## Validation

102 Workers test files / 1,012 tests and TypeScript passed for the runtime changes. Packaging also rebuilds the upstream UI and validates the branch version, Cloudflare configuration and local deployment bundle. Tests include non-empty histories, complete/prefix query equality, future switches, time rollback, mutation invalidation, transaction failure, eviction and 240 budget/window interleavings. All medical data in tests is synthetic.

## Build this branch

```sh
git clone --branch 1.3.1 --single-branch https://github.com/sid-luo/nightscout-for-cloudflare.git
cd nightscout-for-cloudflare
npm ci
npm run build
npm run check
npm test
npm run deploy:dry
```

The prerelease package version keeps a Cloudflare source-import build pinned to this checkout. The current web installer and its upgrade page still use beta.2 and do not select this branch. This branch is not a one-click in-place upgrade for installer-managed instances. A manual deployment to an existing instance must retain its existing Worker identity, bindings and configuration; deploying an unrelated new Worker does not migrate its data.

For acceptance, confirm that historical status/treatment records remain available and that fresh updates reach the website, then compare Durable Objects SQL read/write deltas over the same elapsed interval and workload. Keep server error timestamps and HTTP/exception details if authentication fails; do not include secrets.

## 中文说明

本分支用于验证 Trio 补传和网页更新产生的数据库重复读取。只发布 `1.3.1` 分支，代码版本为 `1.3.1-beta.1`；快速安装器仍是 beta.2，不会自动升级用户实例。上表来自同条件合成测试，不是该用户真实用量。主要重复扫描已修复，但尚不能确认最初认证故障的全部原因。
