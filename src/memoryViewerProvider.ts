import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage, MemSrc } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { formatHex } from "./numbers";
import { EvaluateResultType } from "./evaluateManager";

interface MemoryViewerState {
  panel: vscode.WebviewPanel;
  addressInput: string;
  baseAddress?: number;
  liveUpdate: boolean;
  dereferencePointer: boolean;
  liveUpdateInterval?: NodeJS.Timeout;
  memoryCache: Map<number, Uint8Array>; // offset -> chunk
}

const LIVE_UPDATE_RATE_MS = 1000 / 25;
const CHUNK_SIZE = 1024;

/**
 * Provides a webview for viewing emulator memory in different formats.
 * Supports multiple instances for viewing different memory regions simultaneously.
 */
export class MemoryViewerProvider {
  public static readonly viewType = "vamiga-debugger.memoryViewer";

  private panels = new Map<string, MemoryViewerState>();
  private emulatorMessageListener?: vscode.Disposable;
  private isEmulatorRunning = false;
  private panelCounter = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly vAmiga: VAmiga,
  ) {
    // Listen for emulator state changes to auto-refresh all panels
    this.emulatorMessageListener = this.vAmiga.onDidReceiveMessage(
      (message) => {
        if (!isEmulatorStateMessage(message)) {
          return;
        }
        const wasRunning = this.isEmulatorRunning;
        this.isEmulatorRunning = message.state === "running";

        // Update all panels
        for (const state of this.panels.values()) {
          // Refresh on pause or stopped (e.g., stepping, breakpoint)
          if (message.state === "paused" || message.state === "stopped") {
            this.updateState(state);
          }
          // Handle live update mode
          if (state.liveUpdate) {
            if (this.isEmulatorRunning && !wasRunning) {
              this.startLiveUpdate(state);
            } else if (!this.isEmulatorRunning && wasRunning) {
              this.stopLiveUpdate(state);
            }
          }
        }
      },
    );
  }

  /**
   * Disposes all memory viewer panels
   */
  public dispose(): void {
    for (const state of this.panels.values()) {
      this.stopLiveUpdate(state);
      state.panel.dispose();
    }
    this.panels.clear();
    this.emulatorMessageListener?.dispose();
  }

  /**
   * Opens a new memory viewer at a specific address
   * @param addressInput Memory address input
   */
  public async show(addressInput: string): Promise<void> {
    const panelId = `memory-viewer-${this.panelCounter++}`;

    const panel = vscode.window.createWebviewPanel(
      MemoryViewerProvider.viewType,
      "Memory Viewer",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const state: MemoryViewerState = {
      panel,
      addressInput,
      baseAddress: 0,
      liveUpdate: true,
      dereferencePointer: false,
      memoryCache: new Map(),
    };

    this.panels.set(panelId, state);

    panel.webview.html = this.getHtmlContent(panel.webview);

    panel.onDidDispose(() => {
      this.stopLiveUpdate(state);
      this.panels.delete(panelId);
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "ready":
          // Send initial state when webview is ready
          await this.updateState(state);
          // Only send input text once, to avoid clobbering user input during live update
          state.panel.webview.postMessage({
            command: "updateState",
            addressInput,
          });
          if (this.isEmulatorRunning) {
            this.startLiveUpdate(state);
          }
          break;
        case "changeAddress": {
          const previousAddress = state.baseAddress;
          state.addressInput = message.addressInput;
          state.dereferencePointer = message.dereferencePointer ?? false;

          // Skip if address is empty
          if (!state.addressInput || state.addressInput.trim() === "") {
            break;
          }

          await this.updateState(state);
          // Only clear cache if address actually changed
          if (state.baseAddress !== previousAddress) {
            state.memoryCache.clear();
          }
          break;
        }
        case "requestMemory":
          await this.fetchMemoryChunk(state, message.offset, message.count);
          break;
        case "toggleLiveUpdate":
          state.liveUpdate = message.enabled;
          state.dereferencePointer = message.dereferencePointer ?? false;
          if (state.liveUpdate && this.isEmulatorRunning) {
            this.startLiveUpdate(state);
          } else {
            this.stopLiveUpdate(state);
          }
          break;
        case "getSymbolSuggestions": {
          const adapter = VamigaDebugAdapter.getActiveAdapter();
          if (adapter) {
            const suggestions = this.getSymbolSuggestions(
              adapter,
              message.query || "",
            );
            state.panel.webview.postMessage({
              command: "symbolSuggestions",
              suggestions,
            });
          }
          break;
        }
      }
    });
  }

  /**
   * Sends state update to webview
   */
  private sendStateToWebview(
    panel: vscode.WebviewPanel,
    params: {
      baseAddress?: number;
      memoryRange?: { start: number; end: number };
      currentRegion?: string;
      currentRegionStart?: number | undefined;
      availableRegions?: Array<{ name: string; address: number; size: number }>;
      liveUpdate?: boolean;
      preserveOffset?: number;
    },
  ): void {
    panel.webview.postMessage({
      command: "updateState",
      ...params,
      error: null,
    });
  }

  /**
   * Sends error message to webview
   */
  private sendErrorToWebview(panel: vscode.WebviewPanel, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    panel.webview.postMessage({
      command: "updateState",
      error: errorMessage,
    });
  }

  /**
   * Calculates memory range and region information for a given base address
   * @returns Memory range, region name, and region start address
   */
  private calculateMemoryRange(
    baseAddress: number,
    adapter: VamigaDebugAdapter,
  ): {
    memoryRange: { start: number; end: number };
    currentRegion: string;
    currentRegionStart: number | undefined;
  } {
    // Prefer segment bounds, fall back to memory regions
    const segment = adapter.getSourceMap().findSegmentForAddress(baseAddress);
    if (segment) {
      return {
        memoryRange: {
          start: segment.address - baseAddress,
          end: segment.address + segment.size - 1 - baseAddress,
        },
        currentRegion: segment.name,
        currentRegionStart: segment.address,
      };
    }

    // Fall back to memory region
    const memoryRegion = this.vAmiga.getMemoryRegion(baseAddress);
    if (memoryRegion) {
      const bank = baseAddress >>> 16;
      const memInfo = this.vAmiga.getCachedMemoryInfo();
      const type = memInfo?.cpuMemSrc?.[bank];
      return {
        memoryRange: {
          start: memoryRegion.start - baseAddress,
          end: memoryRegion.end - baseAddress,
        },
        currentRegion:
          type !== undefined ? this.getMemoryTypeName(type) : "Memory",
        currentRegionStart: memoryRegion.start,
      };
    }

    // Unknown region
    return {
      memoryRange: { start: -1024 * 1024, end: 1024 * 1024 },
      currentRegion: "Unknown",
      currentRegionStart: undefined,
    };
  }

  /**
   * Evaluates the address expression and optionally dereferences it as a 32-bit pointer
   * @returns The final base address to view
   * @throws Error if address is invalid or dereferencing fails
   */
  private async evaluateAndDereferenceAddress(
    state: MemoryViewerState,
    adapter: VamigaDebugAdapter,
  ): Promise<number | undefined> {
    // Evaluate input expression (can change each update, e.g., register values)
    const evaluateManager = adapter.getEvaluateManager();
    const { value, memoryReference, type } = await evaluateManager.evaluate(
      state.addressInput,
    );
    if (type === EvaluateResultType.EMPTY) {
      return;
    }
    let baseAddress = memoryReference ? Number(memoryReference) : value;

    if (typeof baseAddress !== "number") {
      throw new Error("Does not evaluate to a numeric value");
    }
    if (!this.vAmiga.isValidAddress(baseAddress)) {
      throw new Error(`Not a valid address: ${formatHex(baseAddress)}`);
    }

    // If dereferencePointer is enabled, read 32-bit value at this address
    if (state.dereferencePointer) {
      const pointerBytes = await this.vAmiga.readMemory(baseAddress, 4);
      if (pointerBytes.byteLength >= 4) {
        // Big-endian 32-bit read
        const view = new DataView(
          pointerBytes.buffer,
          pointerBytes.byteOffset,
          pointerBytes.byteLength,
        );
        const targetAddress = view.getUint32(0, false);
        if (!this.vAmiga.isValidAddress(targetAddress)) {
          throw new Error(
            `Pointer at ${formatHex(baseAddress)} points to invalid address: ${formatHex(targetAddress)}`,
          );
        }
        baseAddress = targetAddress;
      } else {
        throw new Error(`Failed to read pointer at ${formatHex(baseAddress)}`);
      }
    }

    return baseAddress;
  }

  /**
   * Updates the memory viewer state
   * @param preserveOffset Optional scroll offset to preserve when base address changes
   */
  private async updateState(
    state: MemoryViewerState,
    preserveOffset?: number,
  ): Promise<void> {
    try {
      const adapter = VamigaDebugAdapter.getActiveAdapter();
      if (!adapter) {
        throw new Error("Debugger is not running");
      }

      // Initial state
      state.panel.title = "Memory Viewer";
      const initialState = {
        availableRegions: this.getAvailableRegions(adapter),
        liveUpdate: state.liveUpdate,
        preserveOffset,
      };

      // Evaluate and dereference address (unless preserveOffset is set, meaning address already evaluated)
      if (preserveOffset === undefined) {
        state.baseAddress = await this.evaluateAndDereferenceAddress(
          state,
          adapter,
        );
      }
      if (state.baseAddress === undefined) {
        // Send intial state without address
        return this.sendStateToWebview(state.panel, initialState);
      }

      // Send state with address and range
      state.panel.title = `Memory: ${state.addressInput}`;
      this.sendStateToWebview(state.panel, {
        baseAddress: state.baseAddress,
        ...this.calculateMemoryRange(state.baseAddress, adapter),
        ...initialState,
      });
    } catch (err) {
      this.sendErrorToWebview(state.panel, err);
    }
  }

  private async fetchMemoryChunk(
    state: MemoryViewerState,
    offset: number,
    count: number,
  ): Promise<void> {
    try {
      // Check cache first
      if (state.memoryCache.has(offset)) {
        return; // Already have this chunk
      }
      if (!state.baseAddress) {
        return;
      }

      const address = state.baseAddress + offset;
      const result = await this.vAmiga.readMemory(address, count);

      // Cache the chunk
      state.memoryCache.set(offset, new Uint8Array(result));

      // Send to webview
      state.panel.webview.postMessage({
        command: "memoryData",
        offset,
        data: Array.from(new Uint8Array(result)), // Convert to array for JSON serialization
        baseAddress: state.baseAddress,
      });
    } catch (err) {
      // Silently ignore errors for now - chunk just won't be available
      console.error(`Failed to fetch memory chunk at offset ${offset}:`, err);
    }
  }

  /**
   * Starts live updates at ~25fps when emulator is running
   */
  private startLiveUpdate(state: MemoryViewerState): void {
    if (state.liveUpdateInterval) {
      return; // Already running
    }

    state.liveUpdateInterval = setInterval(async () => {
      if (state.liveUpdate && this.isEmulatorRunning) {
        if (!state.baseAddress) {
          return;
        }
        // Check if address expression result has changed (e.g., register value, pointer)
        const previousBaseAddress = state.baseAddress;
        try {
          const adapter = VamigaDebugAdapter.getActiveAdapter();
          if (adapter) {
            const newBaseAddress = await this.evaluateAndDereferenceAddress(
              state,
              adapter,
            );

            if (
              newBaseAddress !== undefined &&
              newBaseAddress !== previousBaseAddress
            ) {
              // Base address changed - update state and preserve scroll offset
              const offsetDelta = newBaseAddress - previousBaseAddress;
              state.baseAddress = newBaseAddress;
              state.memoryCache.clear();

              // Send update with offset preservation hint
              await this.updateState(state, offsetDelta);
              return; // Skip chunk refresh this cycle, chunks will be re-requested
            }
          }
        } catch (err) {
          // Address evaluation failed - stop live updates and show error
          this.stopLiveUpdate(state);
          this.sendErrorToWebview(state.panel, err);
          return;
        }

        // For live updates, re-fetch all cached chunks without clearing
        const cachedOffsets = Array.from(state.memoryCache.keys());
        for (const offset of cachedOffsets) {
          try {
            const address = state.baseAddress + offset;
            const result = await this.vAmiga.readMemory(address, CHUNK_SIZE);

            // Update cache
            state.memoryCache.set(offset, new Uint8Array(result));

            // Send updated chunk to webview
            state.panel.webview.postMessage({
              command: "memoryData",
              offset,
              data: Array.from(new Uint8Array(result)),
              baseAddress: state.baseAddress,
            });
          } catch {
            // Ignore errors during live update
          }
        }
      }
    }, LIVE_UPDATE_RATE_MS);
  }

  /**
   * Stops live updates
   */
  private stopLiveUpdate(state: MemoryViewerState): void {
    if (state.liveUpdateInterval) {
      clearInterval(state.liveUpdateInterval);
      state.liveUpdateInterval = undefined;
    }
  }

  private getMemoryTypeName(type: MemSrc): string {
    switch (type) {
      case MemSrc.NONE:
        return "None";
      case MemSrc.CHIP:
        return "Chip RAM";
      case MemSrc.CHIP_MIRROR:
        return "Chip RAM (mirror)";
      case MemSrc.SLOW:
        return "Slow RAM";
      case MemSrc.SLOW_MIRROR:
        return "Slow RAM (mirror)";
      case MemSrc.FAST:
        return "Fast RAM";
      case MemSrc.CIA:
        return "CIA Registers";
      case MemSrc.CIA_MIRROR:
        return "CIA Registers (mirror)";
      case MemSrc.RTC:
        return "RTC";
      case MemSrc.CUSTOM:
        return "Custom Registers";
      case MemSrc.CUSTOM_MIRROR:
        return "Custom Registers (mirror)";
      case MemSrc.AUTOCONF:
        return "Autoconf";
      case MemSrc.ZOR:
        return "ZOR";
      case MemSrc.ROM:
        return "ROM";
      case MemSrc.ROM_MIRROR:
        return "ROM (mirror)";
      case MemSrc.WOM:
        return "WOM";
      case MemSrc.EXT:
        return "EXT";
    }
  }

  /**
   * Gets symbol name suggestions based on query string
   */
  private getSymbolSuggestions(
    adapter: VamigaDebugAdapter,
    query: string,
  ): Array<{ label: string; address: string; description?: string }> {
    const suggestions: Array<{
      label: string;
      address: string;
      description?: string;
    }> = [];
    const queryLower = query.toLowerCase();

    // Get symbols from source map
    const sourceMap = adapter.getSourceMap();
    const symbols = sourceMap.getSymbols();

    for (const symbolName in symbols) {
      const symbolAddress = symbols[symbolName];

      // Filter by query if provided
      if (
        !query ||
        symbolName.toLowerCase().includes(queryLower) ||
        symbolName.toLowerCase().startsWith(queryLower)
      ) {
        // Find which segment this symbol belongs to
        const segment = sourceMap.findSegmentForAddress(symbolAddress);

        suggestions.push({
          label: symbolName,
          address: formatHex(symbolAddress),
          description: segment?.name,
        });

        // Limit to 50 suggestions
        if (suggestions.length >= 50) break;
      }
    }

    // Sort by name
    suggestions.sort((a, b) => a.label.localeCompare(b.label));

    return suggestions;
  }

  private getAvailableRegions(
    adapter: VamigaDebugAdapter,
  ): Array<{ name: string; address: number; size: number }> {
    const regions: Array<{ name: string; address: number; size: number }> = [];

    // Add segments from source map
    const segments = adapter.getSourceMap().getSegmentsInfo();
    for (const seg of segments) {
      regions.push({
        name: seg.name,
        address: seg.address,
        size: seg.size,
      });
    }

    // Add memory regions
    const memInfo = this.vAmiga.getCachedMemoryInfo();
    if (memInfo) {
      let currentType: MemSrc | null = null;
      let currentStart = 0;

      for (let bank = 0; bank <= 255; bank++) {
        const type: MemSrc = memInfo.cpuMemSrc[bank];

        if (type !== MemSrc.NONE && type !== currentType) {
          // Save previous region
          if (currentType !== null) {
            regions.push({
              name: this.getMemoryTypeName(currentType),
              address: currentStart,
              size: (bank << 16) - currentStart,
            });
          }
          currentType = type;
          currentStart = bank << 16;
        } else if (type === MemSrc.NONE && currentType !== null) {
          // End of region
          regions.push({
            name: this.getMemoryTypeName(currentType),
            address: currentStart,
            size: (bank << 16) - currentStart,
          });
          currentType = null;
        }
      }

      // Handle last region
      if (currentType !== null) {
        regions.push({
          name: this.getMemoryTypeName(currentType),
          address: currentStart,
          size: (256 << 16) - currentStart,
        });
      }
    }

    return regions;
  }

  private getHtmlContent(webview: vscode.Webview): string {
    // Get URIs for bundled resources
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "main.css"),
    );
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};">
  <title>Memory Viewer</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
