# NSCF 1.3.1 — Trio read optimization

The runtime changes were first published as `1.3.1-beta.1` on branch `1.3.1` on September 29, 2026, based on `v1.3.0-beta.2`. They are included in stable **1.3.1**, released September 30. This optimization adds no schema migration and does not automatically upgrade existing instances.

## What changed

- Legacy v1 device-status writes update the same bounded query cache used by API3 instead of invalidating it after every upload.
- Unchanged treatment, Profile and food queries reuse raw ordered prefixes even when a response budget stops a cursor early. Normalization, event selection and output budgets still run for every response.
- Recent treatments preserve ascending LIMIT semantics, including the previously unseen 101st row. Profile Switch caching expires at future activation and age boundaries and invalidates on writes/rollback.
- Synchronous polling dequeue reuses the session and FIFO prefix already read; public WebSocket acknowledgement retains its stored-prefix validation.

## Same-fixture SQL comparison

Synthetic local workerd SQLite, 163 v1 status uploads, advancing clock, realistic prediction arrays, no client-created created_at field, browser polling and heartbeats. The first row compares the full 1.3.1 change against the original workload. The next two rows already include the earlier v1 cache repair in their baseline, isolating the subsequent auxiliary-query/dequeue improvement.

| Fixture | Rows read before | Rows read after | Rows written before / after |
| --- | ---: | ---: | ---: |
| No treatment history; all 1.3.1 cache changes combined | 13,700 | 6,123 | 3,111 / 3,111 |
| No treatment history; auxiliary-query/dequeue changes only | 10,530 | 6,123 | 3,111 / 3,111 |
| 2,000 synthetic treatment history rows | 3,490,578 | 6,123 | 3,111 / 3,111 |

The browser first loads history before this measured burst. Its initial load in the 2,000-treatment-history case was 26,793 → 24,783 reads. Cold starts, writes to the cached collections, cache limits and different data sizes can require fresh SQL. These are synthetic measurements, not observed customer bills or guaranteed savings. The original authentication failure is not confirmed without its server-side HTTP/exception record.

## Validation

102 Workers test files / 1,012 tests and TypeScript passed for the runtime changes. The September 29 branch acceptance also rebuilt the upstream UI and passed the complete project test command, Cloudflare configuration audit, TypeScript check and local deployment dry-run. The September 30 stable-release verification reran the complete project tests with the same 102 files / 1,012 Workers results, plus source build and type checks. Separately, the stable installer package passed 199 tests (41 Node script tests and 158 Vitest tests) and deployment dry-runs for both languages. Upstream test coverage is scoped separately in the [15.0.8 test record](NIGHTSCOUT_15_0_8.md). Tests include non-empty histories, complete/prefix query equality, future switches, time rollback, mutation invalidation, transaction failure, eviction and 240 budget/window interleavings. All medical data in tests is synthetic.

## Build the stable release

```sh
git clone --branch v1.3.1 --single-branch https://github.com/sid-luo/nightscout-for-cloudflare.git
cd nightscout-for-cloudflare
npm ci
NSCF_AUTO_UPDATE=0 npm run build
npm run check
npm test
npm run deploy:dry
```

`NSCF_AUTO_UPDATE=0` keeps this build on the checked-out release source. Both web installers now default to **1.3.1**, and their upgrade pages support recognized installer-managed instances. A manual deployment to an existing instance must retain its existing Worker identity, bindings and configuration; deploying an unrelated new Worker does not migrate its data.

For acceptance, confirm that historical status/treatment records remain available and that fresh updates reach the website, then compare Durable Objects SQL read/write deltas over the same elapsed interval and workload. Keep server error timestamps and HTTP/exception details if authentication fails; do not include secrets.

## 中文说明

这些改进用于减少 Trio 补传和网页更新产生的数据库重复读取，先在 `1.3.1-beta.1` 测试分支发布，再纳入 **1.3.1 正式版**。中英文快速安装器和升级页默认提供 1.3.1，由用户主动升级原实例。上表来自同条件合成测试，不是该用户真实用量；13,700 → 6,123 覆盖本次全部缓存改进，10,530 → 6,123 及治疗历史测试则在首轮 v1 修复后继续测量辅助查询改进。主要重复扫描已修复，但尚不能确认最初认证故障的全部原因。
