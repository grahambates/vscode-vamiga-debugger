import * as vscode from 'vscode';
import { VAmiga, isEmulatorStateMessage } from './vAmiga';
import { readFileSync } from 'fs';
import { join } from 'path';

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
    if (!this._panel) {
      throw new Error('Panel not initialized');
    }

    const webview = this._panel.webview;

    // Get URIs for bundled resources
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'memoryViewer', 'styles.css')
    );

    // Read HTML template
    const htmlPath = join(
      this._extensionUri.fsPath,
      'src',
      'webview',
      'memoryViewer',
      'index.html'
    );
    let html = readFileSync(htmlPath, 'utf8');

    // Replace placeholders
    const cspSource = webview.cspSource;

    const initialContent = error
      ? `<div class="error">Error: ${escapeHtml(error)}</div>`
      : content
      ? escapeHtml(content)
      : '<div class="placeholder">Loading...</div>';

    html = html
      .replace(/{{cspSource}}/g, cspSource)
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString())
      .replace(/{{currentAddress}}/g, this._currentAddress.toString(16).toUpperCase().padStart(6, '0'))
      .replace(/{{hexActive}}/g, this._viewMode === 'hex' ? 'active' : '')
      .replace(/{{visualActive}}/g, this._viewMode === 'visual' ? 'active' : '')
      .replace(/{{disassemblyActive}}/g, this._viewMode === 'disassembly' ? 'active' : '')
      .replace(/{{copperActive}}/g, this._viewMode === 'copper' ? 'active' : '')
      .replace(/{{liveUpdateChecked}}/g, this._liveUpdate ? 'checked' : '')
      .replace(/{{initialContent}}/g, initialContent);

    return html;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Old inline template removed - now using external HTML/CSS/TS files
