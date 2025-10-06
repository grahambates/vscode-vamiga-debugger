import React, { useState, useRef, useEffect } from "react";

export interface HexDumpProps {
  baseAddress: number;
  memoryRange: { start: number; end: number };
  memoryChunks: Map<number, Uint8Array>;
  onRequestMemory: (offset: number, count: number) => void;
  scrollResetTrigger?: number;
  scrollOffsetDelta?: number; // Offset delta to adjust scroll by when base address changes
}

type DisplayFormat = "byte" | "word" | "longword";

interface ByteInfo {
  value: number;
  address: number;
  hex: string;
  x: number;
  y: number;
  width: number;
  isAscii: boolean;
}

export function HexDump({ baseAddress, memoryRange, memoryChunks, onRequestMemory, scrollResetTrigger, scrollOffsetDelta }: HexDumpProps) {
  const [format, setFormat] = useState<DisplayFormat>("word");
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const byteInfoMapRef = useRef<ByteInfo[]>([]);
  const previousDataRef = useRef<Map<number, Uint8Array> | null>(null);
  const changedBytesRef = useRef<Map<number, number>>(new Map()); // byte offset -> timestamp
  const requestedChunksRef = useRef<Set<number>>(new Set()); // Track requested chunks to avoid duplicates
  const memoryChunksRef = useRef<Map<number, Uint8Array>>(memoryChunks);

  const bytesPerLine = 16;
  const VIEWABLE_RANGE_BACKWARD = Math.abs(memoryRange.start); // How far back we can go
  const VIEWABLE_RANGE_FORWARD = memoryRange.end; // How far forward we can go
  const VIEWABLE_RANGE_TOTAL = VIEWABLE_RANGE_BACKWARD + VIEWABLE_RANGE_FORWARD;
  const totalLines = Math.ceil(VIEWABLE_RANGE_TOTAL / bytesPerLine);
  const LINE_HEIGHT = 20;
  const CHAR_WIDTH = 8.4; // Monospace character width (adjusted for 14px font)
  const ADDRESS_OFFSET = 10;
  const HEX_OFFSET = 80;
  const CHUNK_SIZE = 1024; // Request 1KB chunks
  const BACKWARD_OFFSET_LINES = Math.ceil(VIEWABLE_RANGE_BACKWARD / bytesPerLine); // Lines before base address

  // Helper to get byte from chunks (offset can be negative)
  const getByte = (offset: number): number | undefined => {
    // For negative offsets, we need to floor towards negative infinity
    const chunkOffset = Math.floor(offset / CHUNK_SIZE) * CHUNK_SIZE;
    const chunk = memoryChunks.get(chunkOffset);
    if (!chunk) {
      // console.log(`No chunk for offset ${offset} (chunk ${chunkOffset})`);
      return undefined;
    }
    // Calculate byte index within chunk (handle negative offsets)
    const byteIndex = offset - chunkOffset;
    return byteIndex >= 0 && byteIndex < chunk.length ? chunk[byteIndex] : undefined;
  };

  // Render canvas
  const renderCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get colors from CSS variables / theme
    const styles = getComputedStyle(document.documentElement);
    const foregroundColor = styles.getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4';
    const commentColor = styles.getPropertyValue('--vscode-editorLineNumber-foreground').trim() || '#858585';
    const backgroundColor = styles.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';

    const dpr = window.devicePixelRatio || 1;

    // Don't render if no visible range
    if (visibleRange.start >= visibleRange.end) return;

    const canvasHeight = (visibleRange.end - visibleRange.start) * LINE_HEIGHT;

    // Calculate minimum width based on actual rendering positions
    const valueSize = format === "byte" ? 1 : format === "word" ? 2 : 4;
    const hexCharsPerValue = format === "byte" ? 2 : format === "word" ? 4 : 8;
    const valuesPerLine = bytesPerLine / valueSize;

    // Calculate hex section width (same logic as rendering loop)
    let hexWidth = 0;
    for (let j = 0; j < valuesPerLine; j++) {
      hexWidth += hexCharsPerValue * CHAR_WIDTH + CHAR_WIDTH; // value + space
      if (format === "byte" && (j === 3 || j === 7 || j === 11)) {
        hexWidth += CHAR_WIDTH; // extra spacing for byte groups
      }
    }

    // ASCII section: gap (2 chars) + | (1) + gap (1.5) + 16 ASCII chars + | (1)
    const asciiWidth = CHAR_WIDTH * 2 + CHAR_WIDTH + CHAR_WIDTH * 1.5 + bytesPerLine * CHAR_WIDTH + CHAR_WIDTH;

    const canvasWidth = HEX_OFFSET + hexWidth + asciiWidth;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    ctx.scale(dpr, dpr);
    ctx.font = '14px monospace';
    ctx.textBaseline = 'top';

    // Clear background
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const byteInfos: ByteInfo[] = [];

    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      // Convert line number to actual byte offset (can be negative)
      const lineOffset = (i - BACKWARD_OFFSET_LINES) * bytesPerLine;

      const y = (i - visibleRange.start) * LINE_HEIGHT;
      const lineAddress = baseAddress + lineOffset;

      // Draw address
      ctx.fillStyle = commentColor;
      const addrStr = lineAddress.toString(16).toUpperCase().padStart(6, "0");
      ctx.fillText(addrStr, ADDRESS_OFFSET, y + 2);

      // Draw hex values
      let hexX = HEX_OFFSET;
      for (let j = 0; j < valuesPerLine; j++) {
        const byteOffset = lineOffset + j * valueSize;
        const valueAddress = lineAddress + j * valueSize;

        const byte0 = getByte(byteOffset);
        if (byte0 === undefined) {
          // Show placeholder for missing data
          ctx.fillStyle = commentColor;
          ctx.fillText('..', hexX, y + 2);
          hexX += 2 * CHAR_WIDTH + CHAR_WIDTH;
          if (format === "byte" && (j === 3 || j === 7 || j === 11)) {
            hexX += CHAR_WIDTH;
          }
          continue;
        }

        if (byte0 !== undefined) {
          let value: number;

          switch (format) {
            case "byte":
              value = byte0;
              break;
            case "word":
              const byte1 = getByte(byteOffset + 1);
              value = byte1 !== undefined
                ? (byte0 << 8) | byte1
                : byte0;
              break;
            case "longword":
              const byte1l = getByte(byteOffset + 1);
              const byte2 = getByte(byteOffset + 2);
              const byte3 = getByte(byteOffset + 3);
              if (byte1l !== undefined && byte2 !== undefined && byte3 !== undefined) {
                value = (byte0 << 24) |
                        (byte1l << 16) |
                        (byte2 << 8) |
                        byte3;
                value = value >>> 0;
              } else {
                value = byte0;
              }
              break;
          }

          const hex = value.toString(16).toUpperCase().padStart(
            format === "byte" ? 2 : format === "word" ? 4 : 8,
            "0"
          );

          // Highlight changed bytes - check if ANY byte in this value changed within 1 second
          let mostRecentChange = 0;
          for (let b = 0; b < valueSize; b++) {
            const changeTime = changedBytesRef.current.get(byteOffset + b);
            if (changeTime) {
              mostRecentChange = Math.max(mostRecentChange, changeTime);
            }
          }
          const isChanged = mostRecentChange > 0 && (Date.now() - mostRecentChange) < 1000;
          if (isChanged) {
            // Fade opacity based on time since change
            const elapsed = Date.now() - mostRecentChange;
            const opacity = 0.5 * (1 - elapsed / 1000);
            ctx.fillStyle = `rgba(255, 200, 0, ${opacity})`;
            ctx.fillRect(hexX, y, hex.length * CHAR_WIDTH, LINE_HEIGHT);
          }

          ctx.fillStyle = foregroundColor;
          ctx.fillText(hex, hexX, y + 2);

          byteInfos.push({
            value,
            address: valueAddress,
            hex,
            x: hexX,
            y,
            width: hex.length * CHAR_WIDTH,
            isAscii: false
          });

          hexX += hex.length * CHAR_WIDTH + CHAR_WIDTH;

          // Extra spacing for byte groups
          if (format === "byte" && (j === 3 || j === 7 || j === 11)) {
            hexX += CHAR_WIDTH;
          }
        }
      }

      // Draw ASCII - calculate offset based on actual hex width
      const asciiOffset = hexX + CHAR_WIDTH * 2;
      ctx.fillStyle = commentColor;
      ctx.fillText('|', asciiOffset, y + 2);

      let asciiX = asciiOffset + CHAR_WIDTH * 1.5;
      for (let j = 0; j < bytesPerLine; j++) {
        const byte = getByte(lineOffset + j);
        if (byte === undefined) break;
        const char = byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";

        ctx.fillStyle = commentColor;
        ctx.fillText(char, asciiX, y + 2);

        byteInfos.push({
          value: byte,
          address: lineAddress + j,
          hex: byte.toString(16).toUpperCase().padStart(2, "0"),
          x: asciiX,
          y,
          width: CHAR_WIDTH,
          isAscii: true
        });

        asciiX += CHAR_WIDTH;
      }

      ctx.fillStyle = commentColor;
      ctx.fillText('|', asciiX, y + 2);
    }

    byteInfoMapRef.current = byteInfos;
  };

  // Keep ref in sync with state
  useEffect(() => {
    memoryChunksRef.current = memoryChunks;
  }, [memoryChunks]);

  // Clear requested chunks and scroll to base address when it changes
  useEffect(() => {
    requestedChunksRef.current.clear();

    // Always scroll to show base address at the top when baseAddress changes
    if (containerRef.current && baseAddress !== undefined) {
      containerRef.current.scrollTop = BACKWARD_OFFSET_LINES * LINE_HEIGHT;
    }
  }, [baseAddress, BACKWARD_OFFSET_LINES]);

  // Reset scroll when scrollResetTrigger changes (same address re-submitted)
  useEffect(() => {
    if (scrollResetTrigger && containerRef.current && baseAddress !== undefined) {
      containerRef.current.scrollTop = BACKWARD_OFFSET_LINES * LINE_HEIGHT;
    }
  }, [scrollResetTrigger, BACKWARD_OFFSET_LINES]);

  // Adjust scroll position when base address changes but we want to preserve offset
  useEffect(() => {
    if (scrollOffsetDelta !== undefined && scrollOffsetDelta !== 0 && containerRef.current) {
      // Convert byte offset delta to line offset
      const lineOffsetDelta = scrollOffsetDelta / bytesPerLine;
      const scrollDelta = lineOffsetDelta * LINE_HEIGHT;

      // Adjust scroll position by the delta
      const currentScrollTop = containerRef.current.scrollTop;
      containerRef.current.scrollTop = currentScrollTop - scrollDelta;

      console.log(`Adjusted scroll by ${scrollOffsetDelta} bytes (${lineOffsetDelta} lines, ${scrollDelta}px)`);
    }
  }, [scrollOffsetDelta, bytesPerLine]);

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
  }, [memoryChunks]);

  // Calculate visible range on scroll and request missing chunks
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      // Don't request chunks if we don't have a valid base address yet
      if (baseAddress === undefined) {
        console.log('Skipping chunk request - baseAddress not set yet');
        return;
      }

      const scrollTop = containerRef.current.scrollTop;
      const containerHeight = containerRef.current.clientHeight;

      // If container has no height yet, default to reasonable value
      const effectiveHeight = containerHeight || 600;

      const buffer = 20; // Larger buffer to prefetch more aggressively
      const firstVisibleLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - buffer);
      const lastVisibleLine = Math.min(
        totalLines,
        Math.ceil((scrollTop + effectiveHeight) / LINE_HEIGHT) + buffer
      );

      setVisibleRange({ start: firstVisibleLine, end: lastVisibleLine });

      // Request missing chunks for visible range (convert to actual byte offsets, can be negative)
      const firstByte = (firstVisibleLine - BACKWARD_OFFSET_LINES) * bytesPerLine;
      const lastByte = (lastVisibleLine - BACKWARD_OFFSET_LINES) * bytesPerLine;

      // Request chunks in the range (handle negative offsets)
      const firstChunk = Math.floor(firstByte / CHUNK_SIZE) * CHUNK_SIZE;
      const lastChunk = Math.floor(lastByte / CHUNK_SIZE) * CHUNK_SIZE;

      for (let chunkOffset = firstChunk; chunkOffset <= lastChunk; chunkOffset += CHUNK_SIZE) {
        if (!memoryChunksRef.current.has(chunkOffset) && !requestedChunksRef.current.has(chunkOffset)) {
          console.log(`Requesting chunk at offset ${chunkOffset} (baseAddr=${baseAddress})`);
          requestedChunksRef.current.add(chunkOffset);
          onRequestMemory(chunkOffset, CHUNK_SIZE);
        }
      }
    };

    // Call immediately when baseAddress changes or component mounts
    handleScroll();

    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => {
        container.removeEventListener('scroll', handleScroll);
      };
    }
  }, [totalLines, onRequestMemory, baseAddress]);

  useEffect(() => {
    console.log(`Rendering: chunks=${memoryChunks.size}, range=${visibleRange.start}-${visibleRange.end}, baseAddr=${baseAddress}`);
    console.log('Available chunks:', Array.from(memoryChunks.keys()));
    renderCanvas();
  }, [memoryChunks, visibleRange, format, baseAddress]);

  // Handle mouse move for tooltips
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find byte under cursor
    const byteInfo = byteInfoMapRef.current.find(
      info => x >= info.x && x <= info.x + info.width &&
              y >= info.y && y <= info.y + LINE_HEIGHT
    );

    if (byteInfo) {
      const addrHex = byteInfo.address.toString(16).toUpperCase().padStart(6, "0");
      setTooltip({
        x: e.clientX,
        y: e.clientY,
        text: `0x${byteInfo.hex} (${byteInfo.value}) @ ${addrHex}`
      });
    } else {
      setTooltip(null);
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  const totalHeight = totalLines * LINE_HEIGHT;

  return (
    <div className="hexDump">
      <div className="hex-controls">
        <label>
          Format:
          <select value={format} onChange={(e) => setFormat(e.target.value as DisplayFormat)}>
            <option value="byte">Byte (8-bit)</option>
            <option value="word">Word (16-bit)</option>
            <option value="longword">Longword (32-bit)</option>
          </select>
        </label>
      </div>
      <div
        className="hex-scroll-container"
        ref={containerRef}
        style={{
          height: '100%',
          overflowX: 'auto',
          overflowY: 'auto',
          position: 'relative'
        }}
      >
        <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{
              position: 'absolute',
              top: `${visibleRange.start * LINE_HEIGHT}px`,
              left: 0,
              cursor: 'crosshair',
              imageRendering: 'crisp-edges'
            }}
          />
        </div>
      </div>
      {tooltip && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 10,
            top: tooltip.y + 10,
            backgroundColor: '#1e1e1e',
            color: '#d4d4d4',
            border: '1px solid #454545',
            padding: '4px 8px',
            borderRadius: '3px',
            fontSize: '12px',
            fontFamily: 'monospace',
            pointerEvents: 'none',
            zIndex: 1000,
            whiteSpace: 'nowrap'
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
