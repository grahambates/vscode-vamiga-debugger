/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export class VAmigaView {
  public static readonly viewType = "vamiga-debugger.webview";
  private _panel?: vscode.WebviewPanel;
  private _pendingRpcs = new Map<
    string,
    { resolve: (result: any) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
  >();

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public openFile(filePath: string): void {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const column = this.getConfiguredViewColumn();

    // Create new panel
    this._panel = vscode.window.createWebviewPanel(
      VAmigaView.viewType,
      "VAmiga",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep webview alive when hidden
        localResourceRoots: [
          this._extensionUri,
          ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ||
            []),
        ],
      },
    );

    const programUri = this.absolutePathToWebviewUri(filePath);
    this._panel.webview.html = this._getHtmlForWebview(programUri);

    // Handle webview lifecycle
    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });

    // Set up RPC response handler
    this._panel.webview.onDidReceiveMessage((message) => {
      if (message.type === "rpcResponse") {
        const pending = this._pendingRpcs.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this._pendingRpcs.delete(message.id);
          if (message.result.error) {
            pending.reject(new Error(message.result.error));
          } else {
            pending.resolve(message.result);
          }
        }
      }
    });
  }

  public reveal(): void {
    this._panel?.reveal();
  }

  public onDidReceiveMessage(callback: (data: any) => void): vscode.Disposable | undefined {
    return this._panel?.webview.onDidReceiveMessage(callback);
  }

  public onDidDispose(callback: () => void): vscode.Disposable | undefined {
    return this._panel?.onDidDispose(callback);
  }

  public sendCommand<A = any>(command: string, args?: A): void {
    if (this._panel) {
      this._panel.webview.postMessage({ command, args });
    } else {
      vscode.window.showErrorMessage("Emulator panel is not open");
    }
  }

  public async sendRpcCommand<T = any, A = any>(
    command: string,
    args?: A,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this._panel) {
        reject(new Error("Emulator panel is not open"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      const timeout = setTimeout(() => {
        this._pendingRpcs.delete(id);
        reject(new Error(`RPC timeout after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      this._pendingRpcs.set(id, { resolve, reject, timeout });
      this._panel.webview.postMessage({
        command,
        args: { ...args, _rpcId: id },
      });
    });
  }

  public dispose(): void {
    // Clean up any pending RPCs
    for (const [_, pending] of this._pendingRpcs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Webview disposed"));
    }
    this._pendingRpcs.clear();

    this._panel?.dispose();
  }

  // Helper methods:

  private getConfiguredViewColumn(): vscode.ViewColumn {
    const config = vscode.workspace.getConfiguration("vamiga-debugger");
    const setting = config.get<string>("defaultViewColumn", "beside");

    switch (setting) {
      case "one":
        return vscode.ViewColumn.One;
      case "two":
        return vscode.ViewColumn.Two;
      case "three":
        return vscode.ViewColumn.Three;
      case "beside":
        return vscode.ViewColumn.Beside;
      case "active":
        return (
          vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One
        );
      default:
        return vscode.ViewColumn.Beside;
    }
  }

  private absolutePathToWebviewUri(absolutePath: string): vscode.Uri {
    if (!this._panel) {
      throw new Error("Panel not initialized");
    }
    const fileUri = vscode.Uri.file(absolutePath);
    return this._panel.webview.asWebviewUri(fileUri);
  }

  private _getHtmlForWebview(programUri: vscode.Uri): string {
    if (!this._panel) {
      throw new Error("Panel not initialized");
    }

    const vamigaUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "vamiga"),
    );

    // Read the HTML template from the vamiga directory
    const templatePath = join(
      this._extensionUri.fsPath,
      "vamiga",
      "vAmiga.html",
    );
    let htmlContent = readFileSync(templatePath, "utf8");

    // Replace template variables
    htmlContent = htmlContent.replace(/\$\{vamigaUri\}/g, vamigaUri.toString());
    htmlContent = htmlContent.replace(
      /\$\{programUri\}/g,
      programUri.toString(),
    );

    return htmlContent;
  }
}

