/** Never settles on its own; rejects with the signal's reason once `signal` aborts. */
export async function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
