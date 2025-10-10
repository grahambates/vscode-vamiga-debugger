export interface MemoryRange {
  address: number;
  size: number;
}
export interface MemoryRegion {
  name: string;
  range: MemoryRange;
}

export interface Suggestion {
  label: string;
  address: string;
  description?: string;
}

// Backend messages

export interface UpdateStateMessageProps {
  addressInput?: string;
  target?: MemoryRange;
  symbols?: Record<string, number>;
  symbolLengths?: Record<string, number>;
  availableRegions?: MemoryRegion[];
  liveUpdate?: boolean;
  error?: string | null;
}

export interface UpdateStateMessage extends UpdateStateMessageProps {
  command: "updateState";
}


export interface SuggestionsDataMessage {
  command: "suggestionsData";
  suggestions: Suggestion[];
}

export interface MemoryDataMessage {
  command: "memoryData";
  address: number;
  data: Uint8Array;
}

// Front end messages:

export interface ChangeAddressMessage {
  command: "changeAddress";
  addressInput: string;
  dereferencePointer: boolean;
}

export interface RequeestMemoryMessage {
  command: "requestMemory";
  address: number;
  size: number;
}

export interface ToggleLiveUpdateMessage {
  command: "toggleLiveUpdate";
  enabled: boolean;
}

export interface GetSuggestionsMessage {
  command: "getSuggestions";
  query: string;
  showAll?: boolean; // If true, ignore limit and return all symbols
}
