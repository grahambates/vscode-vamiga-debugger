import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage } from "./vAmiga";

/**
 * Provides a webview for viewing emulator memory in different formats
 */
export class MemoryViewerProvider {
  public static readonly viewType = "vamiga-debugger.memoryViewer";

  private panel?: vscode.WebviewPanel;
  private currentAddress: number = 0;
  private liveUpdate: boolean = false;
  private liveUpdateInterval?: NodeJS.Timeout;
  private emulatorMessageListener?: vscode.Disposable;
  private isEmulatorRunning: boolean = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly vAmiga: VAmiga,
  ) {
    // Listen for emulator state changes to auto-refresh
    // This now works even before the VAmiga panel is opened
    this.emulatorMessageListener = this.vAmiga.onDidReceiveMessage(
      (message) => {
        if (isEmulatorStateMessage(message)) {
          const wasRunning = this.isEmulatorRunning;
          this.isEmulatorRunning = message.state === "running";

          if (this.panel) {
            // Refresh on pause
            if (message.state === "paused") {
              this.updateContent().catch((err) => {
                console.error("Failed to update memory viewer:", err);
              });
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
        }
      },
    );
  }

  /**
   * Opens the memory viewer at a specific address
   * @param address Memory address to view
   */
  public async show(address: number): Promise<void> {
    this.currentAddress = address;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      // Send address update to React
      this.panel.webview.postMessage({
        command: "updateAddress",
        address: this.currentAddress,
      });
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
          this.panel?.webview.postMessage({
            command: "init",
            address: this.currentAddress,
            liveUpdate: this.liveUpdate,
          });
          await this.updateContent();
          break;
        case "changeAddress":
          this.currentAddress = message.address;
          await this.updateContent();
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

  private async updateContent(): Promise<void> {
    try {
      const bytesPerLine = 16;
      const numLines = 32;
      const totalBytes = bytesPerLine * numLines;

      const buffer = await this.vAmiga.readMemory(
        this.currentAddress,
        totalBytes,
      );
      const memoryData = Array.from(buffer);

      this.panel?.webview.postMessage({
        command: "updateContent",
        memoryData,
      });
    } catch (e) {
      console.error(e);
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
        this.updateContent().catch((err) => {
          console.error(
            "Failed to update memory viewer during live update:",
            err,
          );
        });
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
