import { DisplayState } from "../../shared/stateViewerTypes";
import "./ScreenGeometry.css";

interface ScreenGeometryProps {
  displayState: DisplayState;
}

const CANVAS_W = 510; // Maximum horizontal position
const CANVAS_H = 383; // Maximum vertical position

export function ScreenGeometry({ displayState }: ScreenGeometryProps) {
  const { diwstrt, diwstop, ddfstrt, ddfstop } = displayState;

  // Display window:

  const diwstrtVal = parseInt(diwstrt, 16);
  const diwStrtX = diwstrtVal & 0xff;
  const diwStrtY = (diwstrtVal >> 8) & 0xff;

  const diwstopVal = parseInt(diwstop, 16);
  const diwStopX = (diwstopVal & 0xff) + 0x100;
  let diwStopY = (diwstopVal >> 8) & 0xff;
  if ((diwStopY & 0x80) === 0) {
    // The VSTOP position is restricted to the lower half of the screen. This is
    // accomplished in the hardware by forcing the MSB of the stop position to be
    // the complement of the next MSB.
    diwStopY += 0x100;
  }

  // Convert display window coordinates to canvas coordinates
  const displayWidth = (diwStopX - diwStrtX);
  const displayHeight = (diwStopY - diwStrtY);

  // Data fetch window:

  // DDFSTART is in color clocks, so multiply by 2 to get pixel position
  // mask off the low bit as it's always ignored. ECS adds bit 1.
  const ddfStart = (parseInt(ddfstrt, 16) & 0xfe) * 2;

  // When HPOS==DDFSTOP it starts the final fetch cycle (i.e. DDFSTOP doesn't actually mean stop right now!)
  // This means we need to add 16 to the calculated pixel position on OCS/ECS, as it will fetch on more word.
  const ddfStop = (parseInt(ddfstop, 16) & 0xfe) * 2;

  // Convert DDF coordinates (these are in terms of color clocks)
  // DDF values are typically $38-$D0 for standard display
  const ddfWidth = (ddfStop - ddfStart);

  return (
    <div className="screen-geometry">
      <div className="geometry-canvas-container">
        <svg
          className="geometry-canvas"
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          style={{
            width: `${CANVAS_W}px`,
            height: `${CANVAS_H}px`,
            border: "1px solid var(--vscode-widget-border)",
          }}
        >
          {/* Full screen area */}
          <rect
            x="0"
            y="0"
            width={CANVAS_W}
            height={CANVAS_H}
            fill="#000000"
            strokeWidth={1}
          />
          {/* Typical PAL display area */}
          <rect
            x={0x81}
            y={0x2c}
            width={320}
            height={256}
            fill="#222222"
            stroke="none"
          />

          <line
            x1={ddfStart}
            y1={0}
            x2={ddfStart}
            y2={CANVAS_H}
            stroke="#ff8c00"
            strokeWidth="1"
            strokeDasharray="4,4"
          />
          <text
            x={ddfStart + 10}
            y={CANVAS_H - 10}
            fill="#ff8c00"
            fontSize="12"
          >
            DDFSTRT: {ddfStart}
          </text>

          <line
            x1={ddfStop}
            y={CANVAS_H - 10}
            x2={ddfStop}
            y2={CANVAS_H}
            stroke="#ff8c00"
            strokeWidth="1"
            strokeDasharray="4,4"
          />

          <text
            x={ddfStop - 10}
            y={10}
            fill="#ff8c00"
            fontSize="12"
            textAnchor="end"
          >
            DDFSTOP: {ddfStop}
          </text>

          {/* Display window (DIW) */}
          <rect
            x={diwStrtX}
            y={diwStrtY}
            width={displayWidth}
            height={displayHeight}
            stroke="none"
            fill="#0078d4"
            fillOpacity="0.7"
          />
          <text
            x={diwStrtX + 7}
            y={diwStrtY + 10}
            dominantBaseline="hanging"
            fontSize="12"
            fill="#fff"
            opacity={0.6}
          >
            ({diwStrtX},{diwStrtY})
          </text>

          <text
            x={diwStopX - 7}
            y={diwStopY - 10}
            fill="#fff"
            fontSize="12"
            textAnchor="end"
            opacity={0.6}
          >
            ({diwStopX},{diwStopY})
          </text>

          <text
            x={diwStrtX + displayWidth/2}
            y={diwStrtY + displayHeight/2}
            fill="#fff"
            fontSize="12"
            dominantBaseline="middle"
            textAnchor="middle"
          >
            DIW: {displayWidth}x{displayHeight}px
          </text>

          {/* Display data fetch window (DDF) */}
          <rect
            x={ddfStart+16}
            y={diwStrtY}
            width={ddfWidth+16}
            height={displayHeight}
            fill="none"
            stroke="#ff8c00"
            strokeWidth="1"
            strokeDasharray="4,4"
          />
          <text
            x={diwStrtX + displayWidth/2}
            y={diwStrtY + 10}
            fill="#ff8c00"
            fontSize="12"
            dominantBaseline="middle"
            textAnchor="middle"
          >
            DDF: {ddfWidth+16}px
          </text>
        </svg>
      </div>
    </div>
  );
}
