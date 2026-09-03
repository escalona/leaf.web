export function readDisplayError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
