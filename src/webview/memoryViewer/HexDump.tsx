import React, { useState, useRef, useEffect, useCallback } from "react";
import "./HexDump.css";

export interface HexDumpProps {
  target: { address: number; size: number };
  range: { address: number; size: number };
  symbols: Record<string, number>;
  memoryChunks: Map<number, Uint8Array>;
  onRequestMemory: (range: { address: number; size: number }) => void;
  scrollResetTrigger?: number;
}

type DisplayFormat = "byte" | "word" | "longword";

/**
 * Reference to Hex or ASCII value drawn on canvas
 * used for tooltips and context menus
 */
interface RenderedValue {
  value: number;
  address: number;
  hex: string;
  isAscii: boolean;
  byteLength: 1 | 2 | 4;
  // Canvas location
  x: number;
  y: number;
  width: number;
}

const BUFFER_LINES = 20; // Lines beyond visible range to fetch

const LINE_HEIGHT = 20;
const CHAR_WIDTH = 8.4; // Monospace character width (adjusted for 14px font)
const ADDRESS_OFFSET = 10;
const HEX_OFFSET = 80;
const CHUNK_SIZE = 1024; // Request 1KB chunks
const BYTES_PER_LINE = 16;

// ASCII section: gap (2 chars) + | (1) + gap (1.5) + 16 ASCII chars + | (1)
const ASCII_WIDTH =
  CHAR_WIDTH * 2 +
  CHAR_WIDTH +
  CHAR_WIDTH * 1.5 +
  BYTES_PER_LINE * CHAR_WIDTH +
  CHAR_WIDTH;

const dpr = window.devicePixelRatio || 1;

/**
 * Convert number to signed, based on byte length
 */
