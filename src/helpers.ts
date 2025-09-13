export function formatHex(value: number, length = 8): string {
  return "0x" + value.toString(16).padStart(length, "0");
}

export function isNumeric(value: string): boolean {
  return !isNaN(Number(value));
}