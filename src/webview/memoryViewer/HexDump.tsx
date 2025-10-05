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
  const [format, setFormat] = useState<DisplayFormat>("byte");
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const byteInfoMapRef = useRef<ByteInfo[]>([]);
  const previousDataRef = useRef<Uint8Array>(new Uint8Array());
  const changedBytesRef = useRef<Set<number>>(new Set());

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

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    // Don't render if no visible range
    if (visibleRange.start >= visibleRange.end) return;

    const canvasHeight = (visibleRange.end - visibleRange.start) * LINE_HEIGHT;

    // Calculate minimum width needed for full display
    // Address (6) + space (2) + hex values + space (2) + ASCII (16) + delimiters (2)
    const valueSize = format === "byte" ? 1 : format === "word" ? 2 : 4;
    const hexCharsPerValue = format === "byte" ? 2 : format === "word" ? 4 : 8;
    const valuesPerLine = bytesPerLine / valueSize;
    const hexWidth = valuesPerLine * (hexCharsPerValue + 1) * CHAR_WIDTH + CHAR_WIDTH * 4; // Extra spacing
    const minCanvasWidth = ADDRESS_OFFSET + 60 + hexWidth + 20 + (16 + 3) * CHAR_WIDTH;

    const canvasWidth = Math.max(rect.width, minCanvasWidth);

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    ctx.scale(dpr, dpr);
    ctx.font = '14px monospace';
    ctx.textBaseline = 'top';

    const byteInfos: ByteInfo[] = [];

    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const lineOffset = i * bytesPerLine;
      if (lineOffset >= memoryData.length) break;

      const y = (i - visibleRange.start) * LINE_HEIGHT;
      const lineAddress = currentAddress + lineOffset;

      // Draw address
      ctx.fillStyle = '#858585';
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

          // Highlight changed bytes
          const isChanged = changedBytesRef.current.has(byteIndex);
          if (isChanged) {
            ctx.fillStyle = 'rgba(255, 200, 0, 0.3)';
            ctx.fillRect(hexX, y, hex.length * CHAR_WIDTH, LINE_HEIGHT);
          }

          ctx.fillStyle = '#d4d4d4';
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
      ctx.fillStyle = '#858585';
      ctx.fillText('|', asciiOffset, y + 2);

      let asciiX = asciiOffset + CHAR_WIDTH * 1.5;
      for (let j = 0; j < bytesPerLine && lineOffset + j < memoryData.length; j++) {
        const byte = memoryData[lineOffset + j];
        const char = byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";

        ctx.fillStyle = '#d4d4d4';
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

      ctx.fillStyle = '#858585';
      ctx.fillText('|', asciiX, y + 2);
    }

    byteInfoMapRef.current = byteInfos;
  };

  // Track changed bytes
  useEffect(() => {
    const changed = new Set<number>();
    for (let i = 0; i < memoryData.length; i++) {
      if (previousDataRef.current[i] !== memoryData[i]) {
        changed.add(i);
      }
    }
    changedBytesRef.current = changed;
    previousDataRef.current = new Uint8Array(memoryData);

    // Clear changed markers after animation
    if (changed.size > 0) {
      const timer = setTimeout(() => {
        changedBytesRef.current.clear();
        renderCanvas();
      }, 1000);
      return () => clearTimeout(timer);
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
