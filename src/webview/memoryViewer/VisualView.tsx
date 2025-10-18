import React, { useState, useRef, useEffect, useCallback } from "react";
import { guessWidthsUnknownLength } from "./strideGuesser";
import "./VisualView.css";
import { MemoryRange } from "../../shared/memoryViewerTypes";
import { Tooltip, TooltipProps } from "./Tooltip";
import { convertToSigned, formatAddress } from "./lib";

export interface VisualViewProps {
  target: MemoryRange;
  range: MemoryRange;
  symbols: Record<string, number>;
  symbolLengths: Record<string, number>;
  memoryChunks: Map<number, Uint8Array>;
  onRequestMemory: (range: MemoryRange) => void;
  scrollResetTrigger?: number;
}

export function VisualView({
  target,
  range,
  symbols,
  symbolLengths,
  memoryChunks,
  onRequestMemory,
  scrollResetTrigger,
}: VisualViewProps) {
  const [bytesPerRow, setBytesPerRow] = useState<number>(40); // Default 40 bytes = 320 pixels
  const [scale, setScale] = useState<number>(2);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({
    firstLine: 0,
    lastLine: 0,
  });
  const requestedChunksRef = useRef<Set<number>>(new Set());
  const currentScrollByteRef = useRef<number>(target.address); // Track current scroll position in bytes

  const CHUNK_SIZE = 1024;
  const BUFFER_LINES = 20; // Lines beyond visible range to fetch

  // Calculate row alignment - align to target address so it's the first pixel in a row
  // The target address should be at the start of a row
  const alignedRangeStart = range ? target.address : 0;
  const alignedRangeEnd = range
    ? Math.ceil((range.address + range.size - target.address) / bytesPerRow) *
        bytesPerRow +
      target.address
    : 0;
  const viewableRangeTotal = alignedRangeEnd - alignedRangeStart;

  const pixelsPerByte = 8;
  const pixelWidth = bytesPerRow * pixelsPerByte;
  const totalRows = Math.ceil(viewableRangeTotal / bytesPerRow);

  // Helper to get byte from chunks
  const getByte = useCallback(
    (address: number): number | undefined => {
      const chunkOffset = Math.floor(address / CHUNK_SIZE) * CHUNK_SIZE;
      const chunk = memoryChunks.get(chunkOffset);
      if (!chunk) return undefined;
      const byteIndex = address - chunkOffset;
      return byteIndex >= 0 && byteIndex < chunk.length
        ? chunk[byteIndex]
        : undefined;
    },
    [memoryChunks, CHUNK_SIZE],
  );

  // Render bitmap with virtualized scrolling
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Don't render if no visible range
    if (visibleRange.firstLine >= visibleRange.lastLine) {
      return;
    }

    // Get colors from theme
    const styles = getComputedStyle(document.documentElement);
    const foregroundColor =
      styles.getPropertyValue("--vscode-editor-foreground").trim() || "#d4d4d4";
    const backgroundColor =
      styles.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e";

    const canvasHeight =
      (visibleRange.lastLine - visibleRange.firstLine) * scale;
    const canvasWidth = pixelWidth * scale;

    // Set canvas size
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    // Fill background
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw pixels
    ctx.fillStyle = foregroundColor;

    for (
      let line = visibleRange.firstLine;
      line < visibleRange.lastLine;
      line++
    ) {
      const lineAddress = alignedRangeStart + line * bytesPerRow;
      const lineY = line - visibleRange.firstLine;

      for (let byteOffset = 0; byteOffset < bytesPerRow; byteOffset++) {
        const byteAddress = lineAddress + byteOffset;

        // Check if within range
        if (
          !range ||
          byteAddress < range.address ||
          byteAddress >= range.address + range.size
        ) {
          continue;
        }

        const byte = getByte(byteAddress);
        if (byte === undefined) continue;

        // Draw 8 pixels for this byte (MSB first)
        for (let bit = 7; bit >= 0; bit--) {
          const isOn = (byte & (1 << bit)) !== 0;

          if (isOn) {
            const pixelX = byteOffset * 8 + (7 - bit);
            ctx.fillRect(pixelX * scale, lineY * scale, scale, scale);
          }
        }
      }
    }
  }, [
    alignedRangeStart,
    bytesPerRow,
    scale,
    pixelWidth,
    visibleRange,
    range,
    getByte,
  ]);

  // Clear requested chunks on target address change
  useEffect(() => {
    requestedChunksRef.current.clear();
  }, [target.address]);

  // Scroll handling: preserve byte address when bytesPerRow/scale changes, reset when target changes
  const prevBytesPerRowRef = useRef(bytesPerRow);
  const prevScaleRef = useRef(scale);

  useEffect(() => {
    if (!containerRef.current) return;

    const bytesPerRowChanged = prevBytesPerRowRef.current !== bytesPerRow;
    const scaleChanged = prevScaleRef.current !== scale;

    if (bytesPerRowChanged || scaleChanged) {
      // When bytesPerRow or scale changes, maintain the same byte address at scroll top
      const scrollTop =
        Math.floor((currentScrollByteRef.current - alignedRangeStart) / bytesPerRow) * scale;
      containerRef.current.scrollTop = scrollTop;

      prevBytesPerRowRef.current = bytesPerRow;
      prevScaleRef.current = scale;
    } else {
      // When target address or scrollResetTrigger changes, scroll to target
      const scrollTop =
        Math.floor((target.address - alignedRangeStart) / bytesPerRow) * scale;
      containerRef.current.scrollTop = scrollTop;
      currentScrollByteRef.current = target.address;
    }
  }, [
    target.address,
    alignedRangeStart,
    scrollResetTrigger,
    bytesPerRow,
    scale,
  ]);

  // Calculate visible range on scroll and request missing chunks
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      // Calculate range of lines that should be available - visible range + buffer
      const scrollTop = containerRef.current.scrollTop;
      const scrollBottom = scrollTop + containerRef.current.clientHeight;
      const firstLine = Math.max(
        0,
        Math.floor(scrollTop / scale) - BUFFER_LINES,
      );
      const lastLine = Math.min(
        totalRows,
        Math.ceil(scrollBottom / scale) + BUFFER_LINES,
      );
      setVisibleRange({ firstLine, lastLine });

      // Update current scroll byte address for maintaining position on bytesPerRow changes
      const currentScrollLine = Math.floor(scrollTop / scale);
      currentScrollByteRef.current = alignedRangeStart + currentScrollLine * bytesPerRow;

      // Get byte offsets of chunks
      const firstChunk =
        Math.floor((alignedRangeStart + firstLine * bytesPerRow) / CHUNK_SIZE) *
        CHUNK_SIZE;
      const lastChunk =
        Math.floor((alignedRangeStart + lastLine * bytesPerRow) / CHUNK_SIZE) *
        CHUNK_SIZE;

      // Fetch any missing chunks in range:
      for (let c = firstChunk; c <= lastChunk; c += CHUNK_SIZE) {
        const alreadyHaveChunk = memoryChunks.has(c);
        const alreadyRequested = requestedChunksRef.current.has(c);
        if (alreadyHaveChunk || alreadyRequested) {
          continue;
        }
        requestedChunksRef.current.add(c);
        onRequestMemory({ address: c, size: CHUNK_SIZE });
      }
    };

    // Call immediately when target address changes or component mounts
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
    totalRows,
    onRequestMemory,
    target.address,
    alignedRangeStart,
    memoryChunks,
    bytesPerRow,
    scale,
    BUFFER_LINES,
    CHUNK_SIZE,
  ]);

  // Render canvas when content changes:
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Handle mouse move for showing pixel info
  const [tooltip, setTooltip] = useState<TooltipProps | null>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / scale);
    const y = Math.floor((e.clientY - rect.top) / scale);

    // Calculate absolute line and byte address
    const absoluteLine = visibleRange.firstLine + Math.floor(y / scale);
    const lineAddress = alignedRangeStart + absoluteLine * bytesPerRow;
    const pixelXInLine = x % pixelWidth;
    const byteOffset = Math.floor(pixelXInLine / 8);
    const bitPosition = 7 - (pixelXInLine % 8);
    const byteAddress = lineAddress + byteOffset;

    const byte = getByte(byteAddress);
    if (byte !== undefined) {
      // Calculate pixel coordinates relative to target address
      const relativeByteOffset = byteAddress - target.address;
      const relativePixelX = (relativeByteOffset % bytesPerRow) * 8 + (7 - bitPosition);
      const relativePixelY = Math.floor(relativeByteOffset / bytesPerRow);

      // Only show tooltip if coordinates are non-negative (within target range)
      if (relativePixelX >= 0 && relativePixelY >= 0) {
        const isOn = (byte & (1 << bitPosition)) !== 0;
        const signedValue = convertToSigned(byte, 1);
        const byteText =
          signedValue === byte
            ? byte.toString()
            : `${byte.toString()}, ${signedValue.toString()}`;

        setTooltip({
          x: e.clientX,
          y: e.clientY,
          heading: formatAddress(byteAddress, symbols, symbolLengths),
          text: (
            <>
            <div>Pixel ({relativePixelX},{relativePixelY}) = {isOn ? 1 : 0}</div>
            <div>{`Byte Value = ${byteText}`}</div>
            </>
          )
        });
      } else {
        setTooltip(null);
      }
    } else {
      setTooltip(null);
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  if (!range) {
    return <div style={{ padding: "20px" }}>No memory region selected</div>;
  }

  return (
    <div className="visualView">
      <div className="visual-controls">
        <label>
          Width (bytes):
          <input
            type="number"
            min="1"
            max="256"
            value={bytesPerRow}
            onChange={(e) =>
              setBytesPerRow(Math.max(1, parseInt(e.target.value) || 40))
            }
          />
          <span className="visual-info-text">({bytesPerRow * 8} pixels)</span>
        </label>

        <vscode-button
          onClick={() => {
            // Collect enough data starting from target address, potentially spanning chunks
            const GUESS_SAMPLE_SIZE = 1024; // Need enough data for accurate prediction
            const sampleData = new Uint8Array(GUESS_SAMPLE_SIZE);
            let bytesCollected = 0;

            for (
              let offset = 0;
              offset < GUESS_SAMPLE_SIZE && bytesCollected < GUESS_SAMPLE_SIZE;
              offset++
            ) {
              const byte = getByte(target.address + offset);
              if (byte !== undefined) {
                sampleData[bytesCollected++] = byte;
              } else {
                // Stop if we hit missing data
                break;
              }
            }

            const sample = sampleData.slice(0, bytesCollected);
            const guesses = guessWidthsUnknownLength(sample);
            if (guesses.length > 0) {
              console.log("Width guesses:", guesses);
              setBytesPerRow(guesses[0].widthBytes);
            }
          }}
        >
          Guess
        </vscode-button>

        <label>
          Scale:
          <select
            value={scale}
            onChange={(e) => setScale(parseInt(e.target.value))}
          >
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
            <option value="4">4x</option>
            <option value="5">5x</option>
          </select>
        </label>
      </div>

      <div ref={containerRef} className="visual-scroll-container">
        <div
          className="visual-canvas-wrapper"
          style={{
            height: `${totalRows * scale}px`,
          }}
        >
          <canvas
            ref={canvasRef}
            className="visual-canvas"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{
              top: `${visibleRange.firstLine * scale}px`,
            }}
          />
        </div>
      </div>

      {tooltip && <Tooltip {...tooltip} />}
    </div>
  );
}
