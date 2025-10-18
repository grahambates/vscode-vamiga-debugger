
/**
 * Convert number to signed, based on byte length
 */
export function convertToSigned(value: number, valueSize: number): number {
  if (valueSize === 1) {
    return value > 0x7f ? value - 0x100 : value;
  } else if (valueSize === 2) {
    return value > 0x7fff ? value - 0x1_0000 : value;
  } else {
    return value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
  }
}

/**
 * Get formatted address string for value including offset from previous symbol
 */
export function formatAddress(
  address: number,
  symbols: Record<string, number>,
  symbolLengths: Record<string, number>,
): string {
  const addrHex = address.toString(16).toUpperCase().padStart(6, "0");

  // Find symbol offset (similar to findSymbolOffset in sourceMap.ts)
  // Find the closest symbol before this address
  let symbolOffset: { symbol: string; offset: number } | undefined;
  for (const symbol in symbols) {
    const symAddr = symbols[symbol];
    const offset = address - symAddr;
    // Address is at or after symbol
    if (offset >= 0 && offset < symbolLengths[symbol]) {
      // Keep the closest symbol (smallest offset)
      if (!symbolOffset || offset <= symbolOffset.offset) {
	symbolOffset = { symbol, offset };
      }
    }
  }

  // Build address string with symbol+offset if available
  let addressStr = addrHex;
  if (symbolOffset) {
    addressStr += ": " + symbolOffset.symbol;
    if (symbolOffset.offset > 0) {
      addressStr += "+" + symbolOffset.offset;
    }
  }
  return addressStr;
}