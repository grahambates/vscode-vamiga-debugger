import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { formatHex } from "./numbers";

interface MemoryViewerState {
  panel: vscode.WebviewPanel;
  addressInput: string;
  baseAddress: number;
  liveUpdate: boolean;
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
        if (isEmulatorStateMessage(message)) {
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
        }
      },
    );
  }

  /**
   * Opens a new memory viewer at a specific address
   * @param addressInput Memory address input
   */
  public async show(addressInput: string): Promise<void> {
    await this.createPanel(addressInput);
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

  private async createPanel(addressInput: string): Promise<void> {
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
          if (state.liveUpdate && this.isEmulatorRunning) {
            this.startLiveUpdate(state);
          } else {
            this.stopLiveUpdate(state);
          }
          break;
      }
    });
  }

  private async updateState(state: MemoryViewerState): Promise<void> {
    try {
      const adapter = VamigaDebugAdapter.getActiveAdapter();
      if (!adapter) {
        throw new Error("Debugger is not running");
      }

      // Evaluate input expression on each update, as result can change e.g. pointers
      const evaluateManager = adapter.getEvaluateManager();
      const { value, memoryReference } = await evaluateManager.evaluate(
        state.addressInput,
      );
      const baseAddress = memoryReference ? Number(memoryReference) : value;
      if (typeof baseAddress !== "number") {
        throw new Error("Does not evaluate to a numeric value");
      }
      if (!this.vAmiga.isValidAddress(baseAddress)) {
        throw new Error(`Not a valid address: ${formatHex(baseAddress)}`);
      }

      // Update panel title to show the address/symbol
      state.panel.title = `Memory: ${state.addressInput}`;
      state.baseAddress = baseAddress;

      // Get memory range - prefer segment bounds, fall back to memory region
      let memoryRange: { start: number; end: number };

      const segment = adapter.getSourceMap().findSegmentForAddress(baseAddress);
      if (segment) {
        // Use segment boundaries
        memoryRange = {
          start: segment.address - baseAddress,
          end: segment.address + segment.size - 1 - baseAddress,
        };
      } else {
        // Fall back to memory region
        const memoryRegion = this.vAmiga.getMemoryRegion(baseAddress);
        memoryRange = memoryRegion
          ? {
              start: memoryRegion.start - baseAddress,
              end: memoryRegion.end - baseAddress,
            }
          : { start: -1024 * 1024, end: 1024 * 1024 }; // Default to 1MB each way
      }

      state.panel.webview.postMessage({
        command: "updateState",
        baseAddress,
        memoryRange,
        liveUpdate: state.liveUpdate,
        error: null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      state.panel.webview.postMessage({
        command: "updateState",
        error,
      });
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
