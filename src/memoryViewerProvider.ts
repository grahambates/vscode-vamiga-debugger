import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { formatHex } from "./numbers";
import { EvaluateResultType } from "./evaluateManager";

interface MemoryViewerState {
  panel: vscode.WebviewPanel;
  addressInput: string;
  currentAddress: number;
  byteLength: number;
  liveUpdate: boolean;
  liveUpdateInterval?: NodeJS.Timeout;
}

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
            // Refresh on pause
            if (message.state === "paused") {
              this.updateContent(state);
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
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const state: MemoryViewerState = {
      panel,
      addressInput: "",
      currentAddress: 0,
      byteLength: 0,
      liveUpdate: false,
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
          await this.updateContent(state);
          break;
        case "changeAddress":
          try {
            await this.changeAddress(state, message.addressInput);
            await this.updateContent(state);
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to update address: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
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

    // Set initial address
    try {
      await this.changeAddress(state, addressInput);
      await this.updateContent(state);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open memory viewer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async changeAddress(state: MemoryViewerState, addressInput: string) {
    state.addressInput = addressInput;
    const adapter = VamigaDebugAdapter.getActiveAdapter();
    if (!adapter) {
      throw new Error("Debugger is not running");
    }
    const evaluateManager = adapter.getEvaluateManager();
    const { value, memoryReference, type } =
      await evaluateManager.evaluate(addressInput);
    const address = memoryReference ? Number(memoryReference) : value;
    if (typeof address !== "number") {
      throw new Error("Does not evaluate to a numeric value");
    }
    if (!this.vAmiga.isValidAddress(address)) {
      throw new Error(`Not a valid address: ${formatHex(address)}`);
    }
    state.currentAddress = address;

    // Update panel title to show the address/symbol
    state.panel.title = `Memory: ${addressInput}`;

    const bytesPerLine = 16;
    const numLines = 32;
    const defaultBytes = bytesPerLine * numLines;

    if (type === EvaluateResultType.SYMBOL) {
      state.byteLength =
        adapter.getSourceMap().getSymbolLengths()?.[addressInput] ??
        defaultBytes;
    } else {
      state.byteLength = defaultBytes;
    }
  }

  private async updateContent(state: MemoryViewerState): Promise<void> {
    try {
      const result = await this.vAmiga.readMemory(
        state.currentAddress,
        state.byteLength,
      );
      const memoryData = new Uint8Array(result);

      state.panel.webview.postMessage({
        command: "updateContent",
        memoryData,
        addressInput: state.addressInput,
        currentAddress: state.currentAddress,
        liveUpdate: state.liveUpdate,
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error reading memory at ${state.currentAddress}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Starts live updates at ~60fps when emulator is running
   */
  private startLiveUpdate(state: MemoryViewerState): void {
    if (state.liveUpdateInterval) {
      return; // Already running
    }

    // Update at ~60fps (every ~16ms)
    state.liveUpdateInterval = setInterval(() => {
      if (state.liveUpdate && this.isEmulatorRunning) {
        this.updateContent(state);
      }
    }, 16);
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
