export interface HexDumpProps {
  memoryData: Uint8Array;
  currentAddress: number;
}

// Formatting functions
function formatHexDump(memoryData: Uint8Array, startAddress: number): string {
  const bytesPerLine = 16;
  const lines: string[] = [];

  for (let i = 0; i < memoryData.length; i += bytesPerLine) {
    const lineAddress = startAddress + i;
    const addrStr = lineAddress.toString(16).toUpperCase().padStart(6, "0");

    const hexBytes: string[] = [];
    const asciiChars: string[] = [];

    for (let j = 0; j < bytesPerLine; j++) {
      const byteIndex = i + j;
      if (byteIndex < memoryData.length) {
        const byte = memoryData[byteIndex];
        hexBytes.push(byte.toString(16).toUpperCase().padStart(2, "0"));

        if (byte >= 32 && byte <= 126) {
          asciiChars.push(String.fromCharCode(byte));
        } else {
          asciiChars.push(".");
        }
      } else {
        hexBytes.push("  ");
        asciiChars.push(" ");
      }
    }

    const hex1 = hexBytes.slice(0, 4).join(" ");
    const hex2 = hexBytes.slice(4, 8).join(" ");
    const hex3 = hexBytes.slice(8, 12).join(" ");
    const hex4 = hexBytes.slice(12, 16).join(" ");
    const ascii = asciiChars.join("");

    lines.push(`${addrStr}  ${hex1}  ${hex2}  ${hex3}  ${hex4}  |${ascii}|`);
  }

  return lines.join("\n");
}

export function HexDump({ memoryData, currentAddress }: HexDumpProps) {
  return (
    <div className="hexDump">{formatHexDump(memoryData, currentAddress)}</div>
  );
}
