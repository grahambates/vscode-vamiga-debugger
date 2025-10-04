import React, { useState, useEffect } from "react";
import "@vscode-elements/elements";
import { VscodeCheckbox, VscodeTextfield } from "@vscode-elements/elements";

const vscode = acquireVsCodeApi();

// Message types
interface UpdateContentMessage {
  command: "updateContent";
  content: string;
  error?: string;
}

interface InitMessage {
  command: "init";
  address: number;
  viewMode: ViewMode;
  liveUpdate: boolean;
}

interface UpdateAddressMessage {
  command: "updateAddress";
  address: number;
}

type ViewMode = "hex" | "visual" | "disassembly" | "copper";

export function App() {
  const [currentAddress, setCurrentAddress] = useState<number>(0);
  const [viewMode, setViewMode] = useState<ViewMode>("hex");
  const [liveUpdate, setLiveUpdate] = useState<boolean>(false);
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [addressInput, setAddressInput] = useState<string>("000000");

  // Send ready message on mount
  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.command === "init") {
        const initMsg = message as InitMessage;
        setCurrentAddress(initMsg.address);
        setViewMode(initMsg.viewMode);
        setLiveUpdate(initMsg.liveUpdate);
      } else if (message.command === "updateAddress") {
        const addressMsg = message as UpdateAddressMessage;
        setCurrentAddress(addressMsg.address);
      } else if (message.command === "updateContent") {
        const updateMsg = message as UpdateContentMessage;
        if (updateMsg.error) {
          setError(updateMsg.error);
          setContent("");
        } else {
          setError(undefined);
          setContent(updateMsg.content || "");
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Update address input when currentAddress changes
  useEffect(() => {
    setAddressInput(currentAddress.toString(16).toUpperCase().padStart(6, "0"));
  }, [currentAddress]);

  const handleAddressChange: React.InputEventHandler<VscodeTextfield> = (e) => {
    setAddressInput((e.target as HTMLInputElement).value || "");
  };

  const goToAddress = () => {
    const address = parseInt(addressInput, 16);
    if (!isNaN(address)) {
      setCurrentAddress(address);
      vscode.postMessage({
        command: "changeAddress",
        address: address,
      });
    }
  };

  const handleKeyPress: React.KeyboardEventHandler<HTMLElement> = (e) => {
    if (e.key === "Enter") {
      goToAddress();
    }
  };

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    vscode.postMessage({
      command: "changeViewMode",
      mode: mode,
    });
  };

  const toggleLiveUpdate: React.FormEventHandler<VscodeCheckbox> = (e) => {
    const checked = (e.target as HTMLInputElement).checked || false;
    setLiveUpdate(checked);
    vscode.postMessage({
      command: "toggleLiveUpdate",
      enabled: checked,
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
            onChange={handleAddressChange}
            onKeyPress={handleKeyPress}
          />
          <vscode-button onClick={goToAddress}>Go</vscode-button>
        </div>

        <div className="view-mode-selector">
          <vscode-button
            className={viewMode === "hex" ? "active" : ""}
            onClick={() => changeViewMode("hex")}
          >
            Hex Dump
          </vscode-button>
          <vscode-button
            className={viewMode === "visual" ? "active" : ""}
            onClick={() => changeViewMode("visual")}
          >
            Visual
          </vscode-button>
          <vscode-button
            className={viewMode === "disassembly" ? "active" : ""}
            onClick={() => changeViewMode("disassembly")}
          >
            Disassembly
          </vscode-button>
          <vscode-button
            className={viewMode === "copper" ? "active" : ""}
            onClick={() => changeViewMode("copper")}
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
        {error ? (
          <div className="error">Error: {error}</div>
        ) : content ? (
          content
        ) : (
          <div className="placeholder">Loading...</div>
        )}
      </div>
    </div>
  );
}
