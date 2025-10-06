import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { formatHex } from "./numbers";
import { EvaluateResultType } from "./evaluateManager";

interface MemoryViewerState {
  panel: vscode.WebviewPanel;
  addressInput: string;
  byteLength: number;
  liveUpdate: boolean;
  liveUpdateInterval?: NodeJS.Timeout;
}

const LIVE_UPDATE_RATE_MS = 1000 / 25;

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
      byteLength: 0,
      liveUpdate: true,
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
        case "changeAddress":
          state.addressInput = message.addressInput;
          await this.updateState(state);
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
      const { value, memoryReference, type } = await evaluateManager.evaluate(
        state.addressInput,
      );
      const currentAddress = memoryReference ? Number(memoryReference) : value;
      if (typeof currentAddress !== "number") {
        throw new Error("Does not evaluate to a numeric value");
      }
      if (!this.vAmiga.isValidAddress(currentAddress)) {
        throw new Error(`Not a valid address: ${formatHex(currentAddress)}`);
      }

      // Update panel title to show the address/symbol
      state.panel.title = `Memory: ${state.addressInput}`;

      const bytesPerLine = 16;
      const numLines = 32;
      const defaultBytes = bytesPerLine * numLines;

      // Get actual size of labeled region for symbol name
      if (type === EvaluateResultType.SYMBOL) {
        state.byteLength =
          adapter.getSourceMap().getSymbolLengths()?.[state.addressInput] ??
          defaultBytes;
      } else {
        state.byteLength = defaultBytes;
      }

      const result = await this.vAmiga.readMemory(
        currentAddress,
        state.byteLength,
      );

      state.panel.webview.postMessage({
        command: "updateState",
        memoryData: new Uint8Array(result),
        currentAddress,
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

  /**
   * Starts live updates at ~4fps when emulator is running
   */
  private startLiveUpdate(state: MemoryViewerState): void {
    if (state.liveUpdateInterval) {
      return; // Already running
    }

    state.liveUpdateInterval = setInterval(() => {
      if (state.liveUpdate && this.isEmulatorRunning) {
        this.updateState(state);
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
