import { useLayoutEffect, useRef } from "react";
import iconSource from "../../../../resources/icons/app.svg?raw";
import iconUrl from "../../../../resources/icons/app.svg?url";
import { startupLettering } from "./startup_lettering.ts";

const drawingWidth = 380;
const lines = [
  { text: "Welcome to", className: "startup-greeting", y: 5, scale: 0.72 },
  { text: "Dai Studio", className: "startup-name", y: 66, scale: 1 },
].map((line) => ({ ...line, ...startupLettering(line.text) }));

// Use the installed app icon's geometry for the drawing and its original asset for the final fill.
const icon = new DOMParser().parseFromString(iconSource, "image/svg+xml").documentElement;
const tile = icon.querySelector("rect");
const mark = icon.querySelector("path");
const tileBounds = {
  x: tile?.getAttribute("x") ?? undefined,
  y: tile?.getAttribute("y") ?? undefined,
  width: tile?.getAttribute("width") ?? undefined,
  height: tile?.getAttribute("height") ?? undefined,
  rx: tile?.getAttribute("rx") ?? undefined,
};
const markStrokes = mark?.getAttribute("d")?.split(/(?=M)/).filter(Boolean) ?? [];

function drawStrokes(paths: NodeListOf<SVGGeometryElement>, start: number, duration: number) {
  const strokes = Array.from(paths, (path) => ({ path, length: path.getTotalLength() }));
  const totalLength = strokes.reduce((sum, stroke) => sum + stroke.length, 0) || 1;
  const lift = 16;
  const minimum = 22;
  const drawingTime = duration - paths.length * (lift + minimum);
  let delay = start;
  return strokes.map(({ path, length }) => {
    const time = minimum + (drawingTime * length) / totalLength;
    const animation = path.animate([{ strokeDashoffset: "1.01" }, { strokeDashoffset: "0" }], {
      delay,
      duration: time,
      fill: "forwards",
      easing: "linear",
    });
    delay += time + lift;
    return animation;
  });
}

export function StartupIntro({ onComplete }: { onComplete: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const overlay = panel.current;
    const drawing = overlay?.querySelector(".startup-logo-outline");
    const fill = overlay?.querySelector(".startup-logo-fill");
    if (!overlay || !drawing || !fill) return;

    const writingStart = 80;
    const writingTime = 1750;
    const iconStart = writingStart + writingTime + 80;
    const iconTime = 540;
    const logoFill = iconStart + iconTime;
    const exitStart = logoFill + 250;
    const exitTime = 290;
    const crossfade = { delay: logoFill, duration: 140, fill: "forwards" } as const;
    const animations = [
      ...drawStrokes(
        overlay.querySelectorAll<SVGPathElement>(".startup-writing path"),
        writingStart,
        writingTime,
      ),
      ...drawStrokes(
        drawing.querySelectorAll<SVGGeometryElement>("rect, path"),
        iconStart,
        iconTime,
      ),
      drawing.animate([{ opacity: 1 }, { opacity: 0 }], crossfade),
      fill.animate([{ opacity: 0 }, { opacity: 1 }], crossfade),
    ];
    const exit = overlay.animate(
      [
        { opacity: 1, clipPath: "inset(0 round 0)" },
        { opacity: 0, clipPath: "inset(5% 4% round 20px)" },
      ],
      { delay: exitStart, duration: exitTime, fill: "forwards", easing: "ease-in-out" },
    );
    exit.onfinish = onComplete;
    const timeout = window.setTimeout(onComplete, exitStart + exitTime + 400);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    function motionChanged(event: MediaQueryListEvent) {
      if (event.matches) onComplete();
    }
    motion.addEventListener("change", motionChanged);
    return () => {
      motion.removeEventListener("change", motionChanged);
      window.clearTimeout(timeout);
      exit.onfinish = null;
      exit.cancel();
      for (const animation of animations) animation.cancel();
    };
  }, [onComplete]);

  return (
    <div className="startup-intro" ref={panel}>
      <h1 className="startup-intro-title" lang="en">
        {lines.map(({ text }) => text).join(" ")}
      </h1>
      <div className="startup-signature" aria-hidden="true">
        <svg className="startup-writing" viewBox={`0 0 ${drawingWidth} 140`} aria-hidden="true">
          {lines.map(({ text, className, width, scale, y, strokes }) => (
            <g
              key={text}
              className={className}
              transform={`translate(${(drawingWidth - width * scale) / 2} ${y}) scale(${scale})`}
            >
              {strokes.map(({ d, x, word }) => (
                <path
                  key={`${x}-${d}`}
                  data-word={word}
                  d={d}
                  transform={`translate(${x} 0)`}
                  pathLength={1}
                />
              ))}
            </g>
          ))}
        </svg>
        <svg
          className="startup-logo"
          viewBox={icon.getAttribute("viewBox") ?? "0 0 1024 1024"}
          aria-hidden="true"
        >
          <g className="startup-logo-outline">
            {tile && <rect {...tileBounds} pathLength={1} />}
            <g transform={mark?.getAttribute("transform") ?? undefined}>
              {markStrokes.map((d) => (
                <path key={d} d={d} pathLength={1} />
              ))}
            </g>
          </g>
          <image className="startup-logo-fill" href={iconUrl} width="100%" height="100%" />
        </svg>
      </div>
    </div>
  );
}
