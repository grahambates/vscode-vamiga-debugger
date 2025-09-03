import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export class VAmigaView {
  public static readonly viewType = "vamiga-debugger.webview";
  private _panel?: vscode.WebviewPanel;

  constructor(private readonly _extensionUri: vscode.Uri) { }

  public openFile(filePath: string): void {
    if (!existsSync(filePath)) {
      vscode.window.showErrorMessage(`File not found: ${filePath}`);
      return;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // Create new panel
    this._panel = vscode.window.createWebviewPanel(
      VAmigaView.viewType,
      "VAmiga",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep webview alive when hidden
        localResourceRoots: [
          this._extensionUri,
          ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) || [])
        ]
      },
    );

    const programUri = this.absolutePathToWebviewUri(filePath);
    this._panel.webview.html = this._getHtmlForWebview(programUri);

    // Handle webview lifecycle
    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });
  }

  public reveal(): void {
    this._panel?.reveal();
  }

  public onDidReceiveMessage(callback: (data: any) => void): void {
    this._panel?.webview.onDidReceiveMessage(callback);
  }

  public onDidDispose(callback: () => void): void {
    this._panel?.onDidDispose(callback);
  }

  public sendCommand(command: string, args?: any): void {
    if (this._panel) {
      this._panel.webview.postMessage({ command, args });
    } else {
      vscode.window.showErrorMessage("Emulator panel is not open");
    }
  }

  public dispose(): void {
    this._panel?.dispose();
  }

  // Helper methods:

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

    const vamigaUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "vamiga"));

    // Read the HTML template from the vamiga directory
    const templatePath = join(this._extensionUri.fsPath, "vamiga", "vAmiga.html");
    let htmlContent = readFileSync(templatePath, 'utf8');

    // Replace template variables
    htmlContent = htmlContent.replace(/\$\{vamigaUri\}/g, vamigaUri.toString());
    htmlContent = htmlContent.replace(/\$\{programUri\}/g, programUri.toString());

    return htmlContent;
  }
}