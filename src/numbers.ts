import { SourceMap } from "./sourceMap";

export function formatHex(value: number, length = 8): string {
  if (isNaN(value)) {
    return "NaN";
  }
  if (value < 0) {
    return "-0x" + (-value).toString(16).padStart(length, "0");
  }
  return "0x" + value.toString(16).padStart(length, "0");
}

export function formatBin(value: number, length = 8): string {
  if (isNaN(value)) {
    return "NaN";
  }
  if (value < 0) {
    return "-0b" + (-value).toString(2).padStart(length, "0");
  }
  return "0b" + value.toString(2).padStart(length, "0");
}

/**
 * Formats a memory address with optional symbol information.
 *
 * @param address Memory address to format
 * @returns Formatted string like "0x00001234" or "0x00001234 = main+16"
 */
export function formatAddress(address: number, sourceMap?: SourceMap): string {
  let out = formatHex(address);
  const symbolOffset = sourceMap?.findSymbolOffset(address);
  if (symbolOffset) {
    out += " = " + symbolOffset.symbol;
    if (symbolOffset.offset) {
      out += "+" + symbolOffset.offset;
    }
  }
  return out;
}

export function isNumeric(value: string): boolean {
  return !isNaN(Number(value));
}

export function u32(value: number): number {
  // JavaScript's bitwise operations use 32-bit signed integers
  // Use unsigned shift to preserve sign
  return (value & 0xffff_ffff) >>> 0;
}

export function u16(value: number): number {
  while (value < 0) {
    value += 0x1_0000;
  }
  return value & 0xffff;
}

export function u8(value: number): number {
  while (value < 0) {
    value += 0x100;
  }
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