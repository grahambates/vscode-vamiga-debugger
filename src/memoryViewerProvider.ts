import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage } from "./vAmiga";

/**
 * Provides a webview for viewing emulator memory in different formats
 */
export class MemoryViewerProvider {
  public static readonly viewType = "vamiga-debugger.memoryViewer";

  private panel?: vscode.WebviewPanel;
  private currentAddress: number = 0;
  private viewMode: "hex" | "visual" | "disassembly" | "copper" = "hex";
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
      await this.updateContent(false);
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
            viewMode: this.viewMode,
            liveUpdate: this.liveUpdate,
          });
          await this.updateContent(false);
          break;
        case "changeAddress":
          this.currentAddress = message.address;
          await this.updateContent(false);
          break;
        case "changeViewMode":
          this.viewMode = message.mode;
          await this.updateContent(false);
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

    await this.updateContent(true); // Initial load needs full HTML
  }

  private async updateContent(fullRefresh: boolean = false): Promise<void> {
    if (!this.panel) {
      return;
    }

    let content = "";
    let error: string | undefined;

    try {
      switch (this.viewMode) {
        case "hex":
          content = await this.generateHexDump();
          break;
        case "visual":
        case "disassembly":
        case "copper":
          content = `View mode '${this.viewMode}' not yet implemented.`;
          break;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (fullRefresh) {
      // Full HTML refresh (for initial load or view mode changes)
      this.panel.webview.html = this.getHtmlContent();
    } else {
      // Just update the content area via message
      this.panel.webview.postMessage({
        command: "updateContent",
        content: content,
        error: error,
      });
    }
  }

  /**
   * Generates a hex dump of memory at the current address
   * @returns Formatted hex dump string
   */
  private async generateHexDump(): Promise<string> {
    const bytesPerLine = 16;
    const numLines = 32;
    const totalBytes = bytesPerLine * numLines;

    const buffer = await this.vAmiga.readMemory(
      this.currentAddress,
      totalBytes,
    );

    const lines: string[] = [];

    for (let i = 0; i < numLines; i++) {
      const lineAddress = this.currentAddress + i * bytesPerLine;
      const offset = i * bytesPerLine;

      const addrStr = lineAddress.toString(16).toUpperCase().padStart(6, "0");

      const hexBytes: string[] = [];
      const asciiChars: string[] = [];

      for (let j = 0; j < bytesPerLine; j++) {
        const byteIndex = offset + j;
        if (byteIndex < buffer.length) {
          const byte = buffer[byteIndex];
          hexBytes.push(byte.toString(16).toUpperCase().padStart(2, "0"));

          if (byte >= 32 && byte <= 126) {
            asciiChars.push(String.fromCharCode(byte));
          } else {
            asciiChars.push(".");
          }
        } else {
          hexBytes.push("  ");
          asciiChars.push(" ");
        }
      }

      const hex1 = hexBytes.slice(0, 4).join(" ");
      const hex2 = hexBytes.slice(4, 8).join(" ");
      const hex3 = hexBytes.slice(8, 12).join(" ");
      const hex4 = hexBytes.slice(12, 16).join(" ");
      const ascii = asciiChars.join("");

      lines.push(`${addrStr}  ${hex1}  ${hex2}  ${hex3}  ${hex4}  |${ascii}|`);
    }

    return lines.join("\n");
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