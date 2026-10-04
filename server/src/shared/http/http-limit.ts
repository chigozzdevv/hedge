export function requestLimiter(limit: number, windowMs: number): (key: string) => boolean {
  const counters = new Map<string, { count: number; until: number }>();
  return (key) => {
    const now = Date.now();
    const previous = counters.get(key);
    if (previous && previous.until > now) return ++previous.count <= limit;
    if (counters.size >= 4096) {
      for (const [id, entry] of counters) if (entry.until <= now) counters.delete(id);
      if (counters.size >= 4096 && !previous) return false;
    }
    counters.set(key, { count: 1, until: now + windowMs });
    return true;
  };
}
