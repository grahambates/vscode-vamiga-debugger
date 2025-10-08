import * as vscode from "vscode";
import { VAmiga, isEmulatorStateMessage, MemSrc } from "./vAmiga";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { formatHex } from "./numbers";
import { EvaluateResultType } from "./evaluateManager";
import {
  ChangeAddressMessage,
  GetSuggestionsMessage,
  MemoryDataMessage,
  MemoryRange,
  MemoryRegion,
  RequeestMemoryMessage,
  Suggestion,
  SuggestionsDataMessage,
  ToggleLiveUpdateMessage,
  UpdateStateMessage,
  UpdateStateMessageProps,
} from "./webview/memoryViewer/types";

interface MemoryViewerPanel {
  target?: MemoryRange;
  webviewPanel: vscode.WebviewPanel;
  addressInput: string;
  liveUpdate: boolean;
  dereferencePointer: boolean;
  liveUpdateInterval?: NodeJS.Timeout;
  fetchedChunks: Set<number>;
}

const LIVE_UPDATE_RATE_MS = 1000 / 25;
const CHUNK_SIZE = 1024;
const SUGGESTIONS_LIMIT = 50;

const memTypeLabels: Record<MemSrc, string> = {
  [MemSrc.NONE]: "None",
  [MemSrc.CHIP]: "Chip RAM",
  [MemSrc.CHIP_MIRROR]: "Chip RAM (mirror)",
  [MemSrc.SLOW]: "Slow RAM",
  [MemSrc.SLOW_MIRROR]: "Slow RAM (mirror)",
  [MemSrc.FAST]: "Fast RAM",
  [MemSrc.CIA]: "CIA Registers",
  [MemSrc.CIA_MIRROR]: "CIA Registers (mirror)",
  [MemSrc.RTC]: "RTC",
  [MemSrc.CUSTOM]: "Custom Registers",
  [MemSrc.CUSTOM_MIRROR]: "Custom Registers (mirror)",
  [MemSrc.AUTOCONF]: "Autoconf",
  [MemSrc.ZOR]: "ZOR",
  [MemSrc.ROM]: "ROM",
  [MemSrc.ROM_MIRROR]: "ROM (mirror)",
  [MemSrc.WOM]: "WOM",
  [MemSrc.EXT]: "EXT",
};

/**
 * Provides a webview for viewing emulator memory in different formats.
 * Supports multiple instances for viewing different memory regions simultaneously.
 */
export class MemoryViewerProvider {
  public static readonly viewType = "vamiga-debugger.memoryViewer";

