import React, { useState, useEffect } from "react";
import "@vscode-elements/elements";
import { VscodeCheckbox, VscodeTextfield } from "@vscode-elements/elements";
import { HexDump } from "./HexDump";

const vscode = acquireVsCodeApi();

// TODO: just need one update message?

// Message types
interface UpdateContentMessage {
  command: "updateContent";
  addressInput: string;
  currentAddress: number;
  memoryData?: Uint8Array;
  liveUpdate: boolean;
}

type ViewMode = "hex" | "visual" | "disassembly" | "copper";

export function App() {
  const [currentAddress, setCurrentAddress] = useState<number>(0);
  const [viewMode, setViewMode] = useState<ViewMode>("hex");
  const [liveUpdate, setLiveUpdate] = useState<boolean>(false);
  const [memoryData, setMemoryData] = useState<Uint8Array | undefined>(undefined);
  const [addressInput, setAddressInput] = useState<string>("000000");

  // Send ready message on mount
  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      console.log('Memory view recieved message', message);

      if (message.command === "updateContent") {
        const updateMsg = message as UpdateContentMessage;
        setAddressInput(updateMsg.addressInput);
        setCurrentAddress(updateMsg.currentAddress);
        setMemoryData(updateMsg.memoryData);
        setLiveUpdate(updateMsg.liveUpdate);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
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
      <div className="header">
        <div className="address-input">
          <label htmlFor="address">Address:</label>
          <vscode-textfield
            id="address"
            value={addressInput}
            placeholder="000000"
            onInput={handleAddressChange}
            onKeyPress={handleKeyPress}
          />
          <vscode-button onClick={goToAddress}>Go</vscode-button>
        </div>

        <div className="view-mode-selector">
          <vscode-button
            className={viewMode === "hex" ? "active" : ""}
            onClick={() => setViewMode("hex")}
          >
            Hex Dump
          </vscode-button>
          <vscode-button
            className={viewMode === "visual" ? "active" : ""}
            onClick={() => setViewMode("visual")}
          >
            Visual
          </vscode-button>
          <vscode-button
            className={viewMode === "disassembly" ? "active" : ""}
            onClick={() => setViewMode("disassembly")}
          >
            Disassembly
          </vscode-button>
          <vscode-button
            className={viewMode === "copper" ? "active" : ""}
            onClick={() => setViewMode("copper")}
          >
            Copper
          </vscode-button>
        </div>

        <div className="live-update-container">
          <vscode-checkbox checked={liveUpdate} onChange={toggleLiveUpdate}>
            Live Update (refresh while running)
          </vscode-checkbox>
        </div>
      </div>

      <div className="content">
        {memoryData ? (
          viewMode === "hex" ? (
            <HexDump memoryData={memoryData} currentAddress={currentAddress} />
          ) : (
            `View mode '${viewMode}' not yet implemented.`
          )
        ) : (
          <div className="placeholder">Loading...</div>
        )}
      </div>
    </div>
  );
}
