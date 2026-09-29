/** Raw ordered prefixes; response budgets and normalization run on every read. */
export class AuxiliaryQueryCache<Row extends { id: string; sort_time: number }> {
  private entries = new Map<string, { lower: number; rows: Row[]; complete: boolean; bytes: number }>();
  private generation = 0;

  clear(): void { this.entries.clear(); this.generation++; }

  *read(
    key: string, lower: number, load: () => Iterable<Row>,
    timestamp: (row: Row) => number = row => row.sort_time,
    limit = Number.POSITIVE_INFINITY, ascendingLimit = false,
  ): IterableIterator<Row> {
    key = JSON.stringify([key, limit, ascendingLimit]);
    const prior = this.entries.get(key);
    const cached = prior !== undefined && lower >= prior.lower ? prior : undefined;
    const generation = this.generation;
    const rows: Row[] = [];
    const seen = new Set<string>();
    let bytes = 0, count = 0, complete = false;
    try {
      if (cached !== undefined) {
        for (const row of cached.rows) {
          if (timestamp(row) < lower) continue;
          seen.add(row.id);
          bytes += JSON.stringify(row).length * 2;
          if (bytes <= 512 * 1024) rows.push(row);
          count++;
          yield row;
        }
        // Removing an oldest row from a full ASC LIMIT prefix exposes a
        // previously unseen suffix. DESC LIMIT (even reversed for output)
        // cannot expose older rows when its lower bound advances.
        if (cached.complete && !(ascendingLimit && cached.rows.length === limit &&
          lower > timestamp(cached.rows[0]!))) {
          complete = true;
          return;
        }
      }
      for (const row of load()) {
        if (seen.has(row.id)) continue;
        if (count >= limit) break;
        bytes += JSON.stringify(row).length * 2;
        if (bytes <= 512 * 1024) rows.push(row);
        count++;
        yield row;
      }
      complete = true;
    } finally {
      if (generation === this.generation) {
        this.entries.delete(key);
        const retainedBytes = rows.reduce((sum, row) => sum + JSON.stringify(row).length * 2, 0);
        if (rows.length > 0 || complete && bytes === 0) {
          // This private loader has a small fixed set of predicates. Also
          // bound keys/total bytes defensively against future caller growth.
          while (this.entries.size >= 32 || [...this.entries.values()].reduce((n, value) => n + value.bytes, 0) + retainedBytes > 4 * 1024 * 1024) {
            this.entries.delete(this.entries.keys().next().value!);
          }
          this.entries.set(key, { lower, rows, complete: complete && bytes <= 512 * 1024, bytes: retainedBytes });
        }
      }
    }
  }
}
