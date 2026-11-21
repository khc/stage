import { type CSSProperties, useEffect, useRef } from "react";

import logo from "../../../../assets/image.svg?no-inline";

const droplets = [
  { layer: "left-droplet", x: 18, y: -25, seconds: 47 },
  { layer: "middle-droplet", x: -14, y: 19, seconds: 63 },
  { layer: "upper-droplet", x: -28, y: 17, seconds: 53 },
  { layer: "right-droplet", x: 17, y: -21, seconds: 71 },
  { layer: "bottom-droplet", x: 19, y: -22, seconds: 43 },
] as const;

function drift(x: number, y: number, seconds: number, stretch = 0.1): CSSProperties {
  return {
    "--drift-x": `${x}px`,
    "--drift-y": `${y}px`,
    "--drift-duration": `${seconds}s`,
    "--drift-scale": stretch,
  } as CSSProperties;
}

export function StageWordmark() {
  const artwork = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const layers = artwork.current?.querySelectorAll<SVGElement>(".stage-lava-drift");
    // Start each layer at a different point in its own loop.
    for (const layer of layers ?? []) {
      layer.style.setProperty("--drift-tempo", String(0.9 + Math.random() * 0.25));
      layer.style.setProperty("--drift-phase", String(-Math.random()));
    }
  }, []);

  return (
    <svg
      ref={artwork}
      aria-hidden
      focusable="false"
      viewBox="264 170 848 374"
      className="stage-lava pointer-events-none block h-auto w-full"
    >
      <g className="stage-lava-drift" style={drift(8, 6, 67, 0.02)}>
        <use href={`${logo}#left-ribbons`} />
        <use
          href={`${logo}#lower-ribbons`}
          className="stage-lava-drift"
          style={drift(9, -13, 57, 0.04)}
        />
        <use href={`${logo}#right-ribbons`} />
      </g>
      {droplets.map(({ layer, x, y, seconds }) => (
        <use
          key={layer}
          href={`${logo}#${layer}`}
          className="stage-lava-drift"
          style={drift(x, y, seconds)}
        />
      ))}
      <g className="dark:invert">
        <use href={`${logo}#wordmark`} />
        <use href={`${logo}#tagline`} />
      </g>
    </svg>
  );
}
