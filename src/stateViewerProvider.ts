import * as vscode from "vscode";
import { VAmiga, CustomRegisters, isEmulatorStateMessage } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import {
  DisplayState,
  AmigaColor,
  UpdateDisplayStateMessage,
  StateViewerMessage,
} from "./shared/stateViewerTypes";
import { parseBplcon0Register, parseBplcon1Register, parseBplcon2Register, parseBplcon3Register } from "./amigaRegisterParsers";

/**
 * Provides a webview for visualizing Amiga system state including
 * color palette, display configuration, and other chipset information.
 */
export class StateViewerProvider {
  public static readonly viewType = "vamiga-debugger.stateViewer";

  private panel?: vscode.WebviewPanel;
  private emulatorMessageListener?: vscode.Disposable;
  private isEmulatorRunning = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly vAmiga: VAmiga,
  ) {
    // Listen for emulator state changes to auto-refresh panel
    this.emulatorMessageListener = this.vAmiga.onDidReceiveMessage(
      (message) => {
        if (!isEmulatorStateMessage(message)) {
          return;
        }
        // const wasRunning = this.isEmulatorRunning;
        this.isEmulatorRunning = message.state === "running";

        // Update panel when emulator stops/pauses
        if (
          this.panel &&
          (message.state === "paused" || message.state === "stopped")
        ) {
          this.refreshDisplayState();
        }
      },
    );
  }

  /**
   * Disposes the state viewer panel
   */
  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.emulatorMessageListener?.dispose();
  }

  /**
   * Opens or focuses the state viewer panel
   */
  public async show(): Promise<void> {
    if (this.panel) {
      // Panel already exists, just reveal it
      this.panel.reveal(vscode.ViewColumn.Beside);
      await this.refreshDisplayState();
      return;
    }

    // Create new panel
    this.panel = vscode.window.createWebviewPanel(
      StateViewerProvider.viewType,
      "Amiga State",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.getHtmlContent(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message: StateViewerMessage) => {
      switch (message.command) {
        case "ready":
          await this.refreshDisplayState();
          break;
        case "refresh":
          await this.refreshDisplayState();
          break;
      }
    });
  }

  /**
   * Extracts display state from custom registers
   */
  private parseDisplayState(registers: CustomRegisters): DisplayState {
    const palette: AmigaColor[] = [];

    // Extract color palette from COLOR00-COLOR31 registers
    for (let i = 0; i < 32; i++) {
      const regName = `COLOR${i.toString().padStart(2, "0")}`;
      const regValue = registers[regName]?.value;
      if (regValue) {
        // Amiga uses 12-bit color: 0x0RGB where each component is 4 bits
        const value = parseInt(regValue, 16);
        palette.push({
          r: (value >> 8) & 0xf,
          g: (value >> 4) & 0xf,
          b: value & 0xf,
          register: i,
        });
      }
    }


    // Get display window registers
    const diwstrt = registers.DIWSTRT.value;
    const diwstop = registers.DIWSTOP.value;
    const ddfstrt = registers.DDFSTRT.value;
    const ddfstop = registers.DDFSTOP.value;

    // Get display control registers
    const bplcon0 = registers.BPLCON0.value;
    const bplcon0Parsed = parseBplcon0Register(Number(bplcon0)).map(v => v.value);
    const [hires, bitplanes, ham, dpf, _color, _genlock, _lightpen, interlaced, _extResync, ecsEna] = bplcon0Parsed;

    const bplcon1 = registers.BPLCON1.value;
    const bplcon1Parsed = parseBplcon1Register(Number(bplcon1)).map(v => v.value as number);
    const [pf2h, pf1h] = bplcon1Parsed;

        const bplcon2 = registers.BPLCON2.value;
    const bplcon2Parsed = parseBplcon2Register(Number(bplcon2)).map(v => v.value);
    const [pf2Pri, pf2p, pf1p] = bplcon2Parsed;


    const bplcon3 = registers.BPLCON3.value;
    const bplcon3Parsed = parseBplcon3Register(Number(bplcon3)).map(v => v.value);
    const [_bank, _pf2of, _spriteRes, borderSprites, borderTransparent, _zsClkEn, borderBlank] = bplcon3Parsed;

    return {
      palette,
      bitplanes: bitplanes as number,
      interlaced: interlaced as boolean,
      hires: hires as boolean,
      ham: ham as boolean,
      dpf: dpf as boolean,
      ecsEna: ecsEna as boolean,
      pf2h,
      pf1h,
      pf2Pri: pf2Pri as boolean,
      pf2p: pf2p as number,
      pf1p: pf1p as number,
      borderSprites: borderSprites as boolean,
      borderTransparent: borderTransparent as boolean,
      borderBlank: borderBlank as boolean,
      diwstrt,
      diwstop,
      ddfstrt,
      ddfstop,
    };
  }

  /**
   * Fetches current display state and sends to webview
   */
  private async refreshDisplayState(): Promise<void> {
    if (!this.panel) {
      return;
    }

    const adapter = VamigaDebugAdapter.getActiveAdapter();
    if (!adapter) {
      return;
    }

    try {
      const registers = await this.vAmiga.getAllCustomRegisters();
      const displayState = this.parseDisplayState(registers);

      const message: UpdateDisplayStateMessage = {
        command: "updateDisplayState",
        displayState,
      };

      this.panel.webview.postMessage(message);
    } catch (error) {
      console.error("Failed to refresh display state:", error);
    }
  }

  /**
   * Generates the HTML content for the webview
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "stateViewer.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "stateViewer.css"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css",
      ),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${codiconsUri}" rel="stylesheet" id="vscode-codicon-stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Amiga State</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
