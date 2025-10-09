import React, { useState, useRef, useEffect, useCallback } from "react";
import { disassembleCopperInstruction, CopperInstruction } from "./copperDisassembler";
import "./CopperView.css";

export interface CopperViewProps {
  target: { address: number; size: number };
  range: { address: number; size: number };
  symbols: Record<string, number>;
  symbolLengths: Record<string, number>;
  memoryChunks: Map<number, Uint8Array>;
  onRequestMemory: (range: { address: number; size: number }) => void;
  scrollResetTrigger?: number;
}

const CHUNK_SIZE = 1024;
const INSTRUCTION_SIZE = 4; // Copper instructions are always 4 bytes (2 words)
const LINE_HEIGHT = 20;
const BUFFER_LINES = 20;

export function CopperView({
  target,
  range,
  memoryChunks,
  onRequestMemory,
  scrollResetTrigger,
}: CopperViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visibleRange, setVisibleRange] = useState({
    firstLine: 0,
    lastLine: 0,
  });
  const requestedChunksRef = useRef<Set<number>>(new Set());

  if (!range) {
    return <div style={{ padding: "20px" }}>No memory region selected</div>;
  }

  // Start disassembly at target address (must be even-aligned)
  const startAddress = target.address & ~1; // Ensure even address
  const endAddress = range.address + range.size;
  const totalBytes = endAddress - startAddress;
  const totalInstructions = Math.floor(totalBytes / INSTRUCTION_SIZE);

  console.log('CopperView render', {
    target,
    range,
    startAddress,
    endAddress,
    totalInstructions,
    memoryChunks: memoryChunks.size,
  });

  // Helper to get word (2 bytes, big-endian) from chunks
  const getWord = useCallback(
    (address: number): number | undefined => {
      const chunkOffset = Math.floor(address / CHUNK_SIZE) * CHUNK_SIZE;
      const chunk = memoryChunks.get(chunkOffset);
      if (!chunk) return undefined;

      const byteIndex = address - chunkOffset;
      if (byteIndex < 0 || byteIndex + 1 >= chunk.length) return undefined;

      // Big-endian
      return (chunk[byteIndex] << 8) | chunk[byteIndex + 1];
    },
    [memoryChunks]
  );

  // Disassemble instruction at given line index
  const disassembleLine = useCallback(
    (lineIndex: number): CopperInstruction | null => {
      const address = startAddress + lineIndex * INSTRUCTION_SIZE;
      if (address >= endAddress) return null;

      const word1 = getWord(address);
      const word2 = getWord(address + 2);

      if (word1 === undefined || word2 === undefined) return null;

      return disassembleCopperInstruction(address, word1, word2);
    },
    [startAddress, endAddress, getWord]
  );

  // Render disassembly to canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (visibleRange.firstLine >= visibleRange.lastLine) {
      console.log("CopperView: No visible range", visibleRange);
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

    for (let i = visibleRange.firstLine; i < visibleRange.lastLine; i++) {
      const y = (i - visibleRange.firstLine) * LINE_HEIGHT;
      const instr = disassembleLine(i);

      if (!instr) {
        // Show placeholder for missing data
        ctx.fillStyle = commentColor;
        ctx.fillText("???????? ????????", 10, y + 2);
        continue;
      }

      let x = 10;

      // Address
      ctx.fillStyle = commentColor;
      const addrStr = instr.address.toString(16).toUpperCase().padStart(6, "0");
      ctx.fillText(addrStr + ":", x, y + 2);
      x += 80;

      // Raw words
      ctx.fillStyle = commentColor;
      const word1Str = instr.word1.toString(16).toUpperCase().padStart(4, "0");
      const word2Str = instr.word2.toString(16).toUpperCase().padStart(4, "0");
      ctx.fillText(word1Str + " " + word2Str, x, y + 2);
      x += 100;

      // Mnemonic
      ctx.fillStyle = keywordColor;
      ctx.fillText(instr.mnemonic, x, y + 2);
      x += 60;

      // Operands
      ctx.fillStyle = numberColor;
      ctx.fillText(instr.operands, x, y + 2);
      x += 200;

      // Comment
      if (instr.comment) {
        ctx.fillStyle = commentColor;
        ctx.fillText("; " + instr.comment, x, y + 2);
      }
    }
  }, [visibleRange, disassembleLine]);

  // Clear requested chunks on target address change
  useEffect(() => {
    requestedChunksRef.current.clear();
  }, [target.address]);

  // Scroll to target
  useEffect(() => {
    if (containerRef.current) {
      const scrollTop = 0; // Always start at top since we start at target address
      containerRef.current.scrollTop = scrollTop;
    }
  }, [target.address, scrollResetTrigger]);

  // Calculate visible range on scroll and request missing chunks
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      const scrollTop = containerRef.current.scrollTop;
      const scrollBottom = scrollTop + containerRef.current.clientHeight;
      const firstLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - BUFFER_LINES);
      const lastLine = Math.min(
        totalInstructions,
        Math.ceil(scrollBottom / LINE_HEIGHT) + BUFFER_LINES
      );
      setVisibleRange({ firstLine, lastLine });

      // Request chunks
      const firstChunk =
        Math.floor((startAddress + firstLine * INSTRUCTION_SIZE) / CHUNK_SIZE) * CHUNK_SIZE;
      const lastChunk =
        Math.floor((startAddress + lastLine * INSTRUCTION_SIZE) / CHUNK_SIZE) * CHUNK_SIZE;

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
  }, [totalInstructions, onRequestMemory, startAddress, memoryChunks]);

  // Render canvas when content changes
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  return (
    <div className="copperView">
      <div className="copper-scroll-container" ref={containerRef}>
        <div
          style={{
            height: `${totalInstructions * LINE_HEIGHT}px`,
            position: "relative",
          }}
        >
          <canvas
            ref={canvasRef}
            className="copper-canvas"
            style={{
              top: `${visibleRange.firstLine * LINE_HEIGHT}px`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
