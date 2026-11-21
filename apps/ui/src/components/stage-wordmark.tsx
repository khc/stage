import { type CSSProperties, useState } from "react";

import logo from "../../../../assets/image.svg?no-inline";

const ease = "0.45 0 0.55 1";

// Shared by every filter; covers the artwork's viewBox plus room to drift.
const filterRegion = {
  filterUnits: "userSpaceOnUse",
  x: 200,
  y: 120,
  width: 1000,
  height: 480,
  colorInterpolationFilters: "sRGB",
} as const;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const sign = () => (Math.random() < 0.5 ? -1 : 1);

// Base drift per layer: x and y travel in px, seconds is one loop.
const droplets = [
  { layer: "left-droplet", x: 26, y: 34, seconds: 47 },
  { layer: "middle-droplet", x: 24, y: 28, seconds: 63 },
  { layer: "upper-droplet", x: 38, y: 26, seconds: 53 },
  { layer: "right-droplet", x: 28, y: 32, seconds: 71 },
  { layer: "bottom-droplet", x: 30, y: 34, seconds: 43 },
] as const;

// Each layer wanders its own way: random direction, reach, speed and start point.
function drift(x: number, y: number, seconds: number): CSSProperties {
  const duration = seconds * rand(0.8, 1.25);
  return {
    "--drift-x": `${x * sign() * rand(0.6, 1.3)}px`,
    "--drift-y": `${y * sign() * rand(0.6, 1.3)}px`,
    "--drift-duration": `${duration}s`,
    "--drift-delay": `${-duration * Math.random()}s`,
  } as CSSProperties;
}

// Morph a noise-displacement filter: the pattern's frequency and strength glide
// between random keyframes, so shapes flow into one another instead of scaling.
function morph(base: [number, number], strength: number, seconds: number) {
  const pick = () => [base[0] * rand(0.6, 1.6), base[1] * rand(0.6, 1.6)] as const;
  const frequencies = [base, pick(), pick(), pick(), base].map((f) => f.join(" "));
  const scales = [0.7, 1.3, 0.9, 1.2, 0.7].map((k) => String(strength * k));
  const splines = Array(4).fill(ease).join("; ");
  const timing = {
    calcMode: "spline",
    keySplines: splines,
    repeatCount: "indefinite",
  } as const;
  const begin = `${-Math.random() * seconds}s`;
  return {
    seed: Math.floor(rand(1, 1000)),
    frequency: {
      ...timing,
      values: frequencies.join("; "),
      dur: `${seconds * rand(0.9, 1.2)}s`,
      begin,
    },
    scale: { ...timing, values: scales.join("; "), dur: `${seconds * rand(0.7, 1)}s`, begin },
  };
}

function Warp({
  id,
  base,
  strength,
  seconds,
  octaves,
}: {
  id: string;
  base: [number, number];
  strength: number;
  seconds: number;
  octaves: number;
}) {
  const [warp] = useState(() => morph(base, strength, seconds));
  return (
    <filter id={id} {...filterRegion}>
      <feTurbulence
        type="fractalNoise"
        baseFrequency={base.join(" ")}
        numOctaves={octaves}
        seed={warp.seed}
        result="noise"
      >
        <animate attributeName="baseFrequency" {...warp.frequency} />
      </feTurbulence>
      <feDisplacementMap
        in="SourceGraphic"
        in2="noise"
        scale={strength}
        xChannelSelector="R"
        yChannelSelector="G"
      >
        <animate attributeName="scale" {...warp.scale} />
      </feDisplacementMap>
    </filter>
  );
}

// Blur, then sharpen the alpha: blobs that come close bridge and fuse, then
// pinch apart again. Colors pass through untouched; only the edge is re-cut.
function Goo({ id }: { id: string }) {
  return (
    <filter id={id} {...filterRegion}>
      <feGaussianBlur in="SourceGraphic" stdDeviation="7" />
      <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8.5" />
    </filter>
  );
}

// A soft halo in the page background color behind the wordmark: it dims the
// blobs under the letters so they stay legible, and fades out without an edge.
function Halo({ id, size, transparency }: { id: string; size: number; transparency: number }) {
  return (
    <filter id={id} {...filterRegion}>
      <feGaussianBlur in="SourceAlpha" stdDeviation={size} />
      <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 2.2 0" result="density" />
      <feFlood style={{ floodColor: "var(--background)" }} floodOpacity={1 - transparency} />
      <feComposite in2="density" operator="in" />
    </filter>
  );
}

type StageWordmarkProps = {
  /** Soft halo in the page background color behind "Stage". */
  glow?: boolean;
  /** Halo transparency: 0 is opaque, 1 is invisible. */
  glowTransparency?: number;
  /** Halo spread: blur radius in artwork units. */
  glowSize?: number;
  /** The "AGENTIC PLATFORM" line under the wordmark. */
  descriptor?: boolean;
};

export function StageWordmark({
  glow = true,
  glowTransparency = 0.5,
  glowSize = 10,
  descriptor = false,
}: StageWordmarkProps) {
  const [motion] = useState(
    () =>
      typeof matchMedia !== "function" || !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [ribbonDrift] = useState(() => drift(14, 10, 67));
  const [lowerDrift] = useState(() => drift(16, 18, 57));
  const [dropletDrifts] = useState(() => droplets.map((d) => drift(d.x, d.y, d.seconds)));

  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="264 170 848 374"
      className="stage-lava pointer-events-none block h-auto w-full"
    >
      {motion && (
        <defs>
          <Warp
            id="stage-lava-ribbons"
            base={[0.0055, 0.008]}
            strength={46}
            seconds={41}
            octaves={2}
          />
          <Warp
            id="stage-lava-droplets"
            base={[0.016, 0.02]}
            strength={20}
            seconds={29}
            octaves={2}
          />
          <Goo id="stage-lava-goo" />
        </defs>
      )}
      <g filter={motion ? "url(#stage-lava-goo)" : undefined}>
        <g filter={motion ? "url(#stage-lava-ribbons)" : undefined}>
          <g className="stage-lava-drift" style={ribbonDrift}>
            <use href={`${logo}#left-ribbons`} />
            <use href={`${logo}#lower-ribbons`} className="stage-lava-drift" style={lowerDrift} />
            <use href={`${logo}#right-ribbons`} />
          </g>
        </g>
        <g filter={motion ? "url(#stage-lava-droplets)" : undefined}>
          {droplets.map(({ layer }, i) => (
            <use
              key={layer}
              href={`${logo}#${layer}`}
              className="stage-lava-drift"
              style={dropletDrifts[i]}
            />
          ))}
        </g>
      </g>
      {glow && (
        <>
          <defs>
            <Halo id="stage-lava-halo" size={glowSize} transparency={glowTransparency} />
          </defs>
          <use href={`${logo}#wordmark`} filter="url(#stage-lava-halo)" />
        </>
      )}
      <g className="dark:invert">
        <use href={`${logo}#wordmark`} />
        {descriptor && <use href={`${logo}#tagline`} />}
      </g>
    </svg>
  );
}
