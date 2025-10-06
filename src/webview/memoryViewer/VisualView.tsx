import React, { useState, useRef, useEffect } from "react";

export interface VisualViewProps {
  memoryData: Uint8Array;
  currentAddress: number;
}

export function VisualView({ memoryData, currentAddress }: VisualViewProps) {
  const [bytesPerRow, setBytesPerRow] = useState<number>(40); // Default 40 bytes = 320 pixels
  const [scale, setScale] = useState<number>(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const pixelsPerByte = 8;
  const pixelWidth = bytesPerRow * pixelsPerByte;
  const totalRows = Math.ceil(memoryData.length / bytesPerRow);

  // Render bitmap
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get colors from theme
    const styles = getComputedStyle(document.documentElement);
    const foregroundColor = styles.getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4';
    const backgroundColor = styles.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';

    // Set canvas size
    canvas.width = pixelWidth * scale;
    canvas.height = totalRows * scale;

    // Fill background
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw pixels
    ctx.fillStyle = foregroundColor;

    let pixelX = 0;
    let pixelY = 0;

    for (let i = 0; i < memoryData.length; i++) {
      const byte = memoryData[i];

      // Draw 8 pixels for this byte (MSB first)
      for (let bit = 7; bit >= 0; bit--) {
        const isOn = (byte & (1 << bit)) !== 0;

        if (isOn) {
          ctx.fillRect(pixelX * scale, pixelY * scale, scale, scale);
        }

        pixelX++;
        if (pixelX >= pixelWidth) {
          pixelX = 0;
          pixelY++;
        }
      }
    }
  }, [memoryData, bytesPerRow, scale, pixelWidth, totalRows]);

  // Handle mouse move for showing pixel info
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / scale);
    const y = Math.floor((e.clientY - rect.top) / scale);

    // Calculate byte offset and bit position
    const byteOffset = Math.floor(y * bytesPerRow + x / 8);
    const bitPosition = 7 - (x % 8);

    if (byteOffset < memoryData.length) {
      const byte = memoryData[byteOffset];
      const isOn = (byte & (1 << bitPosition)) !== 0;
      const address = currentAddress + byteOffset;
      const addressHex = address.toString(16).toUpperCase().padStart(6, "0");
      const byteHex = byte.toString(16).toUpperCase().padStart(2, "0");

      setTooltip({
        x: e.clientX,
        y: e.clientY,
        text: `Pixel ${x},${y} | Byte 0x${byteHex} @ ${addressHex} | Bit ${bitPosition} = ${isOn ? 1 : 0}`
      });
    } else {
      setTooltip(null);
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  return (
    <div className="visualView" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="visual-controls" style={{ padding: '8px', display: 'flex', gap: '16px', alignItems: 'center' }}>
        <label>
          Width (bytes):
          <input
            type="number"
            min="1"
            max="256"
            value={bytesPerRow}
            onChange={(e) => setBytesPerRow(Math.max(1, parseInt(e.target.value) || 40))}
            style={{ marginLeft: '8px', width: '60px' }}
          />
          <span style={{ marginLeft: '8px', opacity: 0.7 }}>
            ({bytesPerRow * 8} pixels)
          </span>
        </label>

        <label>
          Scale:
          <select
            value={scale}
            onChange={(e) => setScale(parseInt(e.target.value))}
            style={{ marginLeft: '8px' }}
          >
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
            <option value="4">4x</option>
            <option value="5">5x</option>
          </select>
        </label>

        <div style={{ opacity: 0.7 }}>
          {pixelWidth} × {totalRows} pixels ({memoryData.length} bytes)
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          backgroundColor: 'var(--vscode-editor-background)'
        }}
      >
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{
            imageRendering: 'pixelated',
            cursor: 'crosshair'
          }}
        />
      </div>

      {tooltip && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 10,
            top: tooltip.y + 10,
            backgroundColor: '#1e1e1e',
            color: '#d4d4d4',
            border: '1px solid #454545',
            padding: '4px 8px',
            borderRadius: '3px',
            fontSize: '12px',
            fontFamily: 'monospace',
            pointerEvents: 'none',
            zIndex: 1000,
            whiteSpace: 'nowrap'
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
