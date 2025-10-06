import React, { useState, useEffect, useRef } from "react";
import "@vscode-elements/elements";
import { VscodeCheckbox, VscodeTextfield } from "@vscode-elements/elements";
import { HexDump } from "./HexDump";
import { VisualView } from "./VisualView";

const vscode = acquireVsCodeApi();

// Message types
interface UpdateStateMessage {
  command: "updateState";
  addressInput?: string;
  baseAddress?: number;
  memoryRange?: { start: number; end: number };
  liveUpdate?: boolean;
  error?: string;
}

interface MemoryDataMessage {
  command: "memoryData";
  offset: number;
  data: Uint8Array;
  baseAddress: number;
}

type ViewMode = "hex" | "visual" | "disassembly" | "copper";

export function App() {
  const [baseAddress, setBaseAddress] = useState<number | undefined>(undefined);
  const baseAddressRef = useRef<number | undefined>(undefined);
  const [memoryRange, setMemoryRange] = useState<{ start: number; end: number }>({
    start: -1024 * 1024,
    end: 1024 * 1024,
  });
  const [viewMode, setViewMode] = useState<ViewMode>("hex");
  const [liveUpdate, setLiveUpdate] = useState<boolean>(true);
  const [memoryChunks, setMemoryChunks] = useState<Map<number, Uint8Array>>(
    new Map(),
  );
  const [addressInput, setAddressInput] = useState<string>("000000");
  const [error, setError] = useState<string | null>(null);
  const [scrollResetTrigger, setScrollResetTrigger] = useState<number>(0);

  // Keep ref in sync
  useEffect(() => {
    baseAddressRef.current = baseAddress;
  }, [baseAddress]);

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
        if (pendingUpdate.baseAddress !== undefined) {
          const addressChanged = pendingUpdate.baseAddress !== baseAddressRef.current;

          if (addressChanged) {
            console.log(`Address changed from ${baseAddressRef.current} to ${pendingUpdate.baseAddress} - clearing chunks`);
            setBaseAddress(pendingUpdate.baseAddress);
            setMemoryChunks(new Map());
          } else {
            // Same address re-submitted - just trigger scroll reset
            console.log(`Same address re-submitted - triggering scroll reset`);
            setScrollResetTrigger(prev => prev + 1);
          }
        }
        if (pendingUpdate.memoryRange !== undefined) {
          setMemoryRange(pendingUpdate.memoryRange);
        }
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
      } else if (message.command === "memoryData") {
        const memData = message as MemoryDataMessage;
        console.log(`Received chunk: offset=${memData.offset}, baseAddress=${memData.baseAddress}, current=${baseAddressRef.current}`);
        // Only update if data is for current base address
        if (memData.baseAddress === baseAddressRef.current) {
          setMemoryChunks((prev) => {
            const next = new Map(prev);
            next.set(memData.offset, new Uint8Array(memData.data));
            console.log(`Added chunk at offset ${memData.offset}, total chunks: ${next.size}`);
            return next;
          });
        } else {
          console.log(`Ignored chunk - base address mismatch`);
        }
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
      resetScroll: true, // Tell HexDump to reset scroll position
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

  const requestMemory = (offset: number, count: number) => {
    vscode.postMessage({
      command: "requestMemory",
      offset,
      count,
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

      {baseAddress !== undefined ? (
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
                baseAddress={baseAddress}
                memoryRange={memoryRange}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "visual" && (
              <VisualView
                baseAddress={baseAddress}
                memoryRange={memoryRange}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
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
