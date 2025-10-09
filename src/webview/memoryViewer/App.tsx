import React, { useState, useEffect } from "react";
import "@vscode-elements/elements";
import { VscodeCheckbox } from "@vscode-elements/elements";
import { useCombobox } from "downshift";
import { HexDump } from "./HexDump";
import { VisualView } from "./VisualView";
import { CopperView } from "./CopperView";
import { DisassemblyView } from "./DisassemblyView";
import "./App.css";
import {
  GetSuggestionsMessage,
  MemoryDataMessage,
  MemoryRange,
  MemoryRegion,
  Suggestion,
  SuggestionsDataMessage,
  UpdateStateMessage,
} from "../../shared/memoryViewerTypes";

const vscode = acquireVsCodeApi();

function formatHex(value: number): string {
  return "0x" + value.toString(16).toUpperCase().padStart(8, "0");
}

export function App() {
  console.log('App component mounted/rendered');

  const [target, setTarget] = useState<MemoryRange | undefined>(undefined);
  const [symbols, setSymbols] = useState<Record<string, number>>({});
  const [symbolLengths, setSymbolLengths] = useState<Record<string, number>>({});
  const [availableRegions, setAvailableRegions] = useState<MemoryRegion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [addressInput, setAddressInput] = useState<string>("");
  const [dereferencePointer, setDereferencePointer] = useState(false);
  const [viewMode, setViewMode] = useState<"hex" | "visual" | "disassembly" | "copper">("hex");
  const [liveUpdate, setLiveUpdate] = useState<boolean>(false);
  const [selectedRegion, setSelectedRegion] = useState<
    MemoryRegion | undefined
  >();
  const [memoryChunks, setMemoryChunks] = useState<Map<number, Uint8Array>>(
    new Map(),
  );
  const [scrollResetTrigger, setScrollResetTrigger] = useState(0);

  // Send ready message on mount
  useEffect(() => {
    vscode.postMessage({ command: "ready" });
  }, []);

  // Listen for messages from extension
  useEffect(() => {
    let pendingUpdate: UpdateStateMessage | null = null;
    let rafScheduled = false;

    const applyPendingUpdate = () => {
      if (!pendingUpdate) {
        return;
      }
      if (pendingUpdate.addressInput !== undefined) {
        setAddressInput(pendingUpdate.addressInput);
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
      if (pendingUpdate.error !== undefined) {
        setError(pendingUpdate.error);
      }
      if (pendingUpdate.target !== undefined) {
        const targetAddress = pendingUpdate.target.address;
        const targetEnd = targetAddress + pendingUpdate.target.size;

        // find region for target
        const regions = pendingUpdate.availableRegions || availableRegions;
        const region = regions.find(({ range }) => {
          const regionEnd = range.address + range.size;
          return targetAddress >= range.address && targetEnd < regionEnd;
        });

        if (targetAddress !== target?.address) {
          // Target changed - clear chunks
          setMemoryChunks(new Map());
        } else {
          // Force scroll to target, even if unchanged
          setScrollResetTrigger((prev) => prev + 1);
        }

        setTarget(pendingUpdate.target);
        setSelectedRegion(region);
      }
      pendingUpdate = null;
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
      console.log('FE recieved message', message)

      if (message.command === "updateState") {
        // Store latest update and schedule (combining with any previous to handle optional props) to render on next frame
        pendingUpdate = {
          ...pendingUpdate,
          ...(message as UpdateStateMessage),
        };
        scheduleUpdate();
      } else if (message.command === "suggestionsData") {
        const suggestionsMessage = message as SuggestionsDataMessage;
        setSuggestions(suggestionsMessage.suggestions || []);
      } else if (message.command === "memoryData") {
        const memData = message as MemoryDataMessage;
        setMemoryChunks((prev) => {
          const next = new Map(prev);
          next.set(memData.address, memData.data);
          return next;
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [target, availableRegions]);

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
          command: "getSuggestions",
          query: inputValue,
        } as GetSuggestionsMessage);
      } else {
        setSuggestions([]);
      }
    },
    onSelectedItemChange: ({ selectedItem }) => {
      if (selectedItem) {
        const addressInput = selectedItem.label;
        setAddressInput(addressInput);
        vscode.postMessage({
          command: "changeAddress",
          addressInput,
          dereferencePointer,
        });
      }
    },
  });

  const goToAddress = () => {
    vscode.postMessage({
      command: "changeAddress",
      addressInput,
      dereferencePointer,
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

  const requestMemory = ({ address, size }: MemoryRange) => {
    console.log(`Requesting memory`, { address, size })
    vscode.postMessage({
      command: "requestMemory",
      address,
      size,
    });
  };

  const handleRegionChange: React.FormEventHandler<HTMLSelectElement> = (e) => {
    const addressValue = Number((e.target as HTMLSelectElement).value);
    const addressInput = formatHex(addressValue);
    setAddressInput(addressInput);
    vscode.postMessage({
      command: "changeAddress",
      addressInput,
      dereferencePointer
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

      <div className="options-container">
        <vscode-checkbox checked={liveUpdate} onChange={toggleLiveUpdate}>
          Live Update
        </vscode-checkbox>
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
            value={selectedRegion?.range.address}
            onChange={handleRegionChange}
            className="region-dropdown"
          >
            <option>Select memory region</option>
            {availableRegions.map(({ name, range }) => (
              <option key={range.address} value={range.address}>
                {name} ({formatHex(range.address)} -{" "}
                {formatHex(range.address + range.size - 1)})
              </option>
            ))}
          </select>
        </div>
      )}

      <vscode-divider></vscode-divider>

      {target !== undefined && selectedRegion ? (
        <vscode-tabs
          onvsc-tabs-select={(e) => {
            const modes = ["hex", "visual", "disassembly", "copper"] as const;
            setViewMode(modes[e.detail.selectedIndex]);
          }}
        >
          <vscode-tab-header>Hex Dump</vscode-tab-header>
          <vscode-tab-header>Visual</vscode-tab-header>
          <vscode-tab-header>Disassembly</vscode-tab-header>
          <vscode-tab-header>Copper</vscode-tab-header>

          <vscode-tab-panel>
            {viewMode === "hex" && (
              <HexDump
                target={target}
                range={selectedRegion?.range}
                symbols={symbols}
                symbolLengths={symbolLengths}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "visual" && (
              <VisualView
                target={target}
                range={selectedRegion?.range}
                symbols={symbols}
                symbolLengths={symbolLengths}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "disassembly" && (
              <DisassemblyView
                target={target}
                range={selectedRegion?.range}
                symbols={symbols}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
          <vscode-tab-panel>
            {viewMode === "copper" && (
              <CopperView
                target={target}
                range={selectedRegion?.range}
                symbols={symbols}
                symbolLengths={symbolLengths}
                memoryChunks={memoryChunks}
                onRequestMemory={requestMemory}
                scrollResetTrigger={scrollResetTrigger}
              />
            )}
          </vscode-tab-panel>
        </vscode-tabs>
      ) : (
        ""
      )}
    </div>
  );
}
