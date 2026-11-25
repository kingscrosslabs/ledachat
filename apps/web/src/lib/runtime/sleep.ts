/** Waits `ms` milliseconds. Its own module so tests can skip the wait. */
export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
