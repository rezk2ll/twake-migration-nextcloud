/**
 * @param error - Caught error value
 * @returns The error message string, or String(error) for non-Error values
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
