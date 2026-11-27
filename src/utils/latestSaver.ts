export function createLatestSaver<T>(
  send: (value: T) => Promise<unknown>,
  onError: (error: unknown, value: T) => void,
): (value: T) => void {
  let running = false;
  let pending: { value: T } | null = null;

  const drain = async () => {
    running = true;
    while (pending) {
      const { value } = pending;
      pending = null;
      try {
        await send(value);
      } catch (error) {
        if (!pending) onError(error, value);
      }
    }
    running = false;
  };

  return (value: T) => {
    pending = { value };
    if (!running) void drain();
  };
}
