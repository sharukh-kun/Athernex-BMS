import { useEffect, useRef } from "react";

export default function TubesCursor({ className = "" }) {
  const canvasRef = useRef(null);
  const appRef = useRef(null);

  useEffect(() => {
    const initTimer = setTimeout(() => {
      import("https://cdn.jsdelivr.net/npm/threejs-components@0.0.19/build/cursors/tubes1.min.js")
        .then((module) => {
          const Tubes = module.default;

          if (canvasRef.current) {
            const app = Tubes(canvasRef.current, {
              tubes: {
                colors: ["#5e72e4", "#8965e0", "#f5365c"],
                lights: {
                  intensity: 200,
                  colors: ["#21d4fd", "#b721ff", "#f4d03f", "#11cdef"],
                },
              },
            });
            appRef.current = app;
          }
        })
        .catch((err) => console.error("Failed to load TubesCursor module:", err));
    }, 100);

    return () => {
      clearTimeout(initTimer);
      if (appRef.current && typeof appRef.current.dispose === "function") {
        appRef.current.dispose();
      }
    };
  }, []);

  return (
    <div className={`fixed inset-0 z-0 pointer-events-none ${className}`}>
      <canvas ref={canvasRef} className="fixed inset-0 h-full w-full" />
    </div>
  );
}
