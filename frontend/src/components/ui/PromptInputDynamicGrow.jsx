import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const defaultMenuOptions = [];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function GlowEffects({ glowIntensity, mousePosition, animationDuration, enabled }) {
  if (!enabled) return null;

  return (
    <>
      <div className="absolute inset-0 rounded-3xl bg-gradient-to-r from-white/8 via-white/12 to-white/8 backdrop-blur-2xl" />
      <div
        className="absolute inset-0 rounded-3xl opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        style={{
          transitionDuration: `${animationDuration}ms`,
          boxShadow: `
            0 0 0 1px rgba(147, 51, 234, ${0.2 * glowIntensity}),
            0 0 8px rgba(147, 51, 234, ${0.3 * glowIntensity}),
            0 0 16px rgba(236, 72, 153, ${0.2 * glowIntensity}),
            0 0 24px rgba(59, 130, 246, ${0.15 * glowIntensity})
          `,
          filter: "blur(0.5px)",
        }}
      />
      <div
        className="absolute inset-0 rounded-3xl opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          transitionDuration: `${animationDuration}ms`,
          boxShadow: `
            0 0 12px rgba(147, 51, 234, ${0.4 * glowIntensity}),
            0 0 20px rgba(236, 72, 153, ${0.25 * glowIntensity}),
            0 0 32px rgba(59, 130, 246, ${0.2 * glowIntensity})
          `,
          filter: "blur(1px)",
        }}
      />
      <div
        className="absolute inset-0 rounded-3xl opacity-0 transition-opacity group-hover:opacity-20"
        style={{
          background: `radial-gradient(circle 120px at ${mousePosition.x}% ${mousePosition.y}%, rgba(147,51,234,0.08) 0%, rgba(236,72,153,0.05) 30%, rgba(59,130,246,0.04) 60%, transparent 100%)`,
        }}
      />
      <div className="absolute inset-0 rounded-3xl opacity-0 transition-opacity group-hover:opacity-30 overflow-hidden blur-sm">
        <div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-purple-400/8 to-transparent -translate-x-full group-hover:translate-x-full"
          style={{
            transitionProperty: "transform",
            transitionDuration: `${animationDuration * 2}ms`,
            transitionTimingFunction: "ease-out",
          }}
        />
      </div>
      <div
        className="absolute inset-0 rounded-3xl opacity-0 transition-opacity animate-pulse blur-sm group-hover:opacity-25"
        style={{ transitionDuration: `${animationDuration}ms` }}
      />
      <div className="absolute inset-0 rounded-3xl opacity-0 transition-opacity group-hover:opacity-15 group-focus-within:opacity-10 bg-gradient-to-r from-purple-400/5 via-pink-400/5 to-blue-400/5 blur-sm" />
    </>
  );
}

function RippleEffects({ ripples, enabled }) {
  if (!enabled || ripples.length === 0) return null;

  return (
    <>
      {ripples.map((ripple) => (
        <div
          key={ripple.id}
          className="absolute pointer-events-none blur-sm"
          style={{
            left: ripple.x - 25,
            top: ripple.y - 25,
            width: 50,
            height: 50,
          }}
        >
          <div className="h-full w-full rounded-full bg-gradient-to-r from-purple-400/15 via-pink-400/10 to-blue-400/15 animate-ping" />
        </div>
      ))}
    </>
  );
}

