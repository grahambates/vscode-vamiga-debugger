export function formatHex(value: number, length = 8): string {
  if (isNaN(value)) {
    return "NaN";
  }
  if (value < 0) {
    return "-0x" + (-value).toString(16).padStart(length, "0");
  }
  return "0x" + value.toString(16).padStart(length, "0");
}

export function isNumeric(value: string): boolean {
  return !isNaN(Number(value));
}

export function u32(value: number): number {
  return value & 0xffff_ffff;
}

export function u16(value: number): number {
  return value & 0xffff;
}

export function u8(value: number): number {
  return value & 0xff;
}

export function i32(value: number): number {
  const v = value & 0xffff_ffff;
  return v >= 0x8000_0000 ? -(0x1_0000_0000 - v) : v;
}

export function i16(value: number): number {
  const v = value & 0xffff;
  return v >= 0x8000 ? -(0x1_0000 - v) : v;
}

export function i8(value: number): number {
  const v = value & 0xff;
  return v >= 0x80 ? -(0x100 - v) : v;
}
