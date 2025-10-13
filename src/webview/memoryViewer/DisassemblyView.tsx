import { useState, useRef, useEffect, useCallback } from "react";
import {
  disassembleBytes,
  CPUInstruction,
  concatBytes,
} from "./cpuDisassembler";
import "./DisassemblyView.css";
import { MemoryRange } from "../../shared/memoryViewerTypes";

export interface DisassemblyViewProps {
  target: MemoryRange;
  range: MemoryRange;
  symbols: Record<string, number>;
  memoryChunks: Map<number, Uint8Array>;
  onRequestMemory: (range: MemoryRange) => void;
  scrollResetTrigger?: number;
}

const CHUNK_SIZE = 1024;
const LINE_HEIGHT = 20;
const LOAD_MORE_THRESHOLD = 100; // Load more when within this many lines of bottom
const INSTRUCTIONS_PER_LOAD = 200; // Load this many instructions at a time
const RENDER_BUFFER_LINES = 50; // Render this many extra lines above and below visible area

/**
 * DisassemblyView component for M68k CPU instructions
 *
 * Uses infinite scroll pattern:
 * - Start with a reasonable number of instructions
 * - Grow the content area as user scrolls down
 * - Stop when reaching the end of the memory region
 * - No need to know total height upfront
 */
export function DisassemblyView({
  target,
  range,
  symbols,
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

  // Start disassembly at target address (must be even-aligned)
  const startAddress = target.address & ~1;
  const endAddress = range.address + range.size;

  // Track the current start address to detect changes
  const [currentStartAddress, setCurrentStartAddress] = useState(startAddress);

  // Accumulate instructions as we disassemble
  const [instructions, setInstructions] = useState<CPUInstruction[]>([]);

  // Track the next address to disassemble from (use ref to avoid stale closures)
  const nextAddressRef = useRef<number>(startAddress);

  // Track if we've reached the end of the region
  const [reachedEnd, setReachedEnd] = useState(false);

  // Track if we're currently loading more instructions
  const isLoadingRef = useRef(false);

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

  // Load more instructions from the nextAddress
  const loadMoreInstructions = useCallback(() => {
    if (isLoadingRef.current || reachedEnd) {
      return;
    }

    const fromAddress = nextAddressRef.current;

    // Can't go beyond the end address
    if (fromAddress >= endAddress) {
      setReachedEnd(true);
      return;
    }

    isLoadingRef.current = true;

    // Calculate how many bytes we need (worst case scenario)
    const bytesNeeded = Math.min(
      INSTRUCTIONS_PER_LOAD * 10, // Worst case: all 10-byte instructions
      endAddress - fromAddress
    );

    // Request all chunks we might need
    const firstChunk = Math.floor(fromAddress / CHUNK_SIZE) * CHUNK_SIZE;
    const lastChunk = Math.floor((fromAddress + bytesNeeded) / CHUNK_SIZE) * CHUNK_SIZE;

    let needsChunks = false;
    for (let c = firstChunk; c <= lastChunk; c += CHUNK_SIZE) {
      if (!memoryChunks.has(c)) {
        needsChunks = true;
        if (!requestedChunksRef.current.has(c)) {
          requestedChunksRef.current.add(c);
          onRequestMemory({ address: c, size: CHUNK_SIZE });
        }
      }
    }

    // If we need chunks, wait for them to arrive
    if (needsChunks) {
      isLoadingRef.current = false;
      return;
    }

    // Try to disassemble with increasing byte counts until we get enough instructions
    let bytesToTry = Math.ceil(INSTRUCTIONS_PER_LOAD * 3); // Start with average case
    const maxBytesToTry = Math.min(bytesNeeded, endAddress - fromAddress);

    for (let attempt = 0; attempt < 5; attempt++) {
      bytesToTry = Math.min(bytesToTry, maxBytesToTry);

      const bytes = getContiguousBytes(fromAddress, bytesToTry);
      if (!bytes || bytes.length === 0) {
        break;
      }

      const result = disassembleBytes(fromAddress, bytes);
      const newInstructions = result.instructions;

      // If we got enough instructions or can't get more data, use what we have
      if (
        newInstructions.length >= INSTRUCTIONS_PER_LOAD ||
        bytes.length < bytesToTry ||
        bytesToTry >= maxBytesToTry
      ) {
        if (newInstructions.length > 0) {
          setInstructions(prev => [...prev, ...newInstructions]);

          // Update next address
          const lastInstr = newInstructions[newInstructions.length - 1];
          const newNextAddress = lastInstr.address + lastInstr.bytes.length;
          nextAddressRef.current = newNextAddress;

          // Check if we've reached the end
          if (newNextAddress >= endAddress) {
            setReachedEnd(true);
          }
        } else {
          // No instructions decoded - reached end
          setReachedEnd(true);
        }
        break;
      }

      // Need more bytes
      bytesToTry = Math.ceil(bytesToTry * 1.5);
    }

    isLoadingRef.current = false;
  }, [
    reachedEnd,
    endAddress,
    getContiguousBytes,
    memoryChunks,
    onRequestMemory,
  ]);

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

    // Render visible instructions
    for (let i = visibleRange.firstLine; i < visibleRange.lastLine; i++) {
      const y = (i - visibleRange.firstLine) * LINE_HEIGHT;

      if (i >= instructions.length) {
        // No instruction available yet - show loading indicator
        if (!reachedEnd) {
          ctx.fillStyle = commentColor;
          ctx.fillText("Loading...", 10, y + 2);
        }
        continue;
      }

      const instr = instructions[i];
      let x = 10;

      // Address
      ctx.fillStyle = commentColor;
      const addrStr = instr.address.toString(16).toUpperCase().padStart(6, "0");
      ctx.fillText(addrStr + ":", x, y + 2);
      x += 80;

      // Raw bytes (with ellipsis if truncated)
      const maxBytesToShow = 8;
      ctx.fillStyle = commentColor;
      const bytesStr = Array.from(instr.bytes)
        .slice(0, maxBytesToShow)
        .map(b => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");
      const bytesDisplay = instr.bytes.length > maxBytesToShow ? bytesStr + "..." : bytesStr;
      ctx.fillText(bytesDisplay.padEnd(17), x, y + 2);
      x += 220;

      // Mnemonic
      ctx.fillStyle = keywordColor;
      ctx.fillText(instr.mnemonic.padEnd(8), x, y + 2);
      x += 80;

      // Operands
      ctx.fillStyle = numberColor;
      ctx.fillText(instr.operands, x, y + 2);
      x += 200;

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
  }, [visibleRange, instructions, symbols, reachedEnd]);

  // Reset state when target address changes
  if (currentStartAddress !== startAddress) {
    // Reset state when startAddress prop changes (during render)
    setCurrentStartAddress(startAddress);
    setInstructions([]);
    setReachedEnd(false);
  }

  // Sync refs when startAddress changes (in effect)
  useEffect(() => {
    if (currentStartAddress === startAddress) {
      requestedChunksRef.current.clear();
      nextAddressRef.current = startAddress;
      isLoadingRef.current = false;
    }
  }, [currentStartAddress, startAddress]);

  // Scroll to target
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [target.address, scrollResetTrigger]);

  // Load initial instructions and more when chunks arrive
  useEffect(() => {
    // Try to load if we don't have enough instructions
    const shouldLoad =
      !isLoadingRef.current &&
      !reachedEnd &&
      instructions.length < INSTRUCTIONS_PER_LOAD;

    if (shouldLoad) {
      // Use queueMicrotask to schedule for next tick to avoid cascading renders
      queueMicrotask(() => {
        loadMoreInstructions();
      });
    }
  }, [memoryChunks, instructions.length, reachedEnd, loadMoreInstructions]);

  // Handle scroll and load more when near bottom
  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;

      const scrollTop = containerRef.current.scrollTop;
      const scrollBottom = scrollTop + containerRef.current.clientHeight;

      // Calculate visible lines
      const visibleFirstLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT));
      const visibleLastLine = Math.ceil(scrollBottom / LINE_HEIGHT);

      // Add buffer for smooth scrolling
      const firstLine = Math.max(0, visibleFirstLine - RENDER_BUFFER_LINES);
      const lastLine = Math.min(instructions.length, visibleLastLine + RENDER_BUFFER_LINES);

      setVisibleRange({ firstLine, lastLine });

      // Load more if we're near the bottom
      const distanceFromBottom = instructions.length - lastLine;
      if (distanceFromBottom < LOAD_MORE_THRESHOLD && !isLoadingRef.current && !reachedEnd) {
        loadMoreInstructions();
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
  }, [instructions.length, reachedEnd, loadMoreInstructions]);

  // Render canvas when content changes
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Total height grows with instruction count
  const totalHeight = instructions.length * LINE_HEIGHT + (reachedEnd ? 0 : LINE_HEIGHT * 10);

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
