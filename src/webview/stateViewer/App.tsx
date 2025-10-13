import { useState, useEffect } from "react";
import "@vscode-elements/elements";
import "./App.css";
import {
  DisplayState,
  UpdateDisplayStateMessage,
} from "../../shared/stateViewerTypes";
import { DisplayTab } from "./DisplayTab";

const vscode = acquireVsCodeApi();

export function App() {
  const [displayState, setDisplayState] = useState<DisplayState | null>(null);

  // Send ready message on mount
  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.command === "updateDisplayState") {
        const updateMessage = message as UpdateDisplayStateMessage;
        setDisplayState(updateMessage.displayState);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  const handleRefresh = () => {
    vscode.postMessage({ command: "refresh" });
  };

  return (
    <div className="state-viewer">
      {displayState ? (
        <vscode-tabs>
          <vscode-tab-header>Display</vscode-tab-header>
          {/* <vscode-tab-header>Sprites</vscode-tab-header> */}

          <vscode-tab-panel>
            <DisplayTab displayState={displayState} />
          </vscode-tab-panel>
          <vscode-tab-panel>
            <div className="coming-soon">
              Coming soon...
            </div>
          </vscode-tab-panel>
        </vscode-tabs>
      ) : (
        <div className="loading">Loading state...</div>
      )}

      <vscode-button onClick={handleRefresh}>
        <span className="codicon codicon-refresh"></span>
        Refresh
      </vscode-button>
    </div>
  );
}
