import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  disassembleBytes,
  CPUInstruction,
  concatBytes,
} from "./cpuDisassembler";
import "./DisassemblyView.css";

export interface DisassemblyViewProps {
  target: { address: number; size: number };
  range: { address: number; size: number };
  symbols: Record<string, number>;
  symbolLengths: Record<string, number>;
  memoryChunks: Map<number, Uint8Array>;
  onRequestMemory: (range: { address: number; size: number }) => void;
  scrollResetTrigger?: number;
}

const CHUNK_SIZE = 1024;
const LINE_HEIGHT = 20;
const BUFFER_LINES = 30; // Extra buffer for variable-length instructions

/**
 * DisassemblyView component for M68k CPU instructions
 *
 * Challenges:
 * 1. Variable-length instructions (2-10 bytes) make it impossible to calculate
 *    exact line positions without disassembling from the start
 * 2. Instructions may span chunk boundaries
 * 3. We can only disassemble sequentially from a known starting point
 *
 * Solution:
 * - Disassemble from the target address forward only (no backward scrolling)
 * - Build instruction array incrementally as more chunks are loaded
 * - Handle cross-chunk instruction boundaries by concatenating adjacent chunks
 * - Use virtual scrolling but rebuild from start address each time
 */
export function DisassemblyView({
  target,
  range,
  symbols,
  symbolLengths,
  memoryChunks,
  onRequestMemory,
  scrollResetTrigger,
}: DisassemblyViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visibleRange, setVisibleRange] = useState({
    firstLine: 0,
    lastLine: 0,
  });
  const requestedChunksRef = useRef<Set<number>>(new Set());

  // Cache disassembled instructions to avoid re-disassembling on every render
  const [instructions, setInstructions] = useState<CPUInstruction[]>([]);
  const lastDisassemblyAddressRef = useRef<number>(-1);

  if (!range) {
    return <div style={{ padding: "20px" }}>No memory region selected</div>;
  }

  // Start disassembly at target address (must be even-aligned)
  const startAddress = target.address & ~1;
  const endAddress = range.address + range.size;

  // Get contiguous bytes starting from an address
  // Handles cross-chunk boundaries by concatenating adjacent chunks
  const getContiguousBytes = useCallback(
    (fromAddress: number, maxBytes: number): Uint8Array | null => {
      const result: Uint8Array[] = [];
      let currentAddress = fromAddress;
      let remainingBytes = maxBytes;

      while (remainingBytes > 0) {
        const chunkOffset = Math.floor(currentAddress / CHUNK_SIZE) * CHUNK_SIZE;
        const chunk = memoryChunks.get(chunkOffset);

        if (!chunk) {
          // Missing chunk - return what we have so far, or null if nothing
          return result.length > 0 ? concatBytes(...result) : null;
        }

        const byteIndexInChunk = currentAddress - chunkOffset;
        const bytesAvailableInChunk = chunk.length - byteIndexInChunk;
        const bytesToTake = Math.min(bytesAvailableInChunk, remainingBytes);

        if (bytesToTake <= 0) break;

        result.push(chunk.slice(byteIndexInChunk, byteIndexInChunk + bytesToTake));
        currentAddress += bytesToTake;
        remainingBytes -= bytesToTake;
      }

      return result.length > 0 ? concatBytes(...result) : null;
    },
    [memoryChunks]
  );

  // Disassemble instructions from start address up to a certain byte count
  // This is rebuilt whenever we need more instructions or chunks change
  const disassembleFromStart = useCallback(
    (maxBytes: number): CPUInstruction[] => {
      const bytes = getContiguousBytes(startAddress, maxBytes);
      if (!bytes || bytes.length === 0) {
        return [];
      }

      const result = disassembleBytes(startAddress, bytes);
      return result.instructions;
    },
    [startAddress, getContiguousBytes]
  );

  // Calculate how many bytes we need to disassemble to get enough instructions
  // for the visible range plus buffer
  const calculateRequiredBytes = useCallback(
    (targetLineCount: number): number => {
      // Estimate: average instruction is ~3 bytes, but use 2.5 to be safe
      // Add extra buffer for chunk alignment
      const estimatedBytes = Math.ceil(targetLineCount * 2.5);
      return Math.min(estimatedBytes, endAddress - startAddress);
    },
    [startAddress, endAddress]
  );

  // Render disassembly to canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (visibleRange.firstLine >= visibleRange.lastLine) {
      return;
    }

    const styles = getComputedStyle(document.documentElement);
    const foregroundColor =
      styles.getPropertyValue("--vscode-editor-foreground").trim() || "#d4d4d4";
    const commentColor =
      styles.getPropertyValue("--vscode-editorLineNumber-foreground").trim() ||
      "#858585";
    const backgroundColor =
      styles.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e";
    const keywordColor =
      styles.getPropertyValue("--vscode-symbolIcon-keywordForeground").trim() ||
      "#569cd6";
    const numberColor =
      styles.getPropertyValue("--vscode-symbolIcon-numberForeground").trim() ||
      "#b5cea8";
    const selectionBackground =
      styles.getPropertyValue("--vscode-editor-selectionBackground").trim() ||
      "rgba(0, 120, 215, 0.3)";

    const canvasHeight = (visibleRange.lastLine - visibleRange.firstLine) * LINE_HEIGHT;
    const canvasWidth = containerRef.current?.clientWidth || 800;

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    ctx.font = "14px monospace";
    ctx.textBaseline = "top";

    // Render visible instructions
    for (let i = visibleRange.firstLine; i < visibleRange.lastLine; i++) {
      const y = (i - visibleRange.firstLine) * LINE_HEIGHT;

      if (i >= instructions.length) {
        // No instruction available yet
        ctx.fillStyle = commentColor;
        ctx.fillText("...", 10, y + 2);
        continue;
      }

      const instr = instructions[i];
      let x = 10;

      // Highlight target address range
      const isTarget =
        instr.address >= target.address &&
        instr.address < target.address + target.size;

      if (isTarget) {
        ctx.fillStyle = selectionBackground;
        ctx.fillRect(0, y, canvasWidth, LINE_HEIGHT);
      }

      // Address
      ctx.fillStyle = commentColor;
      const addrStr = instr.address.toString(16).toUpperCase().padStart(6, "0");
      ctx.fillText(addrStr + ":", x, y + 2);
      x += 80;

      // Raw bytes (show up to 10 bytes, with ellipsis if truncated)
      ctx.fillStyle = commentColor;
      const bytesStr = Array.from(instr.bytes)
        .slice(0, 5) // Show first 5 bytes max
        .map(b => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");
      const bytesDisplay = instr.bytes.length > 5 ? bytesStr + "..." : bytesStr;
      ctx.fillText(bytesDisplay.padEnd(17), x, y + 2);
      x += 140;

      // Mnemonic
      ctx.fillStyle = keywordColor;
      ctx.fillText(instr.mnemonic.padEnd(8), x, y + 2);
      x += 80;

      // Operands
      ctx.fillStyle = numberColor;
      ctx.fillText(instr.operands, x, y + 2);
      x += 250;

      // Comment (symbol information)
      if (instr.comment) {
        ctx.fillStyle = commentColor;
        ctx.fillText("; " + instr.comment, x, y + 2);
      } else {
        // Check if this address has a symbol
        const symbolEntry = Object.entries(symbols).find(
          ([_, addr]) => addr === instr.address
        );
        if (symbolEntry) {
          ctx.fillStyle = commentColor;
          ctx.fillText("; " + symbolEntry[0], x, y + 2);
        }
      }
    }
  }, [visibleRange, instructions, target, symbols]);

  // Clear requested chunks and instructions on target address change
  useEffect(() => {
    requestedChunksRef.current.clear();
    setInstructions([]);
    lastDisassemblyAddressRef.current = -1;
  }, [target.address]);

  // Scroll to target
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0; // Always start at top
    }
  }, [target.address, scrollResetTrigger]);

  // Update instructions when chunks change or we need more lines
  useEffect(() => {
    const linesNeeded = visibleRange.lastLine + BUFFER_LINES;
    if (linesNeeded > instructions.length || lastDisassemblyAddressRef.current !== startAddress) {
      const bytesNeeded = calculateRequiredBytes(linesNeeded);
      const newInstructions = disassembleFromStart(bytesNeeded);

      setInstructions(newInstructions);
      lastDisassemblyAddressRef.current = startAddress;
    }
  }, [
    visibleRange,
    memoryChunks,
    startAddress,
    instructions.length,
    disassembleFromStart,
    calculateRequiredBytes,
  ]);

  // Calculate visible range on scroll and request missing chunks
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      const scrollTop = containerRef.current.scrollTop;
      const scrollBottom = scrollTop + containerRef.current.clientHeight;
      const firstLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT));
      const lastLine = Math.ceil(scrollBottom / LINE_HEIGHT) + BUFFER_LINES;

      setVisibleRange({ firstLine, lastLine });

      // Calculate which chunks we need based on instruction addresses
      // We need to be conservative and request extra chunks since we don't
      // know exactly where instructions end
      const bytesNeeded = calculateRequiredBytes(lastLine);
      const endByte = Math.min(startAddress + bytesNeeded, endAddress);

      const firstChunk = Math.floor(startAddress / CHUNK_SIZE) * CHUNK_SIZE;
      const lastChunk = Math.floor(endByte / CHUNK_SIZE) * CHUNK_SIZE;

      for (let c = firstChunk; c <= lastChunk; c += CHUNK_SIZE) {
        if (!memoryChunks.has(c) && !requestedChunksRef.current.has(c)) {
          requestedChunksRef.current.add(c);
          onRequestMemory({ address: c, size: CHUNK_SIZE });
        }
      }
    };

    handleScroll();

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
    startAddress,
    endAddress,
    memoryChunks,
    onRequestMemory,
    calculateRequiredBytes,
  ]);

  // Render canvas when content changes
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Calculate total height based on instruction count
  // Add extra space for instructions we haven't disassembled yet
  const estimatedTotalInstructions = Math.max(
    instructions.length,
    Math.ceil((endAddress - startAddress) / 2.5)
  );
  const totalHeight = estimatedTotalInstructions * LINE_HEIGHT;

  return (
    <div className="disassemblyView">
      <div className="disassembly-scroll-container" ref={containerRef}>
        <div
          style={{
            height: `${totalHeight}px`,
            position: "relative",
          }}
        >
          <canvas
            ref={canvasRef}
            className="disassembly-canvas"
            style={{
              top: `${visibleRange.firstLine * LINE_HEIGHT}px`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
