import React, { useState, useEffect, useRef } from "react";
import "@vscode-elements/elements";
import { VscodeCheckbox } from "@vscode-elements/elements";
import { useCombobox } from "downshift";
import { HexDump } from "./HexDump";
import { VisualView } from "./VisualView";

const vscode = acquireVsCodeApi();

// Message types
interface MemoryRegion {
  name: string;
  address: number;
  size: number;
}

interface UpdateStateMessage {
  command: "updateState";
  addressInput?: string;
  baseAddress?: number;
  symbolLength?: number;
  symbols?: Record<string, number>;
  symbolLengths?: Record<string, number>;
  memoryRange?: { start: number; end: number };
  currentRegion?: string;
  currentRegionStart?: number;
  availableRegions?: MemoryRegion[];
  liveUpdate?: boolean;
  preserveOffset?: number; // Offset delta to adjust scroll by when base address changes
  error?: string;
}

interface MemoryDataMessage {
  command: "memoryData";
  offset: number;
  data: Uint8Array;
  baseAddress: number;
}

type ViewMode = "hex" | "visual" | "disassembly" | "copper";

function formatHex(value: number): string {
  return "0x" + value.toString(16).toUpperCase().padStart(8, "0");
}

export function App() {
  const [baseAddress, setBaseAddress] = useState<number | undefined>(undefined);
  const baseAddressRef = useRef<number | undefined>(undefined);
  const [symbolLength, setSymbolLength] = useState<number | undefined>(undefined);
  const [symbols, setSymbols] = useState<Record<string, number>>({});
  const [symbolLengths, setSymbolLengths] = useState<Record<string, number>>({});
  const [memoryRange, setMemoryRange] = useState<{
    start: number;
    end: number;
  }>({
    start: -1024 * 1024,
    end: 1024 * 1024,
  });
  const [currentRegionStart, setCurrentRegionStart] = useState<
    number | undefined
  >(undefined);
  const [availableRegions, setAvailableRegions] = useState<MemoryRegion[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("hex");
  const [liveUpdate, setLiveUpdate] = useState<boolean>(true);
  const [memoryChunks, setMemoryChunks] = useState<Map<number, Uint8Array>>(
    new Map(),
  );
  const [addressInput, setAddressInput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [scrollResetTrigger, setScrollResetTrigger] = useState<number>(0);
  const [scrollOffsetDelta, setScrollOffsetDelta] = useState<number>(0);
  const [dereferencePointer, setDereferencePointer] = useState<boolean>(false);
  const [suggestions, setSuggestions] = useState<
    Array<{ label: string; address: string; description?: string }>
  >([]);

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
          const addressChanged =
            pendingUpdate.baseAddress !== baseAddressRef.current;

          if (addressChanged) {
            console.log(
              `Address changed from ${baseAddressRef.current} to ${pendingUpdate.baseAddress} - clearing chunks`,
            );
            setBaseAddress(pendingUpdate.baseAddress);
            setSymbolLength(pendingUpdate.symbolLength);
            setMemoryChunks(new Map());
            // If preserveOffset is set, pass it to HexDump to adjust scroll
            if (pendingUpdate.preserveOffset !== undefined) {
              setScrollOffsetDelta(pendingUpdate.preserveOffset);
            }
          } else {
            // Same address re-submitted - just trigger scroll reset
            console.log(`Same address re-submitted - triggering scroll reset`);
            setScrollResetTrigger((prev) => prev + 1);
          }
        }
        if (pendingUpdate.memoryRange !== undefined) {
          setMemoryRange(pendingUpdate.memoryRange);
        }
        if (pendingUpdate.currentRegionStart !== undefined) {
          setCurrentRegionStart(pendingUpdate.currentRegionStart);
        }
        if (pendingUpdate.availableRegions !== undefined) {
          setAvailableRegions(pendingUpdate.availableRegions);
        }
        if (pendingUpdate.symbols !== undefined) {
          setSymbols(pendingUpdate.symbols);
        }
        if (pendingUpdate.symbolLengths !== undefined) {
          setSymbolLengths(pendingUpdate.symbolLengths);
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
      } else if (message.command === "symbolSuggestions") {
        setSuggestions(message.suggestions || []);
      } else if (message.command === "memoryData") {
        const memData = message as MemoryDataMessage;
        console.log(
          `Received chunk: offset=${memData.offset}, baseAddress=${memData.baseAddress}, current=${baseAddressRef.current}`,
        );
        // Only update if data is for current base address
        if (memData.baseAddress === baseAddressRef.current) {
          setMemoryChunks((prev) => {
            const next = new Map(prev);
            next.set(memData.offset, new Uint8Array(memData.data));
            console.log(
              `Added chunk at offset ${memData.offset}, total chunks: ${next.size}`,
            );
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

  // Downshift combobox for autocomplete
  const {
    isOpen,
    getMenuProps,
    getInputProps,
    highlightedIndex,
    getItemProps,
  } = useCombobox({
    items: suggestions,
    itemToString: (item) => (item ? item.label : ""),
    inputValue: addressInput,
    onInputValueChange: ({ inputValue }) => {
      // Update local state
      setAddressInput(inputValue || "");

      // Request suggestions as user types
      if (inputValue && inputValue.length > 0) {
        vscode.postMessage({
          command: "getSymbolSuggestions",
          query: inputValue,
        });
      } else {
        setSuggestions([]);
      }
    },
    onSelectedItemChange: ({ selectedItem }) => {
      if (selectedItem) {
        const addressToUse = selectedItem.label;
        setAddressInput(addressToUse);
        vscode.postMessage({
          command: "changeAddress",
          addressInput: addressToUse,
          dereferencePointer,
          resetScroll: true,
        });
      }
    },
  });

  const goToAddress = () => {
    vscode.postMessage({
      command: "changeAddress",
      addressInput,
      dereferencePointer,
      resetScroll: true,
    });
  };

  // Custom key handler for "Go" button behavior
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToAddress();
    }
  };

  const toggleLiveUpdate: React.FormEventHandler<VscodeCheckbox> = (e) => {
    const enabled = (e.target as HTMLInputElement).checked || false;
    setLiveUpdate(enabled);
    vscode.postMessage({
      command: "toggleLiveUpdate",
      enabled,
      dereferencePointer,
    });
  };

  const requestMemory = (offset: number, count: number) => {
    vscode.postMessage({
      command: "requestMemory",
      offset,
      count,
    });
  };

  const handleRegionChange: React.FormEventHandler<HTMLSelectElement> = (e) => {
    const addressValue = Number((e.target as HTMLSelectElement).value);
    const addressInput = formatHex(addressValue);
    setAddressInput(addressInput);
    vscode.postMessage({
      command: "changeAddress",
      addressInput: addressInput,
    });
  };

  return (
    <div className="memory-viewer">
      <div className="address-input">
        <vscode-label htmlFor="address">Address:</vscode-label>
        <div className="autocomplete-container">
          <input
            {...getInputProps({
              id: "address",
              placeholder: "Type symbol name, address or expression...",
              onKeyDown: handleInputKeyDown,
            })}
            className="address-textfield"
            autoFocus
          />
          <ul {...getMenuProps()} className="autocomplete-dropdown">
            {isOpen &&
              suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.label}
                  {...getItemProps({ item: suggestion, index })}
                  className={`autocomplete-item ${highlightedIndex === index ? "selected" : ""}`}
                >
                  <span className="suggestion-label">{suggestion.label}</span>
                  <span className="suggestion-address">
                    {suggestion.address}
                  </span>
                  {suggestion.description && (
                    <span className="suggestion-description">
                      {suggestion.description}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </div>
        <vscode-button onClick={goToAddress}>Go</vscode-button>
      </div>

      {error ? <div className="error">{error}</div> : ""}

      <div className="live-update-container">
        <vscode-checkbox checked={liveUpdate} onChange={toggleLiveUpdate}>
          Live Update
        </vscode-checkbox>{" "}
        <vscode-checkbox
          checked={dereferencePointer}
          onChange={(e: React.FormEvent) => {
            const checked = (e.target as HTMLInputElement).checked;
            setDereferencePointer(checked);
            // Trigger update when checkbox changes
            vscode.postMessage({
              command: "changeAddress",
              addressInput,
              dereferencePointer: checked,
              resetScroll: true,
            });
          }}
        >
          Dereference pointer
        </vscode-checkbox>
      </div>

      {availableRegions.length > 0 && (
        <div className="region-selector">
          <vscode-label htmlFor="region">Region:</vscode-label>
          <select
            id="region"
            value={currentRegionStart}
            onChange={handleRegionChange}
            className="region-dropdown"
          >
            <option>Select memory region</option>
            {availableRegions.map((region) => (
              <option key={region.address} value={region.address}>
                {region.name} ({formatHex(region.address)} -{" "}
                {formatHex(region.address + region.size - 1)})
              </option>
            ))}
          </select>
        </div>
      )}

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
            {viewMode === "hex" && baseAddress !== undefined && (
              <HexDump
                baseAddress={baseAddress}
                symbolLength={symbolLength}
                symbols={symbols}
                symbolLengths={symbolLengths}
                memoryRange={memoryRange}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
                scrollOffsetDelta={scrollOffsetDelta}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "visual" && baseAddress !== undefined && (
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
