"use client";

import { useMemo, useState } from "react";

interface MiniAreaChartProps {
  data: { label: string; count: number }[];
  height?: number;
  color?: string;
  /**
   * R11: interactive drill-down — when provided, data points become clickable.
   * Clicking a point calls back with `{ label, count }`. The caller (dashboard)
   * uses this to jump to the Audit Log view so an operator can investigate a
   * spike in event volume. Cursor becomes `pointer` over the hit areas and
   * the clicked point gets a subtle ring highlight for visual feedback before
   * navigation unmounts the chart.
   */
  onPointClick?: (point: { label: string; count: number }) => void;
}

/**
 * Lightweight pure-SVG area chart — replaces Recharts to keep Turbopack
 * compilation memory low (Recharts was the heaviest dependency, causing OOM
 * on the 4GB sandbox). Supports hover tooltips via a simple mouse tracker.
 */
export function MiniAreaChart({
  data,
  height = 176,
  color = "#10b981",
  onPointClick,
}: MiniAreaChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // R11: tracks which point was clicked so we can render a persistent ring
  // highlight until the parent navigates away. Cleared on mouse-leave so a
  // returning hover state is fresh.
  const [clickedIdx, setClickedIdx] = useState<number | null>(null);
  const width = 600; // viewBox width; scales responsively via preserveAspectRatio
  // R10 Bug 4: padX increased from 40 → 44 so the Y-axis labels (e.g. 127, 95)
  // clear the left container edge with a comfortable margin. Labels are
  // rendered at x={padX - 6} → with padX=44 they sit at x=38 (was x=34), giving
  // 4 extra px of breathing room. Fixes the VLM-noted "too close to the edge"
  // clipping on high-magnitude tick values (3-digit counts).
  const padX = 44;
  const padY = 16; // R4: increased from 12 → 16 so X-axis labels don't clip
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const { pathD, areaD, points, maxVal, minVal } = useMemo(() => {
    if (data.length === 0) {
      return { pathD: "", areaD: "", points: [] as { x: number; y: number; val: number; label: string }[], maxVal: 0, minVal: 0 };
    }
    const vals = data.map((d) => d.count);
    const max = Math.max(...vals, 1);
    const min = Math.min(...vals, 0);
    const range = max - min || 1;
    const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;
    const pts = data.map((d, i) => ({
      x: padX + (data.length > 1 ? i * stepX : innerW / 2),
      y: padY + innerH - ((d.count - min) / range) * innerH,
      val: d.count,
      label: d.label,
    }));
    // Smooth monotone-ish path (simple line with slight curve)
    const linePath = pts
      .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
      .join(" ");
    const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${padY + innerH} L ${pts[0].x} ${padY + innerH} Z`;
    return { pathD: linePath, areaD: areaPath, points: pts, maxVal: max, minVal: min };
  }, [data, innerW, innerH, padX, padY]);

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-500">
        No activity in this window
      </div>
    );
  }

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(minVal + ((maxVal - minVal) * i) / yTicks));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      onMouseLeave={() => {
        setHoverIdx(null);
        setClickedIdx(null);
      }}
    >
      <defs>
        <linearGradient id="miniAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor={color} stopOpacity={0.5} />
          <stop offset="60%" stopColor={color} stopOpacity={0.2} />
          <stop offset="95%" stopColor={color} stopOpacity={0} />
        </linearGradient>
        {/* Subtle glow on the line stroke — creates a soft halo that reads as
            "illuminated" without re-introducing Recharts. */}
        <filter id="lineGlow" x="-10%" y="-20%" width="120%" height="140%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Y-axis grid + labels — extremely faint so data floats */}
      {tickVals.map((tv, i) => {
        const y = padY + innerH - (i / yTicks) * innerH;
        return (
          <g key={i}>
            <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} strokeDasharray="3 4" />
            <text x={padX - 6} y={y + 3} fill="#71717a" fontSize={9} textAnchor="end" fontFamily="monospace">
              {tv}
            </text>
          </g>
        );
      })}
      {/* R5 polish: horizontal baseline at the bottom of the chart area
          (y = padY + innerH). Brighter than the faint dashed gridlines
          (0.08 vs 0.04) so the data has a visible "floor". Solid (not dashed)
          so it reads as the primary axis. */}
      <line
        x1={padX}
        y1={padY + innerH}
        x2={width - padX}
        y2={padY + innerH}
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={1}
      />
      {/* X-axis labels (every other to avoid crowding). R4: y raised from
          `height - 2` → `height - 4` so labels sit a touch higher and never
          clip against the SVG bottom edge.
          R5: added subtle vertical tick marks (1px tall, rgba 0.06) above
          each visible label so the label visually connects to the baseline.
          Ticks sit just below the baseline, pointing down toward the label. */}
      {points.map((p, i) =>
        i % 2 === 0 || i === points.length - 1 ? (
          <g key={i}>
            <line
              x1={p.x}
              y1={padY + innerH}
              x2={p.x}
              y2={padY + innerH + 3}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={0.5}
            />
            <text x={p.x} y={height - 4} fill="#71717a" fontSize={8} textAnchor="middle" fontFamily="monospace">
              {p.label}
            </text>
          </g>
        ) : null,
      )}
      {/* Area fill */}
      <path d={areaD} fill="url(#miniAreaFill)" />
      {/* Line — with soft glow halo via SVG filter */}
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" filter="url(#lineGlow)" />
      {/* Points + hover */}
      {points.map((p, i) => {
        const isHovered = hoverIdx === i;
        const isClicked = clickedIdx === i;
        // R11: when onPointClick is provided, points are interactive — bigger
        // radius on hover, a persistent ring highlight on the clicked point,
        // and a pointer cursor over the hit area so users know they can click.
        const interactive = typeof onPointClick === "function";
        return (
          <g key={i}>
            {/* R11: clicked-point ring — a hollow circle slightly larger than
                the point that pulses gently via the vault-attention-pulse CSS
                animation, providing brief visual feedback before the parent
                navigates away (the chart unmounts on view switch). */}
            {interactive && isClicked && (
              <circle
                cx={p.x}
                cy={p.y}
                r={6}
                fill="none"
                stroke={color}
                strokeWidth={1}
                opacity={0.8}
              >
                <animate
                  attributeName="r"
                  values="5;7;5"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.9;0.4;0.9"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              </circle>
            )}
            <circle
              cx={p.x}
              cy={p.y}
              r={isHovered || isClicked ? 3.5 : 2}
              fill={color}
              opacity={isHovered || isClicked ? 1 : 0.6}
            />
            {/* Invisible hit area for hover + click */}
            <rect
              x={p.x - 12}
              y={0}
              width={24}
              height={height}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              onClick={
                interactive
                  ? () => {
                      setClickedIdx(i);
                      onPointClick!({ label: p.label, count: p.val });
                    }
                  : undefined
              }
              style={interactive ? { cursor: "pointer" } : undefined}
            />
          </g>
        );
      })}
      {/* Tooltip */}
      {hoverIdx !== null && points[hoverIdx] && (
        <g>
          <line
            x1={points[hoverIdx].x}
            y1={padY}
            x2={points[hoverIdx].x}
            y2={padY + innerH}
            stroke={color}
            strokeWidth={0.5}
            strokeDasharray="2 2"
            opacity={0.5}
          />
          <g transform={`translate(${Math.min(points[hoverIdx].x + 6, width - 70)}, ${Math.max(points[hoverIdx].y - 28, padY)})`}>
            <rect width={64} height={26} rx={4} fill="#18181b" stroke="#27272a" strokeWidth={0.5} />
            <text x={6} y={11} fill="#a1a1aa" fontSize={7} fontFamily="monospace">
              {points[hoverIdx].label}
            </text>
            <text x={6} y={21} fill={color} fontSize={9} fontWeight="bold" fontFamily="monospace">
              {points[hoverIdx].val} events
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