  private panels = new Map<string, MemoryViewerPanel>();
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
        for (const panel of this.panels.values()) {
          if (panel.liveUpdate) {
            // Stop/start live update mode
            if (this.isEmulatorRunning && !wasRunning) {
              this.startLiveUpdate(panel);
            } else if (!this.isEmulatorRunning && wasRunning) {
              this.stopLiveUpdate(panel);
            }
          } else if (
            message.state === "paused" ||
            message.state === "stopped"
          ) {
            // update now
            this.refreshChunks(panel);
          }
        }
      },
    );
  }

  /**
   * Disposes all memory viewer panels
   */
  public dispose(): void {
    for (const panel of this.panels.values()) {
      this.stopLiveUpdate(panel);
      panel.webviewPanel.dispose();
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

    const webviewPanel = vscode.window.createWebviewPanel(
      MemoryViewerProvider.viewType,
      "Memory Viewer",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const panel: MemoryViewerPanel = {
      webviewPanel: webviewPanel,
      addressInput,
      liveUpdate: true,
      dereferencePointer: false,
      fetchedChunks: new Set(),
    };

    this.panels.set(panelId, panel);

    webviewPanel.webview.html = this.getHtmlContent(webviewPanel.webview);

    webviewPanel.onDidDispose(() => {
      this.stopLiveUpdate(panel);
      this.panels.delete(panelId);
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "ready": {
          const adapter = VamigaDebugAdapter.getActiveAdapter();
          if (!adapter) {
            return;
          }
          const msg: UpdateStateMessage = {
            command: "updateState",
            addressInput,
            availableRegions: this.getAvailableRegions(adapter),
            symbols: adapter.getSourceMap().getSymbols(),
          };
          // Send initial state once
          panel.webviewPanel.webview.postMessage(msg);

          // Update initial content
          await this.updateContent(panel);

          // TODO: don't really know if it's running on start
          if (this.isEmulatorRunning) {
            this.startLiveUpdate(panel);
          }
          break;
        }

        case "changeAddress": {
          const changeAddressMsg = message as ChangeAddressMessage;
          panel.addressInput = changeAddressMsg.addressInput;
          panel.dereferencePointer =
            changeAddressMsg.dereferencePointer ?? false;
          await this.updateContent(panel);
          break;
        }
        case "requestMemory": {
          const requestMemoryMsg = message as RequeestMemoryMessage;
          await this.fetchMemoryChunk(
            panel,
            requestMemoryMsg.address,
            requestMemoryMsg.size,
          );
          break;
        }
        case "toggleLiveUpdate":
          panel.liveUpdate = (message as ToggleLiveUpdateMessage).enabled;
          if (panel.liveUpdate && this.isEmulatorRunning) {
            this.startLiveUpdate(panel);
          } else {
            this.stopLiveUpdate(panel);
          }
          break;
        case "getSuggestions": {
          const getSuggestionsMsg = message as GetSuggestionsMessage;
          const adapter = VamigaDebugAdapter.getActiveAdapter();
          if (adapter) {
            const suggestions = this.getSymbolSuggestions(
              adapter,
              getSuggestionsMsg.query || "",
            );
            panel.webviewPanel.webview.postMessage({
              command: "suggestionsData",
              suggestions,
            } as SuggestionsDataMessage);
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
    params: UpdateStateMessageProps,
  ): void {
    panel.webview.postMessage({
      command: "updateState",
      ...params,
      error: null,
    } as UpdateStateMessage);
  }

  /**
   * Sends error message to webview
   */
  private sendErrorToWebview(panel: vscode.WebviewPanel, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    panel.webview.postMessage({
      command: "updateState",
      error: errorMessage,
    } as UpdateStateMessage);
  }

  /**
   * Evaluates the address expression and optionally dereferences it as a 32-bit pointer
   * @returns Memory range resulting from expression
   * @throws Error if address is invalid or dereferencing fails
   */
  private async evaluateAddressInput(
    panel: MemoryViewerPanel,
  ): Promise<MemoryRange | undefined> {
    const adapter = VamigaDebugAdapter.getActiveAdapter();
    if (!adapter) {
      throw new Error("Debugger is not running");
    }

    const { value, memoryReference, type } = await adapter
      .getEvaluateManager()
      .evaluate(panel.addressInput);
    if (type === EvaluateResultType.EMPTY) {
      return;
    }
    let address = memoryReference ? Number(memoryReference) : value;
    let size = 0;

    if (typeof address !== "number") {
      throw new Error("Does not evaluate to a numeric value");
    }
    if (!this.vAmiga.isValidAddress(address)) {
      throw new Error(`Not a valid address: ${formatHex(address)}`);
    }

    // Get symbol length if the input is a symbol name
    const sourceMap = adapter.getSourceMap();
    const symbols = sourceMap.getSymbols();
    const symbolLengths = sourceMap.getSymbolLengths();

    // Check if input matches a symbol name
    if (symbols && symbolLengths) {
      const symbolAddress = symbols[panel.addressInput];
      if (symbolAddress === address) {
        size = symbolLengths[panel.addressInput];
      }
    }

    // If dereferencePointer is enabled, read 32-bit value at this address
    if (panel.dereferencePointer) {
      const targetAddress = await this.vAmiga.peek32(address);
      if (!this.vAmiga.isValidAddress(targetAddress)) {
        throw new Error(
          `Pointer at ${formatHex(address)} points to invalid address: ${formatHex(targetAddress)}`,
        );
      }
      address = targetAddress;
    }

    return { address, size };
  }

  /**
   * Updates the memory viewer content state
   */
  private async updateContent(panel: MemoryViewerPanel): Promise<void> {
    try {
      // Evaluate address input
      const target = await this.evaluateAddressInput(panel);
      if (target?.address !== undefined) {
        // Send target if we have one
        this.sendStateToWebview(panel.webviewPanel, { target });
        panel.webviewPanel.title = `Memory: ${panel.addressInput}`;
      } else {
        panel.webviewPanel.title = "Memory Viewer";
      }

      // Clear fetched map on target change
      // This should match what App does
      if (target?.address !== panel.target?.address) {
        panel.fetchedChunks.clear();
      }
      panel.target = target;
    } catch (err) {
      this.sendErrorToWebview(panel.webviewPanel, err);
    }
  }

  private async fetchMemoryChunk(
    panel: MemoryViewerPanel,
    address: number,
    size: number,
  ): Promise<void> {
    try {
      const result = await this.vAmiga.readMemory(address, size);
      const data = new Uint8Array(result);

      // Track fetched chunk
      panel.fetchedChunks.add(address);

      // Send to webview
      panel.webviewPanel.webview.postMessage({
        command: "memoryData",
        address,
        data,
      } as MemoryDataMessage);
    } catch (err) {
      console.error(
        `Failed to fetch memory chunk at ${address.toString(16)}:`,
        err,
      );
    }
  }

  /**
   * Starts live updates at ~25fps when emulator is running
   */
  private startLiveUpdate(panel: MemoryViewerPanel): void {
    if (panel.liveUpdateInterval) {
      return; // Already running
    }

    panel.liveUpdateInterval = setInterval(async () => {
      if (panel.liveUpdate && this.isEmulatorRunning) {
        this.refreshChunks(panel);
      }
    }, LIVE_UPDATE_RATE_MS);
  }

  /**
   * Stops live updates
   */
  private stopLiveUpdate(panel: MemoryViewerPanel): void {
    if (panel.liveUpdateInterval) {
      clearInterval(panel.liveUpdateInterval);
      panel.liveUpdateInterval = undefined;
    }
  }

  // Re-send all previously fetched chunks
  // TODO: is it better to just send clear event? Set can grow large
  private async refreshChunks(panel: MemoryViewerPanel) {
    for (const address of panel.fetchedChunks.values()) {
      try {
        const result = await this.vAmiga.readMemory(address, CHUNK_SIZE);

        // Send updated chunk to webview
        panel.webviewPanel.webview.postMessage({
          command: "memoryData",
          address,
          data: new Uint8Array(result),
        });
      } catch (err) {
        console.error(
          `Failed to fetch memory chunk at ${address.toString(16)}:`,
          err,
        );
      }
    }
  }

  /**
   * Gets symbol name suggestions based on query string
   */
  private getSymbolSuggestions(
    adapter: VamigaDebugAdapter,
    query: string,
  ): Suggestion[] {
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

        if (suggestions.length >= SUGGESTIONS_LIMIT) break;
      }
    }

    // Sort by name
    suggestions.sort((a, b) => a.label.localeCompare(b.label));

    return suggestions;
  }

  private getAvailableRegions(adapter: VamigaDebugAdapter): MemoryRegion[] {
    // Add segments from source map
    const regions: MemoryRegion[] = adapter
      .getSourceMap()
      .getSegmentsInfo()
      .map((seg) => ({
        name: seg.name,
        range: {
          address: seg.address,
          size: seg.size,
        },
      }));

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
              name: memTypeLabels[currentType],
              range: {
                address: currentStart,
                size: (bank << 16) - currentStart,
              },
            });
          }
          currentType = type;
          currentStart = bank << 16;
        } else if (type === MemSrc.NONE && currentType !== null) {
          // End of region
          regions.push({
            name: memTypeLabels[currentType],
            range: {
              address: currentStart,
              size: (bank << 16) - currentStart,
            },
          });
          currentType = null;
        }
      }

      // Handle last region
      if (currentType !== null) {
        regions.push({
          name: memTypeLabels[currentType],
          range: {
            address: currentStart,
            size: (256 << 16) - currentStart,
          },
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
