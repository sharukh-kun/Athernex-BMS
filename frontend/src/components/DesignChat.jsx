import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useThemeStore } from "../store/useThemeStore";
import ChatRichText from "./ChatRichText";

export default function DesignChat({
  project,
  wokwiContext,
  messages,
  input,
  setInput,
  loading,
  onSend,
  onDebug,
}) {
  const { theme } = useThemeStore();
  const isDark = theme === "dark";
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  return (
    <div className={`flex h-full flex-col ${isDark ? "bg-[#212121] text-[#e5e5e5]" : "bg-[#f5f5f5] text-[#111]"}`}>
      <div className={`border-b px-4 py-2 ${isDark ? "border-white/10" : "border-black/10"}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${isDark ? "text-[#a3a3a3]" : "text-[#666]"}`}>
              Design AI
            </p>
            <p className={`mt-1 text-[11px] ${wokwiContext?.connected ? "text-green-400" : (isDark ? "text-[#a3a3a3]" : "text-[#666]")}`}>
              {wokwiContext?.connected
                ? `Live circuit connected: ${wokwiContext?.partCount ?? 0} parts, ${wokwiContext?.connectionCount ?? 0} wires`
                : `Live circuit disconnected: ${wokwiContext?.reason || "No context"}`}
            </p>
          </div>

          <button
            onClick={onDebug}
            disabled={loading}
            className={`px-2 py-1 text-[11px] font-semibold transition ${isDark ? "text-[#e5e5e5] hover:text-white" : "text-[#111] hover:text-black"} ${loading ? "cursor-not-allowed opacity-60" : ""}`}
          >
            Debug
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <AnimatePresence>
          {messages.map((message, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={`mb-3 flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-[95%] ${message.role === "user" ? "text-right" : "text-left"}`}>
                <div className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${isDark ? "text-[#8f8f8f]" : "text-[#777]"}`}>
                  {message.role === "user" ? "You" : "Design AI"}
                </div>
                <div className={`${message.role === "user" ? (isDark ? "text-[#f2f2f2]" : "text-[#111]") : (isDark ? "text-[#e0e0e0]" : "text-[#222]")}`}>
                  <ChatRichText text={message.content} isDark={isDark} />
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {loading && (
          <div className="flex justify-start">
            <div className={`text-sm ${isDark ? "text-[#8f8f8f]" : "text-[#666]"}`}>
              Thinking...
            </div>
          </div>
        )}
      </div>

      <div className={`border-t p-3 ${isDark ? "border-white/10" : "border-black/10"}`}>
        <div className="flex items-center gap-2">
          <input
            className={`flex-1 border-b bg-transparent px-2 py-2 text-sm outline-none ${isDark ? "border-white/10 placeholder:text-[#777]" : "border-black/10 placeholder:text-[#999]"}`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onSend()}
            placeholder="Ask for design steps, debugging help, or Wokwi context..."
          />
          <button
            onClick={onSend}
            disabled={loading}
            className={`px-3 py-2 text-sm font-semibold transition ${isDark ? "text-[#e5e5e5] hover:text-white" : "text-[#111] hover:text-black"} ${loading ? "cursor-not-allowed opacity-60" : ""}`}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}