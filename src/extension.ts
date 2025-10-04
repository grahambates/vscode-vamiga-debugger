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
  console.log("VAmiga extension activating...");
  try {
    console.log("Creating VAmiga instance...");
    const vAmiga = new VAmiga(context.extensionUri);
    console.log("Creating MemoryViewerProvider...");
    const memoryViewer = new MemoryViewerProvider(context.extensionUri, vAmiga);
    console.log("Registering commands...");

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
        let memoryAddress = 0;

        if (address) {
          // Parse address from parameter
          memoryAddress = parseInt(address, 16);
        } else {
          // Prompt user for address
          const input = await vscode.window.showInputBox({
            prompt: "Enter memory address (hexadecimal)",
            placeHolder: "000000",
            validateInput: (value) => {
              const parsed = parseInt(value, 16);
              if (isNaN(parsed)) {
                return "Please enter a valid hexadecimal address";
              }
              if (parsed < 0 || parsed > 0xffffff) {
                return "Address must be between 000000 and FFFFFF";
              }
              return null;
            },
          });

          if (!input) {
            return; // User cancelled
          }

          memoryAddress = parseInt(input, 16);
        }

        await memoryViewer.show(memoryAddress);
      },
    ),
  );

    // Clean up memory viewer on deactivation
    context.subscriptions.push({
      dispose: () => memoryViewer.dispose(),
    });
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to activate VAmiga debugger: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

/**
 * Deactivates the VAmiga debugger extension.
 *
 * Called when the extension is deactivated. Currently performs no cleanup
 * as resources are managed by VS Code's disposal mechanisms.
 */
export function deactivate() {}
