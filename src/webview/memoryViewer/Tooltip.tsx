import "./Tooltip.css";
import React from "react";

export interface TooltipProps {
  x: number;
  y: number;
  heading?: React.ReactNode;
  text: React.ReactNode;
}

export const Tooltip = (props: TooltipProps) => (
  <div
    className="tooltip"
    style={{
      left: props.x + 10,
      top: props.y + 10,
    }}
  >
    {props.heading && <div className="tooltip-heading">{props.heading}</div>}
    {props.text}
  </div>
);