function convertToSigned(value: number, valueSize: number): number {
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
function formatAddress(
  address: number,
  symbols: Record<string, number>,
): string {
  const addrHex = address.toString(16).toUpperCase().padStart(6, "0");

  // Find symbol offset (similar to findSymbolOffset in sourceMap.ts)
  // Find the closest symbol before this address
  let symbolOffset: { symbol: string; offset: number } | undefined;
  for (const symbol in symbols) {
    const symAddr = symbols[symbol];
    const offset = address - symAddr;
    // Address is at or after symbol
    if (offset >= 0) {
      // Keep the closest symbol (smallest offset)
      if (!symbolOffset || offset <= symbolOffset.offset) {
        symbolOffset = { symbol, offset };
      }
    }
  }

  // Build address string with symbol+offset if available
  let addressStr = addrHex;
  if (symbolOffset) {
    addressStr += " = " + symbolOffset.symbol;
    if (symbolOffset.offset > 0) {
      addressStr += "+" + symbolOffset.offset;
    }
  }
  return addressStr;
}

export function HexDump({
  target,
  range,
  symbols,
  memoryChunks,
  onRequestMemory,
  scrollResetTrigger,
}: HexDumpProps) {
  const [format, setFormat] = useState<DisplayFormat>("word");
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({
    firstLine: 0,
    lastLine: 0,
  });
  const renderedValuesRef = useRef<RenderedValue[]>([]);
  const previousDataRef = useRef<Map<number, Uint8Array> | null>(null);
  const changedBytesRef = useRef<Map<number, number>>(new Map()); // byte offset -> timestamp
  const requestedChunksRef = useRef<Set<number>>(new Set()); // Track requested chunks to avoid duplicates

  // Align to 16-byte boundary for clean row display
  const alignedRangeStart =
    Math.floor(range.address / BYTES_PER_LINE) * BYTES_PER_LINE;
  const alignedRangeEnd =
    Math.ceil((range.address + range.size) / BYTES_PER_LINE) * BYTES_PER_LINE;
  const viewableRangeTotal = alignedRangeEnd - alignedRangeStart;

  const totalLines = Math.ceil(viewableRangeTotal / BYTES_PER_LINE);

  // Render canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Get colors from CSS variables / theme
    const styles = getComputedStyle(document.documentElement);
    const foregroundColor =
      styles.getPropertyValue("--vscode-editor-foreground").trim() || "#d4d4d4";
    const commentColor =
      styles.getPropertyValue("--vscode-editorLineNumber-foreground").trim() ||
      "#858585";
    const backgroundColor =
      styles.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e";
    const selectionBackground =
      styles.getPropertyValue("--vscode-editor-selectionBackground").trim() ||
      "rgba(0, 120, 215, 0.3)";

    // Helper to get byte from chunks
    const getByte = (address: number): number | undefined => {
      const chunkOffset = Math.floor(address / CHUNK_SIZE) * CHUNK_SIZE;
      const chunk = memoryChunks.get(chunkOffset);
      if (!chunk) {
        return undefined;
      }
      // Calculate byte index within chunk (handle negative offsets)
      const byteIndex = address - chunkOffset;
      return byteIndex >= 0 && byteIndex < chunk.length
        ? chunk[byteIndex]
        : undefined;
    };

    // Don't render if no visible range
    if (visibleRange.firstLine >= visibleRange.lastLine) return;

    const canvasHeight =
      (visibleRange.lastLine - visibleRange.firstLine) * LINE_HEIGHT;

    // Calculate minimum width based on actual rendering positions
    const bytesPerValue = format === "byte" ? 1 : format === "word" ? 2 : 4;
    const hexCharsPerValue = bytesPerValue * 2;
    const valuesPerLine = BYTES_PER_LINE / bytesPerValue;

    // Calculate hex section width (same logic as rendering loop)
    let hexWidth = 0;
    for (let j = 0; j < valuesPerLine; j++) {
      hexWidth += hexCharsPerValue * CHAR_WIDTH + CHAR_WIDTH; // value + space
      if (format === "byte" && (j === 3 || j === 7 || j === 11)) {
        hexWidth += CHAR_WIDTH; // extra spacing for byte groups
      }
    }

    const canvasWidth = HEX_OFFSET + hexWidth + ASCII_WIDTH;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    ctx.scale(dpr, dpr);
    ctx.font = "14px monospace";
    ctx.textBaseline = "top";

    // Clear background
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const renderedValues: RenderedValue[] = [];

    for (let i = visibleRange.firstLine; i < visibleRange.lastLine; i++) {
      // Calculate line address (aligned to 16-byte boundaries)
      const lineAddress = alignedRangeStart + i * BYTES_PER_LINE;

      const y = (i - visibleRange.firstLine) * LINE_HEIGHT;

      // Draw address
      ctx.fillStyle = commentColor;
      const addrStr = lineAddress.toString(16).toUpperCase().padStart(6, "0");
      ctx.fillText(addrStr, ADDRESS_OFFSET, y + 2);

      // Draw hex values
      let x = HEX_OFFSET;
      for (let j = 0; j < valuesPerLine; j++) {
        const byteAddress = lineAddress + j * bytesPerValue;

        const byte0 = getByte(byteAddress);
        if (byte0 === undefined) {
          // Show placeholder for missing data
          ctx.fillStyle = commentColor;
          ctx.fillText("..", x, y + 2);
          x += 2 * CHAR_WIDTH + CHAR_WIDTH;
          if (format === "byte" && (j === 3 || j === 7 || j === 11)) {
            x += CHAR_WIDTH;
          }
          continue;
        }

        if (byte0 !== undefined) {
          let value: number;

          switch (format) {
            case "byte":
              value = byte0;
              break;
            case "word": {
              const byte1 = getByte(byteAddress + 1);
              value = byte1 !== undefined ? (byte0 << 8) | byte1 : byte0;
              break;
            }
            case "longword": {
              const byte1l = getByte(byteAddress + 1);
              const byte2 = getByte(byteAddress + 2);
              const byte3 = getByte(byteAddress + 3);
              if (
                byte1l !== undefined &&
                byte2 !== undefined &&
                byte3 !== undefined
              ) {
                value = (byte0 << 24) | (byte1l << 16) | (byte2 << 8) | byte3;
                value = value >>> 0;
              } else {
                value = byte0;
              }
              break;
            }
          }

          const hex = value
            .toString(16)
            .toUpperCase()
            .padStart(format === "byte" ? 2 : format === "word" ? 4 : 8, "0");

          // Check if this value overlaps with the symbol range
          // Default to at least one value if symbolLength is 0 or undefined
          const targetEndAddress = target.address + target.size;
          const valueEndAddress = byteAddress + bytesPerValue;

          // Selection background for target symbol/address
          const isTargetAddress =
            byteAddress < targetEndAddress && valueEndAddress > target.address;
          if (isTargetAddress) {
            ctx.fillStyle = selectionBackground;
            ctx.fillRect(x, y, hex.length * CHAR_WIDTH, LINE_HEIGHT);
          }

          // Highlight changed bytes - check if ANY byte in this value changed within 1 second
          let mostRecentChange = 0;
          for (let b = 0; b < bytesPerValue; b++) {
            const changeTime = changedBytesRef.current.get(byteAddress + b);
            if (changeTime) {
              mostRecentChange = Math.max(mostRecentChange, changeTime);
            }
          }
          const isChanged =
            mostRecentChange > 0 && Date.now() - mostRecentChange < 1000;
          if (isChanged) {
            // Fade from yellow to transparent
            const elapsed = Date.now() - mostRecentChange;
            const changeFactor = 1 - elapsed / 1000; // 1.0 at start, 0.0 at end
            const opacity = 0.5 * changeFactor;
            ctx.fillStyle = `rgba(255, 200, 0, ${opacity})`;
            ctx.fillRect(x, y, hex.length * CHAR_WIDTH, LINE_HEIGHT);
          }

          ctx.fillStyle = foregroundColor;
          ctx.fillText(hex, x, y + 2);

          // Store hex value
          renderedValues.push({
            value,
            address: byteAddress,
            hex,
            x,
            y,
            width: hex.length * CHAR_WIDTH,
            isAscii: false,
            byteLength: bytesPerValue,
          });

          x += hex.length * CHAR_WIDTH + CHAR_WIDTH;

          // Extra spacing for byte groups
          if (format === "byte" && (j === 3 || j === 7 || j === 11)) {
            x += CHAR_WIDTH;
          }
        }
      }

      // Draw ASCII - calculate offset based on actual hex width
      const asciiOffset = x + CHAR_WIDTH * 2;
      ctx.fillStyle = commentColor;
      ctx.fillText("|", asciiOffset, y + 2);

      let asciiX = asciiOffset + CHAR_WIDTH * 1.5;
      for (let j = 0; j < BYTES_PER_LINE; j++) {
        const byte = getByte(lineAddress + j);
        if (byte === undefined) break;
        const char =
          byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";

        // Highlight symbol range in ASCII section
        const byteAddress = lineAddress + j;
        const targetEndAddress = target.address + target.size;
        const valueEndAddress = byteAddress + 1;
        const isTargetAddress =
          byteAddress < targetEndAddress && valueEndAddress > target.address;

        if (isTargetAddress) {
          ctx.fillStyle = selectionBackground;
          ctx.fillRect(asciiX, y, CHAR_WIDTH, LINE_HEIGHT);
        }

        ctx.fillStyle = commentColor;
        ctx.fillText(char, asciiX, y + 2);

        // Store ASCII value
        renderedValues.push({
          value: byte,
          address: lineAddress + j,
          hex: byte.toString(16).toUpperCase().padStart(2, "0"),
          x: asciiX,
          y,
          width: CHAR_WIDTH,
          isAscii: true,
          byteLength: 1,
        });

        asciiX += CHAR_WIDTH;
      }

      ctx.fillStyle = commentColor;
      ctx.fillText("|", asciiX, y + 2);
    }

    renderedValuesRef.current = renderedValues;
  }, [alignedRangeStart, format, target, memoryChunks, visibleRange]);

  // Clear requested on address
  useEffect(() => {
    requestedChunksRef.current.clear();
  }, [target.address]);

  // Scroll to target
  useEffect(() => {
    if (containerRef.current) {
      const scrollTop =
        Math.floor((target.address - alignedRangeStart) / BYTES_PER_LINE) *
        LINE_HEIGHT;
      containerRef.current.scrollTop = scrollTop;
    }
  }, [target.address, alignedRangeStart, scrollResetTrigger]);

  // Track changed bytes with timestamps
  useEffect(() => {
    const now = Date.now();
    let hasChanges = false;

    // Compare each chunk with previous version
    memoryChunks.forEach((chunk, offset) => {
      const prevChunk = previousDataRef.current?.get(offset);
      if (prevChunk) {
        for (let i = 0; i < chunk.length; i++) {
          if (prevChunk[i] !== chunk[i]) {
            changedBytesRef.current.set(offset + i, now);
            hasChanges = true;
          }
        }
      }
    });

    // Update previous data
    previousDataRef.current = new Map(memoryChunks);

    // Clean up old change markers (older than 1 second)
    const cutoff = now - 1000;
    for (const [index, time] of changedBytesRef.current.entries()) {
      if (time < cutoff) {
        changedBytesRef.current.delete(index);
      }
    }

    // Set up animation frame loop to fade out highlights
    if (hasChanges || changedBytesRef.current.size > 0) {
      let animationId: number;
      const animate = () => {
        const currentTime = Date.now();
        const cutoffTime = currentTime - 1000;

        // Remove expired highlights
        for (const [index, time] of changedBytesRef.current.entries()) {
          if (time < cutoffTime) {
            changedBytesRef.current.delete(index);
          }
        }

        // Re-render to update fade
        renderCanvas();

        // Continue animation if there are still active highlights
        if (changedBytesRef.current.size > 0) {
          animationId = requestAnimationFrame(animate);
        }
      };

      animationId = requestAnimationFrame(animate);
      return () => cancelAnimationFrame(animationId);
    }
  }, [memoryChunks, renderCanvas]);

  // Calculate visible range on scroll and request missing chunks
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      // Calculate range of lines that should be available - visible range + buffer
      const scrollTop = containerRef.current.scrollTop;
      const scrollBottom = scrollTop + containerRef.current.clientHeight;
      const firstLine = Math.max(
        0,
        Math.floor(scrollTop / LINE_HEIGHT) - BUFFER_LINES,
      );
      const lastLine = Math.min(
        totalLines,
        Math.ceil(scrollBottom / LINE_HEIGHT) + BUFFER_LINES,
      );
      setVisibleRange({ firstLine, lastLine });

      // Get byte offsets of chunks
      const firstChunk =
        Math.floor(
          (alignedRangeStart + firstLine * BYTES_PER_LINE) / CHUNK_SIZE,
        ) * CHUNK_SIZE;
      const lastChunk =
        Math.floor(
          (alignedRangeStart + lastLine * BYTES_PER_LINE) / CHUNK_SIZE,
        ) * CHUNK_SIZE;

      // Fetch any missing chunks in range:
      for (let c = firstChunk; c <= lastChunk; c += CHUNK_SIZE) {
        const alreadyHaveChunk = memoryChunks.has(c);
        const alreadyRequested = requestedChunksRef.current.has(c);
        console.log({
          c,
          alreadyHaveChunk,
          alreadyRequested,
        });
        if (alreadyHaveChunk || alreadyRequested) {
          continue;
        }
        requestedChunksRef.current.add(c);
        onRequestMemory({ address: c, size: CHUNK_SIZE });
      }
    };

    // Call immediately when baseAddress changes or component mounts
    handleScroll();

    // Call max once per frame
    let ticking = false;
    const handleScrollPerFrame = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("scroll", handleScrollPerFrame);
      return () => {
        container.removeEventListener("scroll", handleScrollPerFrame);
      };
    }
  }, [
    totalLines,
    onRequestMemory,
    target.address,
    alignedRangeStart,
    memoryChunks,
  ]);

  // Render canvas when content changes:
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Handle mouse move for tooltips
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find byte under cursor
    const byteInfo = renderedValuesRef.current.find(
      (info) =>
        x >= info.x &&
        x <= info.x + info.width &&
        y >= info.y &&
        y <= info.y + LINE_HEIGHT,
    );

    if (byteInfo) {
      const addressStr = formatAddress(byteInfo.address, symbols);
      const signedValue = convertToSigned(byteInfo.value, byteInfo.byteLength);
      setTooltip({
        x: e.clientX,
        y: e.clientY,
        text: `0x${byteInfo.hex} (u:${byteInfo.value.toString()} s:${signedValue.toString()}) @ ${addressStr}`,
      });
    } else {
      setTooltip(null);
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find byte under cursor
    const byteInfo = renderedValuesRef.current.find(
      (info) =>
        x >= info.x &&
        x <= info.x + info.width &&
        y >= info.y &&
        y <= info.y + LINE_HEIGHT,
    );

    if (byteInfo) {
      // Copy hex value to clipboard
      const hexValue = "0x" + byteInfo.hex;
      navigator.clipboard
        .writeText(hexValue)
        .then(() => {
          // Show brief feedback
          setTooltip({
            x: e.clientX,
            y: e.clientY,
            text: `Copied: ${hexValue}`,
          });
          setTimeout(() => setTooltip(null), 1000);
        })
        .catch((err) => {
          console.error("Failed to copy to clipboard:", err);
        });
    }
  };

  return (
    <div className="hexDump">
      <div className="hex-controls">
        <label>
          Format:
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as DisplayFormat)}
          >
            <option value="byte">Byte (8-bit)</option>
            <option value="word">Word (16-bit)</option>
            <option value="longword">Longword (32-bit)</option>
          </select>
        </label>
      </div>
      <div className="hex-scroll-container" ref={containerRef}>
        <div
          style={{
            height: `${totalLines * LINE_HEIGHT}px`,
            position: "relative",
          }}
        >
          <canvas
            className="hex-canvas"
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onContextMenu={handleContextMenu}
            style={{
              top: `${visibleRange.firstLine * LINE_HEIGHT}px`,
            }}
          />
        </div>
      </div>
      {tooltip && (
        <div
          className="hex-tooltip"
          style={{
            left: tooltip.x + 10,
            top: tooltip.y + 10,
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
