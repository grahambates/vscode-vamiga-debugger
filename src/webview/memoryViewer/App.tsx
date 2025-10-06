import React, { useState, useEffect } from "react";
import "@vscode-elements/elements";
import { VscodeCheckbox, VscodeTextfield } from "@vscode-elements/elements";
import { HexDump } from "./HexDump";
import { VisualView } from "./VisualView";

const vscode = acquireVsCodeApi();

// Message types
interface UpdateStateMessage {
  command: "updateState";
  addressInput?: string;
  currentAddress?: number;
  memoryData?: Uint8Array;
  liveUpdate?: boolean;
  error?: string;
}

type ViewMode = "hex" | "visual" | "disassembly" | "copper";

export function App() {
  const [currentAddress, setCurrentAddress] = useState<number>(0);
  const [viewMode, setViewMode] = useState<ViewMode>("hex");
  const [liveUpdate, setLiveUpdate] = useState<boolean>(true);
  const [memoryData, setMemoryData] = useState<Uint8Array | undefined>(
    undefined,
  );
  const [addressInput, setAddressInput] = useState<string>("000000");
  const [error, setError] = useState<string | null>(null);

  // Send ready message on mount
  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    let pendingUpdate: UpdateStateMessage | null = null;
    let rafScheduled = false;

    const applyPendingUpdate = () => {
      if (pendingUpdate) {
        if (pendingUpdate.addressInput !== undefined)
          setAddressInput(pendingUpdate.addressInput);
        if (pendingUpdate.currentAddress !== undefined)
          setCurrentAddress(pendingUpdate.currentAddress);
        if (pendingUpdate.memoryData !== undefined)
          setMemoryData(pendingUpdate.memoryData);
        if (pendingUpdate.liveUpdate !== undefined)
          setLiveUpdate(pendingUpdate.liveUpdate);
        if (pendingUpdate.error !== undefined) setError(pendingUpdate.error);
        pendingUpdate = null;
      }
      rafScheduled = false;
    };

    const scheduleUpdate = () => {
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(applyPendingUpdate);
      }
    };

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.command === "updateState") {
        // Store latest update and schedule (combining with any previous to handle optional props) to render on next frame
        pendingUpdate = {
          ...pendingUpdate,
          ...(message as UpdateStateMessage),
        };
        scheduleUpdate();
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  const handleAddressChange: React.InputEventHandler<VscodeTextfield> = (e) => {
    setAddressInput((e.target as HTMLInputElement).value || "");
  };

  const goToAddress = () => {
    vscode.postMessage({
      command: "changeAddress",
      addressInput,
    });
  };

  const handleKeyPress: React.KeyboardEventHandler<VscodeTextfield> = (e) => {
    if (e.key === "Enter") {
      goToAddress();
    }
  };

  const toggleLiveUpdate: React.FormEventHandler<VscodeCheckbox> = (e) => {
    const enabled = (e.target as HTMLInputElement).checked || false;
    setLiveUpdate(enabled);
    vscode.postMessage({
      command: "toggleLiveUpdate",
      enabled,
    });
  };

  return (
    <div className="memory-viewer">
      <div className="address-input">
        <vscode-label htmlFor="address">Address:</vscode-label>
        <vscode-textfield
          id="address"
          value={addressInput}
          placeholder="000000"
          onInput={handleAddressChange}
          onKeyPress={handleKeyPress}
        />
        <vscode-button onClick={goToAddress}>Go</vscode-button>
      </div>

      {error ? <div className="error">{error}</div> : ""}

      <div className="live-update-container">
        <vscode-checkbox checked={liveUpdate} onChange={toggleLiveUpdate}>
          Live Update (refresh while running)
        </vscode-checkbox>
      </div>

      <vscode-divider></vscode-divider>

      {memoryData ? (
        <vscode-tabs
          onvsc-tabs-select={(e) => {
            setViewMode(
              ["hex", "visual", "disassembly", "copper"][
                e.detail.selectedIndex
              ] as ViewMode,
            );
          }}
        >
          <vscode-tab-header>Hex Dump</vscode-tab-header>
          <vscode-tab-header>Visual</vscode-tab-header>
          <vscode-tab-header>Disassembly</vscode-tab-header>
          <vscode-tab-header>Copper</vscode-tab-header>

          <vscode-tab-panel>
            {viewMode === "hex" && (
              <HexDump
                memoryData={memoryData}
                currentAddress={currentAddress}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "visual" && (
              <VisualView
                memoryData={memoryData}
                currentAddress={currentAddress}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "disassembly" &&
              "View mode 'disassembly' not yet implemented."}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "copper" && "View mode 'copper' not yet implemented."}
          </vscode-tab-panel>
        </vscode-tabs>
      ) : (
        ""
      )}
    </div>
  );
}