function SendButton({ isDisabled }) {
  return (
    <button
      type="submit"
      aria-label="Send message"
      disabled={isDisabled}
      className={`ml-auto h-9 w-9 shrink-0 rounded-full transition-all ${
        isDisabled
          ? "opacity-40 cursor-not-allowed bg-gray-400 text-white/60"
          : "opacity-90 bg-[#0A1217] text-white hover:opacity-100 hover:shadow-lg"
      }`}
    >
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`mx-auto block ${isDisabled ? "opacity-50" : "opacity-100"}`}
      >
        <path
          d="M16 22L16 10M16 10L11 15M16 10L21 15"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export default function PromptInputDynamicGrow({
  placeholder = "What do you want to build?",
  onSubmit,
  disabled = false,
  glowIntensity = 0.4,
  expandOnFocus = true,
  animationDuration = 500,
  backgroundOpacity = 0.12,
  showEffects = true,
  maxRows = 4,
  helperText = "Press Enter to start",
  submitLabel = "Get started",
  tone = "shader",
}) {
  const [value, setValue] = useState("");
  const [ripples, setRipples] = useState([]);
  const [mousePosition, setMousePosition] = useState({ x: 50, y: 50 });

  const containerRef = useRef(null);
  const textareaRef = useRef(null);
  const throttleRef = useRef(null);

  const isSubmitDisabled = disabled || !value.trim();
  const baseWidthClass = "w-full";
  const focusWidthClass = expandOnFocus ? "focus-within:w-full" : "";

  const addRipple = useCallback(
    (x, y) => {
      if (!showEffects || ripples.length >= 5) return;
      const newRipple = { x, y, id: Date.now() };
      setRipples((prev) => [...prev, newRipple]);
      setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r.id !== newRipple.id));
      }, 600);
    },
    [ripples.length, showEffects]
  );

  const handleMouseMove = useCallback(
    (event) => {
      if (!showEffects) return;
      if (containerRef.current && !throttleRef.current) {
        throttleRef.current = window.setTimeout(() => {
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
            const x = ((event.clientX - rect.left) / rect.width) * 100;
            const y = ((event.clientY - rect.top) / rect.height) * 100;
            setMousePosition({ x, y });
          }
          throttleRef.current = null;
        }, 50);
      }
    },
    [showEffects]
  );

  const handleClick = useCallback(
    (event) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      addRipple(event.clientX - rect.left, event.clientY - rect.top);
    },
    [addRipple]
  );

  const handleSubmit = useCallback(
    (event) => {
      event.preventDefault();
      if (!value.trim() || !onSubmit || disabled) return;
      onSubmit(value.trim());
      setValue("");
    },
    [value, onSubmit, disabled]
  );

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSubmit(event);
      }
    },
    [handleSubmit]
  );

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    const scrollHeight = textareaRef.current.scrollHeight;
    const lineHeight = 22;
    const maxHeight = lineHeight * maxRows + 16;
    textareaRef.current.style.height = `${clamp(scrollHeight, lineHeight, maxHeight)}px`;
  }, [value, maxRows]);

  const isShaderTone = tone === "shader";

  const containerStyle = useMemo(() => ({
    backgroundColor: isShaderTone
      ? "rgba(24, 20, 42, 0.72)"
      : `rgba(255, 255, 255, ${backgroundOpacity})`,
    border: isShaderTone ? "1px solid rgba(131, 96, 255, 0.35)" : "1px solid rgba(255, 255, 255, 0.12)",
    transition: `all ${animationDuration}ms ease, box-shadow ${animationDuration}ms ease`,
    boxShadow: isShaderTone
      ? "0 0 0 1px rgba(90, 121, 255, 0.2), 0 12px 30px rgba(20, 16, 38, 0.55), inset 0 1px 0 rgba(255,255,255,0.04)"
      : "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
  }), [backgroundOpacity, animationDuration, isShaderTone]);

  return (
    <form
      onSubmit={handleSubmit}
      className={`relative mx-auto min-h-20 ${baseWidthClass} transition-all ease-out ${focusWidthClass}`}
      style={{
        transition: `transform ${animationDuration}ms, opacity 200ms, left 200ms, width ${animationDuration}ms`,
      }}
    >
      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        className="group relative flex w-full flex-col overflow-visible rounded-3xl p-4"
        style={containerStyle}
      >
        <GlowEffects
          glowIntensity={glowIntensity}
          mousePosition={mousePosition}
          animationDuration={animationDuration}
          enabled={showEffects}
        />
        <RippleEffects ripples={ripples} enabled={showEffects} />
        <div className="relative z-20 flex items-center gap-4">
          <div className="flex-1">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              aria-label="Message input"
              rows={1}
              disabled={disabled}
              className={`min-h-12 max-h-36 w-full resize-none bg-transparent px-4 py-2 text-base font-medium leading-[26px] outline-none ${
                isShaderTone
                  ? "text-[#f4f1ff] placeholder:text-[#b8b0d4]"
                  : "text-white/90 placeholder:text-white/55"
              }`}
            />
            <div className={`mt-2 px-4 text-xs font-medium ${isShaderTone ? "text-[#b9b2d2]" : "text-white/60"}`}>
              {helperText}
            </div>
          </div>
          <button
            type="submit"
            disabled={isSubmitDisabled}
            className={`shrink-0 rounded-2xl px-5 py-2.5 text-sm font-semibold transition ${
              isSubmitDisabled
                ? "cursor-not-allowed bg-[#4f4965]/70 text-[#b7b2c7]"
                : "bg-gradient-to-r from-[#6e63ff] to-[#8a56ff] text-white hover:from-[#7a70ff] hover:to-[#9a63ff]"
            }`}
          >
            {submitLabel}
            <span className="ml-2">→</span>
          </button>
        </div>
      </div>
    </form>
  );
}

export { defaultMenuOptions };
