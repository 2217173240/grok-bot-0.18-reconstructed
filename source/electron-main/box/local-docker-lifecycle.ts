export function createLocalDockerLifecycle<C>() {
  let tail: Promise<unknown> = Promise.resolve();
  let connection: Promise<C> | undefined;
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const remember = (pending: Promise<C>): Promise<C> => {
    const tracked = pending.finally(() => { if (connection === tracked) connection = undefined; });
    connection = tracked;
    // 恢复调用者等待操作结果；连接结果也可能没有等待者。
    void tracked.catch(() => undefined);
    return tracked;
  };
  return {
    connect(operation: () => Promise<C>): Promise<C> { return connection ?? remember(enqueue(operation)); },
    run<T>(operation: () => Promise<T>): Promise<T> {
      connection = undefined;
      return enqueue(operation);
    },
    recover<T>(operation: () => Promise<{ value: T; connection?: C }>): Promise<T> {
      const result = enqueue(operation);
      remember(result.then(value => {
        if (value.connection === undefined) throw new Error("Local Docker recovery did not establish a connection.");
        return value.connection;
      }));
      return result.then(value => value.value);
    },
  };
}

export function createDockerAvailabilityProbe(run: () => Promise<boolean>, successTtlMs = 60_000, failureTtlMs = 5_000) {
  let cached: { expires: number; value: boolean } | undefined;
  let pending: Promise<boolean> | undefined;
  let generation = 0;
  const probe = (): Promise<boolean> => {
    const current = ++generation;
    const result = run().then(value => {
      if (current === generation) cached = { expires: Date.now() + (value ? successTtlMs : failureTtlMs), value };
      return value;
    }).finally(() => { if (pending === result) pending = undefined; });
    pending = result;
    return result;
  };
  return {
    get(): Promise<boolean> {
      if (pending !== undefined) return pending;
      if (cached !== undefined && cached.expires > Date.now()) return Promise.resolve(cached.value);
      return probe();
    },
    refresh(): Promise<boolean> { cached = undefined; return probe(); },
  };
}
