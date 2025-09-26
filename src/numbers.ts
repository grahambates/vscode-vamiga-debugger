import { SourceMap } from "./sourceMap";

/**
 * Formats a number as a hexadecimal string with optional zero-padding.
 * 
 * @param value The number to format
 * @param length The minimum length of the hex string (default: 8)
 * @returns Formatted hex string like "0x00001234" or "NaN" for invalid numbers
 */
export function formatHex(value: number, length = 8): string {
  if (isNaN(value)) {
    return "NaN";
  }
  if (value < 0) {
    return "-0x" + (-value).toString(16).padStart(length, "0");
  }
  return "0x" + value.toString(16).padStart(length, "0");
}

/**
 * Formats a number as a binary string with optional zero-padding.
 * 
 * @param value The number to format
 * @param length The minimum length of the binary string (default: 8)
 * @returns Formatted binary string like "0b00001010" or "NaN" for invalid numbers
 */
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

/**
 * Checks if a string represents a valid numeric value.
 * 
 * @param value The string to test
 * @returns True if the string can be converted to a valid number
 */
export function isNumeric(value: string): boolean {
  return !isNaN(Number(value));
}

/**
 * Converts a number to an unsigned 32-bit integer.
 * 
 * Handles JavaScript's signed 32-bit limitation by using unsigned right shift
 * to ensure the result is treated as an unsigned value.
 * 
 * @param value The number to convert
 * @returns Unsigned 32-bit integer (0 to 0xFFFFFFFF)
 */
export function u32(value: number): number {
  // JavaScript's bitwise operations use 32-bit signed integers
  // Use unsigned shift to preserve sign
  return (value & 0xffff_ffff) >>> 0;
}

/**
 * Converts a number to an unsigned 16-bit integer.
 * 
 * Handles negative values by wrapping them into the valid 16-bit range.
 * 
 * @param value The number to convert
 * @returns Unsigned 16-bit integer (0 to 0xFFFF)
 */
export function u16(value: number): number {
  while (value < 0) {
    value += 0x1_0000;
  }
  return value & 0xffff;
}

/**
 * Converts a number to an unsigned 8-bit integer.
 * 
 * Handles negative values by wrapping them into the valid 8-bit range.
 * 
 * @param value The number to convert
 * @returns Unsigned 8-bit integer (0 to 0xFF)
 */
export function u8(value: number): number {
  while (value < 0) {
    value += 0x100;
  }
  return value & 0xff;
}

/**
 * Converts a number to a signed 32-bit integer.
 * 
 * Properly handles the two's complement representation for negative values
 * in the 32-bit signed integer range.
 * 
 * @param value The number to convert
 * @returns Signed 32-bit integer (-0x80000000 to 0x7FFFFFFF)
 */
export function i32(value: number): number {
  const v = value & 0xffff_ffff;
  return v >= 0x8000_0000 ? -(0x1_0000_0000 - v) : v;
}

/**
 * Converts a number to a signed 16-bit integer.
 * 
 * Properly handles the two's complement representation for negative values
 * in the 16-bit signed integer range.
 * 
 * @param value The number to convert
 * @returns Signed 16-bit integer (-0x8000 to 0x7FFF)
 */
export function i16(value: number): number {
  const v = value & 0xffff;
  return v >= 0x8000 ? -(0x1_0000 - v) : v;
}

/**
 * Converts a number to a signed 8-bit integer.
 * 
 * Properly handles the two's complement representation for negative values
 * in the 8-bit signed integer range.
 * 
 * @param value The number to convert
 * @returns Signed 8-bit integer (-0x80 to 0x7F)
 */
export function i8(value: number): number {
  const v = value & 0xff;
  return v >= 0x80 ? -(0x100 - v) : v;
}