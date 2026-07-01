// Escape regex metacharacters before interpolating dynamic values into RegExp.
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
