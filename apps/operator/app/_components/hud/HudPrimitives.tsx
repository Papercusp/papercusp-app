type ClassyProps = {
  className?: string;
};

type HudRingGlyphProps = ClassyProps & {
  spokes?: number;
  radius?: number;
  innerRadius?: number;
  withCrosshair?: boolean;
};

type HudReticleGlyphProps = ClassyProps & {
  size?: number;
};

type HudTelemetryMarqueeProps = ClassyProps & {
  segments: string[];
};

function cx(...parts: Array<string | undefined | false | null>) {
  return parts.filter(Boolean).join(' ');
}

export function HudFrameCorners({ className }: ClassyProps) {
  return (
    <span className={cx('hud-frame-corners', className)} aria-hidden="true">
      <span className="hud-frame-corners__corner hud-frame-corners__corner--tl" />
      <span className="hud-frame-corners__corner hud-frame-corners__corner--tr" />
      <span className="hud-frame-corners__corner hud-frame-corners__corner--br" />
      <span className="hud-frame-corners__corner hud-frame-corners__corner--bl" />
    </span>
  );
}

export function HudRingGlyph({
  className,
  spokes = 12,
  radius = 46,
  innerRadius = 24,
  withCrosshair = false,
}: HudRingGlyphProps) {
  const centre = 60;
  const lines = Array.from({ length: spokes }, (_, index) => {
    const angle = (Math.PI * 2 * index) / spokes;
    const outer = radius + 8;
    const inner = radius - 8;
    const x1 = centre + Math.cos(angle) * inner;
    const y1 = centre + Math.sin(angle) * inner;
    const x2 = centre + Math.cos(angle) * outer;
    const y2 = centre + Math.sin(angle) * outer;
    return { x1, y1, x2, y2, key: index };
  });

  return (
    <svg viewBox="0 0 120 120" className={cx('hud-ring-glyph', className)} aria-hidden="true">
      <circle className="hud-ring-glyph__orbit" cx={centre} cy={centre} r={radius} />
      <circle className="hud-ring-glyph__inner" cx={centre} cy={centre} r={innerRadius} />
      <circle className="hud-ring-glyph__pulse" cx={centre} cy={centre} r={radius - 14} />
      {lines.map((line) => (
        <line
          key={line.key}
          className="hud-ring-glyph__spoke"
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
        />
      ))}
      {withCrosshair && (
        <>
          <line className="hud-ring-glyph__crosshair" x1={centre} y1={8} x2={centre} y2={26} />
          <line className="hud-ring-glyph__crosshair" x1={centre} y1={94} x2={centre} y2={112} />
          <line className="hud-ring-glyph__crosshair" x1={8} y1={centre} x2={26} y2={centre} />
          <line className="hud-ring-glyph__crosshair" x1={94} y1={centre} x2={112} y2={centre} />
        </>
      )}
    </svg>
  );
}

export function HudReticleGlyph({ className, size = 84 }: HudReticleGlyphProps) {
  const max = size;
  const edge = size * 0.24;
  const inner = size * 0.36;
  const mid = max / 2;

  return (
    <svg viewBox={`0 0 ${max} ${max}`} className={cx('hud-reticle-glyph', className)} aria-hidden="true">
      <path className="hud-reticle-glyph__frame" d={`M1 ${edge} V1 H${edge}`} />
      <path className="hud-reticle-glyph__frame" d={`M${max - edge} 1 H${max - 1} V${edge}`} />
      <path className="hud-reticle-glyph__frame" d={`M${max - 1} ${max - edge} V${max - 1} H${max - edge}`} />
      <path className="hud-reticle-glyph__frame" d={`M${edge} ${max - 1} H1 V${max - edge}`} />
      <circle className="hud-reticle-glyph__halo" cx={mid} cy={mid} r={inner} />
      <circle className="hud-reticle-glyph__core" cx={mid} cy={mid} r={size * 0.08} />
      <line className="hud-reticle-glyph__axis" x1={mid} y1={size * 0.14} x2={mid} y2={size * 0.3} />
      <line className="hud-reticle-glyph__axis" x1={mid} y1={size * 0.7} x2={mid} y2={size * 0.86} />
      <line className="hud-reticle-glyph__axis" x1={size * 0.14} y1={mid} x2={size * 0.3} y2={mid} />
      <line className="hud-reticle-glyph__axis" x1={size * 0.7} y1={mid} x2={size * 0.86} y2={mid} />
    </svg>
  );
}

export function HudTelemetryMarquee({ className, segments }: HudTelemetryMarqueeProps) {
  return (
    <div className={cx('hud-telemetry-marquee', className)} aria-hidden="true">
      {[0, 1].map((track) => (
        <div key={track} className="hud-telemetry-marquee__track">
          {segments.map((segment, index) => (
            <span key={`${track}:${segment}:${index}`} className="hud-telemetry-marquee__segment">
              {segment}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
