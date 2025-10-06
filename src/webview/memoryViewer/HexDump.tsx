import React, { useState, useRef, useEffect } from "react";

export interface HexDumpProps {
  memoryData: Uint8Array;
  currentAddress: number;
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

export function HexDump({ memoryData, currentAddress }: HexDumpProps) {
  const [format, setFormat] = useState<DisplayFormat>("word");
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const byteInfoMapRef = useRef<ByteInfo[]>([]);
  const previousDataRef = useRef<Uint8Array | null>(null);
  const changedBytesRef = useRef<Map<number, number>>(new Map()); // byte index -> timestamp

  const bytesPerLine = 16;
  const totalLines = Math.ceil(memoryData.length / bytesPerLine);
  const LINE_HEIGHT = 20;
  const CHAR_WIDTH = 8.4; // Monospace character width (adjusted for 14px font)
  const ADDRESS_OFFSET = 10;
  const HEX_OFFSET = 80;

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
      const lineOffset = i * bytesPerLine;
      if (lineOffset >= memoryData.length) break;

      const y = (i - visibleRange.start) * LINE_HEIGHT;
      const lineAddress = currentAddress + lineOffset;

      // Draw address
      ctx.fillStyle = commentColor;
      const addrStr = lineAddress.toString(16).toUpperCase().padStart(6, "0");
      ctx.fillText(addrStr, ADDRESS_OFFSET, y + 2);

      // Draw hex values
      let hexX = HEX_OFFSET;
      for (let j = 0; j < valuesPerLine; j++) {
        const byteIndex = lineOffset + j * valueSize;
        const valueAddress = lineAddress + j * valueSize;

        if (byteIndex < memoryData.length) {
          let value: number;

          switch (format) {
            case "byte":
              value = memoryData[byteIndex];
              break;
            case "word":
              value = byteIndex + 1 < memoryData.length
                ? (memoryData[byteIndex] << 8) | memoryData[byteIndex + 1]
                : memoryData[byteIndex];
              break;
            case "longword":
              if (byteIndex + 3 < memoryData.length) {
                value = (memoryData[byteIndex] << 24) |
                        (memoryData[byteIndex + 1] << 16) |
                        (memoryData[byteIndex + 2] << 8) |
                        memoryData[byteIndex + 3];
                value = value >>> 0;
              } else {
                value = memoryData[byteIndex];
              }
              break;
          }

          const hex = value.toString(16).toUpperCase().padStart(
            format === "byte" ? 2 : format === "word" ? 4 : 8,
            "0"
          );

          // Highlight changed bytes - check if within 1 second of change
          const changeTime = changedBytesRef.current.get(byteIndex);
          const isChanged = changeTime && (Date.now() - changeTime) < 1000;
          if (isChanged) {
            // Fade opacity based on time since change
            const elapsed = Date.now() - changeTime!;
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
      for (let j = 0; j < bytesPerLine && lineOffset + j < memoryData.length; j++) {
        const byte = memoryData[lineOffset + j];
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

  // Track changed bytes with timestamps
  useEffect(() => {
    // Skip change detection on first render
    if (previousDataRef.current === null) {
      previousDataRef.current = new Uint8Array(memoryData);
      return;
    }

    const now = Date.now();
    let hasChanges = false;
    const previousData = previousDataRef.current;

    for (let i = 0; i < memoryData.length; i++) {
      if (previousData[i] !== memoryData[i]) {
        changedBytesRef.current.set(i, now);
        hasChanges = true;
      }
    }
    previousDataRef.current = new Uint8Array(memoryData);

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
  }, [memoryData]);

  // Calculate visible range on scroll
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      const scrollTop = containerRef.current.scrollTop;
      const containerHeight = containerRef.current.clientHeight;

      const buffer = 5;
      const firstVisibleLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - buffer);
      const lastVisibleLine = Math.min(
        totalLines,
        Math.ceil((scrollTop + containerHeight) / LINE_HEIGHT) + buffer
      );

      setVisibleRange({ start: firstVisibleLine, end: lastVisibleLine });
    };

    handleScroll();

    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [totalLines]);

  useEffect(() => {
    renderCanvas();
  }, [memoryData, visibleRange, format, currentAddress]);

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
