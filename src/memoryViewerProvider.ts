import * as vscode from 'vscode';
import { VAmiga, isEmulatorStateMessage } from './vAmiga';

/**
 * Provides a webview for viewing emulator memory in different formats
 */
export class MemoryViewerProvider {
  public static readonly viewType = 'vamiga-debugger.memoryViewer';

  private _panel?: vscode.WebviewPanel;
  private _currentAddress: number = 0;
  private _viewMode: 'hex' | 'visual' | 'disassembly' | 'copper' = 'hex';
  private _liveUpdate: boolean = false;
  private _liveUpdateInterval?: NodeJS.Timeout;
  private _emulatorMessageListener?: vscode.Disposable;
  private _isEmulatorRunning: boolean = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _vAmiga: VAmiga
  ) {
    // Listen for emulator state changes to auto-refresh
    // This now works even before the VAmiga panel is opened
    this._emulatorMessageListener = this._vAmiga.onDidReceiveMessage((message) => {
      if (isEmulatorStateMessage(message)) {
        const wasRunning = this._isEmulatorRunning;
        this._isEmulatorRunning = message.state === 'running';

        if (this._panel) {
          // Refresh on pause
          if (message.state === 'paused') {
            this.updateContent().catch(err => {
              console.error('Failed to update memory viewer:', err);
            });
          }

          // Handle live update mode
          if (this._liveUpdate) {
            if (this._isEmulatorRunning && !wasRunning) {
              // Just started running - start live updates
              this.startLiveUpdate();
            } else if (!this._isEmulatorRunning && wasRunning) {
              // Just stopped - stop live updates
              this.stopLiveUpdate();
            }
          }
        }
      }
    });
  }

  /**
   * Opens the memory viewer at a specific address
   * @param address Memory address to view
   */
  public async show(address: number): Promise<void> {
    this._currentAddress = address;

    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Two);
      await this.updateContent(true); // Full refresh when showing at new address
    } else {
      await this.createPanel();
    }
  }

  /**
   * Disposes the memory viewer panel
   */
  public dispose(): void {
    this.stopLiveUpdate();
    this._emulatorMessageListener?.dispose();
    this._panel?.dispose();
    this._panel = undefined;
  }

  private async createPanel(): Promise<void> {
    this._panel = vscode.window.createWebviewPanel(
      MemoryViewerProvider.viewType,
      'Memory Viewer',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });

    this._panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'changeAddress':
          this._currentAddress = message.address;
          await this.updateContent(true); // Full refresh to update address input
          break;
        case 'changeViewMode':
          this._viewMode = message.mode;
          await this.updateContent(true); // Full refresh to update active button
          break;
        case 'toggleLiveUpdate':
          this._liveUpdate = message.enabled;
          if (this._liveUpdate && this._isEmulatorRunning) {
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
    if (!this._panel) {
      return;
    }

    let content = '';
    let error: string | undefined;

    try {
      switch (this._viewMode) {
        case 'hex':
          content = await this.generateHexDump();
          break;
        case 'visual':
        case 'disassembly':
        case 'copper':
          content = `View mode '${this._viewMode}' not yet implemented.`;
          break;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (fullRefresh) {
      // Full HTML refresh (for initial load or view mode changes)
      this._panel.webview.html = this.getHtmlContent(content, error);
    } else {
      // Just update the content area via message
      this._panel.webview.postMessage({
        command: 'updateContent',
        content: content,
        error: error
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

    const buffer = await this._vAmiga.readMemory(this._currentAddress, totalBytes);

    const lines: string[] = [];

    for (let i = 0; i < numLines; i++) {
      const lineAddress = this._currentAddress + (i * bytesPerLine);
      const offset = i * bytesPerLine;

      const addrStr = lineAddress.toString(16).toUpperCase().padStart(6, '0');

      const hexBytes: string[] = [];
      const asciiChars: string[] = [];

      for (let j = 0; j < bytesPerLine; j++) {
        const byteIndex = offset + j;
        if (byteIndex < buffer.length) {
          const byte = buffer[byteIndex];
          hexBytes.push(byte.toString(16).toUpperCase().padStart(2, '0'));

          if (byte >= 32 && byte <= 126) {
            asciiChars.push(String.fromCharCode(byte));
          } else {
            asciiChars.push('.');
          }
        } else {
          hexBytes.push('  ');
          asciiChars.push(' ');
        }
      }

      const hex1 = hexBytes.slice(0, 4).join(' ');
      const hex2 = hexBytes.slice(4, 8).join(' ');
      const hex3 = hexBytes.slice(8, 12).join(' ');
      const hex4 = hexBytes.slice(12, 16).join(' ');
      const ascii = asciiChars.join('');

      lines.push(`${addrStr}  ${hex1}  ${hex2}  ${hex3}  ${hex4}  |${ascii}|`);
    }

    return lines.join('\n');
  }

  /**
   * Starts live updates at ~60fps when emulator is running
   */
  private startLiveUpdate(): void {
    if (this._liveUpdateInterval) {
      return; // Already running
    }

    // Update at ~60fps (every ~16ms)
    this._liveUpdateInterval = setInterval(() => {
      if (this._panel && this._liveUpdate && this._isEmulatorRunning) {
        this.updateContent().catch(err => {
          console.error('Failed to update memory viewer during live update:', err);
        });
      }
    }, 16);
  }

  /**
   * Stops live updates
   */
  private stopLiveUpdate(): void {
    if (this._liveUpdateInterval) {
      clearInterval(this._liveUpdateInterval);
      this._liveUpdateInterval = undefined;
    }
  }

  private getHtmlContent(content: string, error?: string): string {
    const escapedContent = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memory Viewer</title>
  <style>
    body {
      padding: 20px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      margin: 0;
    }
    .header {
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .address-input {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    .address-input input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family);
      width: 100px;
    }
    .address-input button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 12px;
      cursor: pointer;
    }
    .address-input button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .view-mode-selector {
      display: flex;
      gap: 10px;
    }
    .view-mode-selector button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
    }
    .view-mode-selector button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .view-mode-selector button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .content {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.4;
      white-space: pre;
      overflow-x: auto;
    }
    .error {
      padding: 20px;
      background-color: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-errorForeground);
      border-radius: 4px;
    }
    .placeholder {
      padding: 40px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="address-input">
      <label for="address">Address:</label>
      <input
        type="text"
        id="address"
        value="${this._currentAddress.toString(16).toUpperCase().padStart(6, '0')}"
        placeholder="000000"
      />
      <button onclick="goToAddress()">Go</button>
    </div>
    <div class="view-mode-selector">
      <button class="${this._viewMode === 'hex' ? 'active' : ''}" onclick="changeViewMode('hex')">Hex Dump</button>
      <button class="${this._viewMode === 'visual' ? 'active' : ''}" onclick="changeViewMode('visual')">Visual</button>
      <button class="${this._viewMode === 'disassembly' ? 'active' : ''}" onclick="changeViewMode('disassembly')">Disassembly</button>
      <button class="${this._viewMode === 'copper' ? 'active' : ''}" onclick="changeViewMode('copper')">Copper</button>
    </div>
    <div style="margin-top: 10px;">
      <label>
        <input type="checkbox" id="liveUpdate" ${this._liveUpdate ? 'checked' : ''} onchange="toggleLiveUpdate()">
        Live Update (refresh while running)
      </label>
    </div>
  </div>
  <div class="content">
    ${error ? `<div class="error">Error: ${error}</div>` : escapedContent || '<div class="placeholder">No content</div>'}
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    function goToAddress() {
      const addressInput = document.getElementById('address');
      const address = parseInt(addressInput.value, 16);
      if (!isNaN(address)) {
        vscode.postMessage({
          command: 'changeAddress',
          address: address
        });
      }
    }

    function changeViewMode(mode) {
      vscode.postMessage({
        command: 'changeViewMode',
        mode: mode
      });
    }

    function toggleLiveUpdate() {
      const checkbox = document.getElementById('liveUpdate');
      vscode.postMessage({
        command: 'toggleLiveUpdate',
        enabled: checkbox.checked
      });
    }

    document.getElementById('address').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        goToAddress();
      }
    });

    // Listen for content updates from extension
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'updateContent') {
        const contentDiv = document.querySelector('.content');
        if (message.error) {
          contentDiv.innerHTML = '<div class="error">Error: ' + message.error + '</div>';
        } else if (message.content) {
          // Escape HTML and preserve formatting
          const escaped = message.content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          contentDiv.textContent = escaped;
        } else {
          contentDiv.innerHTML = '<div class="placeholder">No content</div>';
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
