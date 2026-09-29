import { AuxiliaryQueryCache } from "./auxiliary-query-cache";

/** Ascending LIMIT results can expose a new suffix as the time window advances. */
export class RecentTreatmentQueryCache<Row extends { id: string; sort_time: number; updated_at: number }> {
  private readonly cache = new AuxiliaryQueryCache<Row>();
  clear(): void { this.cache.clear(); }
  read(lower: number, limit: number, load: () => Iterable<Row>): Iterable<Row> {
    return this.cache.read("recent", lower, load, row => row.updated_at, limit, true);
  }
}
