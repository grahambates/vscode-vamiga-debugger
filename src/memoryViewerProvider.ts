import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { formatHex } from "./numbers";
import { EvaluateResultType } from "./evaluateManager";

/**
 * Provides a webview for viewing emulator memory in different formats
 */
export class MemoryViewerProvider {
  public static readonly viewType = "vamiga-debugger.memoryViewer";

  private panel?: vscode.WebviewPanel;
  private addressInput = "";
  private currentAddress = 0;
  private byteLength = 0;
  private liveUpdate = false;
  private liveUpdateInterval?: NodeJS.Timeout;
  private emulatorMessageListener?: vscode.Disposable;
  private isEmulatorRunning = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly vAmiga: VAmiga,
  ) {
    // Listen for emulator state changes to auto-refresh
    // This now works even before the VAmiga panel is opened
    this.emulatorMessageListener = this.vAmiga.onDidReceiveMessage(
      (message) => {
        if (!this.panel) {
          return;
        }
        if (isEmulatorStateMessage(message)) {
          const wasRunning = this.isEmulatorRunning;
          this.isEmulatorRunning = message.state === "running";
          // Refresh on pause
          if (message.state === "paused") {
            this.updateContent();
          }
          // Handle live update mode
          if (this.liveUpdate) {
            if (this.isEmulatorRunning && !wasRunning) {
              // Just started running - start live updates
              this.startLiveUpdate();
            } else if (!this.isEmulatorRunning && wasRunning) {
              // Just stopped - stop live updates
              this.stopLiveUpdate();
            }
          }
        }
      },
    );
  }

  /**
   * Opens the memory viewer at a specific address
   * @param addressInput Memory address input
   */
  public async show(addressInput: string): Promise<void> {
    await this.changeAddress(addressInput);
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      await this.updateContent();
    } else {
      await this.createPanel();
    }
  }

  /**
   * Disposes the memory viewer panel
   */
  public dispose(): void {
    this.stopLiveUpdate();
    this.emulatorMessageListener?.dispose();
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async createPanel(): Promise<void> {
    this.panel = vscode.window.createWebviewPanel(
      MemoryViewerProvider.viewType,
      "Memory Viewer",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.panel.webview.html = this.getHtmlContent();

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "ready":
          // Send initial state when webview is ready
          await this.updateContent();
          break;
        case "changeAddress":
          try {
            await this.changeAddress(message.addressInput);
            await this.updateContent();
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to update address: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          break;
        case "toggleLiveUpdate":
          this.liveUpdate = message.enabled;
          if (this.liveUpdate && this.isEmulatorRunning) {
            this.startLiveUpdate();
          } else {
            this.stopLiveUpdate();
          }
          break;
      }
    });
  }

  private async changeAddress(addressInput: string) {
    this.addressInput = addressInput;
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
    this.currentAddress = address;

    const bytesPerLine = 16;
    const numLines = 32;
    const defaultBytes = bytesPerLine * numLines;

    if (type === EvaluateResultType.SYMBOL) {
      this.byteLength =
        adapter.getSourceMap().getSymbolLengths()?.[addressInput] ??
        defaultBytes;
    } else {
      this.byteLength = defaultBytes;
    }
  }

  private async updateContent(): Promise<void> {
    try {
      const result = await this.vAmiga.readMemory(
        this.currentAddress,
        this.byteLength,
      );
      const memoryData = new Uint8Array(result);

      this.panel?.webview.postMessage({
        command: "updateContent",
        memoryData,
        addressInput: this.addressInput,
        currentAddress: this.currentAddress,
        liveUpdate: this.liveUpdate,
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error reading memory at ${this.currentAddress}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Starts live updates at ~60fps when emulator is running
   */
  private startLiveUpdate(): void {
    if (this.liveUpdateInterval) {
      return; // Already running
    }

    // Update at ~60fps (every ~16ms)
    this.liveUpdateInterval = setInterval(() => {
      if (this.panel && this.liveUpdate && this.isEmulatorRunning) {
        this.updateContent();
      }
    }, 16);
  }

  /**
   * Stops live updates
   */
  private stopLiveUpdate(): void {
    if (this.liveUpdateInterval) {
      clearInterval(this.liveUpdateInterval);
      this.liveUpdateInterval = undefined;
    }
  }

  private getHtmlContent(): string {
    if (!this.panel) {
      throw new Error("Panel not initialized");
    }

    const webview = this.panel.webview;

    // Get URIs for bundled resources
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "src",
        "webview",
        "memoryViewer",
        "styles.css",
      ),
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
