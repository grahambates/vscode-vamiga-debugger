import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export class VAmigaView {
  public static readonly viewType = "vamiga-debugger.webview";
  private static _instance: VAmigaView | undefined;
  private _panel?: vscode.WebviewPanel;

  constructor(private readonly _extensionUri: vscode.Uri) { }

  public static getInstance(extensionUri: vscode.Uri): VAmigaView {
    if (!VAmigaView._instance) {
      VAmigaView._instance = new VAmigaView(extensionUri);
    }
    return VAmigaView._instance;
  }

  public openFile(filePath: string): void {
    if (!existsSync(filePath)) {
      vscode.window.showErrorMessage(`File not found: ${filePath}`);
      return;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, reveal it and load the file
    if (this._panel) {
      this._panel.reveal(column);
      const programUri = this.absolutePathToWebviewUri(filePath);
      this.sendCommand("loadFile", { uri: programUri?.toString(), fileName: filePath.split('/').pop() });
      this.sendCommand("reset");
      return;
    }

    // Create new panel
    this._panel = vscode.window.createWebviewPanel(
      VAmigaView.viewType,
      "VAmiga Emulator",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          this._extensionUri,
          ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) || [])
        ]
      },
    );

    const programUri = this.absolutePathToWebviewUri(filePath);
    this._panel.webview.html = this._getHtmlForWebview(programUri);

    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });
  }

  public pause(): void {
    this.sendCommand("pause");
  }

  public run(): void {
    this.sendCommand("run");
  }

  public onDidReceiveMessage(callback: (data: any) => void): void {
    if (this._panel) {
      this._panel.webview.onDidReceiveMessage(callback);
    }
  }

  private absolutePathToWebviewUri(absolutePath: string): vscode.Uri {
    if (!this._panel) {
      throw new Error("Panel not initialized");
    }
    const fileUri = vscode.Uri.file(absolutePath);
    return this._panel.webview.asWebviewUri(fileUri);
  }

  private sendCommand(command: string, args?: any): void {
    if (this._panel) {
      this._panel.webview.postMessage({ command, args });
    } else {
      vscode.window.showErrorMessage("Emulator panel is not open");
    }
  }

  public dispose(): void {
    this._panel?.dispose();
    this._panel = undefined;
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