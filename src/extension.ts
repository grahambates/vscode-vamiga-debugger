import * as vscode from "vscode";
import { VamigaDebugAdapter } from "./vAmigaDebugAdapter";
import { VAmiga } from "./vAmiga";
import { MemoryViewerProvider } from "./memoryViewerProvider";

/**
 * Activates the VAmiga debugger VS Code extension.
 *
 * Initializes the VAmiga emulator interface and registers the debug adapter
 * factory with VS Code's debugging infrastructure. The debug adapter handles
 * Amiga program debugging through the Debug Adapter Protocol.
 *
 * @param context VS Code extension context for managing resources
 */
export function activate(context: vscode.ExtensionContext) {
  const vAmiga = new VAmiga(context.extensionUri);
  const memoryViewer = new MemoryViewerProvider(context.extensionUri, vAmiga);

  // Register the debug adapter
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("vamiga", {
      createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
      ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
          new VamigaDebugAdapter(vAmiga),
        );
      },
    }),
  );

  // Register EOF command
  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.eof", () => {
      vAmiga.eof();
    }),
  );

  // Register EOL command
  context.subscriptions.push(
    vscode.commands.registerCommand("vamiga-debugger.eol", () => {
      vAmiga.eol();
    }),
  );

  // Register memory viewer command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.openMemoryViewer",
      async (address?: string) => {
        if (!address) {
          // Prompt user for address
          address = await vscode.window.showInputBox({
            prompt: "Enter memory address or expression",
            placeHolder: "0x00000000",
          });

          if (!address) {
            return; // User cancelled
          }
        }
        await memoryViewer.show(address);
      },
    ),
  );

  // Register view variable in memory command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vamiga-debugger.viewVariableInMemory",
      async (item) => {
        if (item?.container?.name === 'Symbols') {
          await memoryViewer.show(item.variable.name);
        } else if (item?.variable?.memoryReference) {
          await memoryViewer.show(item.variable.memoryReference);
        } else {
          vscode.window.showInformationMessage(
            "This variable does not have a memory reference"
          );
        }
      },
    ),
  );

  // Clean up memory viewer on deactivation
  context.subscriptions.push({
    dispose: () => memoryViewer.dispose(),
  });
}

/**
 * Deactivates the VAmiga debugger extension.
 *
 * Called when the extension is deactivated. Currently performs no cleanup
 * as resources are managed by VS Code's disposal mechanisms.
 */
export function deactivate() {}
