// Like `Promise.all(items.map(fn))`, but with at most `limit` calls in flight; results keep the
// order of `items`. The first rejection rejects the whole map.
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    // Each worker takes the next index when its call finishes, which is the point of the limit.
    // After a rejection nobody takes another, so the failed map does not go on working.
    // oxlint-disable eslint/no-await-in-loop
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
    // oxlint-enable eslint/no-await-in-loop
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
