import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";

export default function CreateProjectModal({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
}) {
  const [projectName, setProjectName] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      setProjectName("");
      setError("");
      return;
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const handleSubmit = async () => {
    const value = projectName.trim();

    if (!value) {
      setError("Project name cannot be empty");
      inputRef.current?.focus();
      return;
    }

    setError("");
    await onSubmit(value);
  };

  const handleKeyDown = async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await handleSubmit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (!isSubmitting) {
        onClose();
      }
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onKeyDown={handleKeyDown}
        >
          <div
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            onClick={() => {
              if (!isSubmitting) {
                onClose();
              }
            }}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-project-title"
            className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#171717] p-6 text-[#f5f5f5] shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <h2 id="create-project-title" className="text-xl font-semibold">
              Create New Project
            </h2>

            <div className="mt-5">
              <input
                ref={inputRef}
                type="text"
                value={projectName}
                onChange={(event) => {
                  setProjectName(event.target.value);
                  if (error) setError("");
                }}
                placeholder="Enter project name"
                disabled={isSubmitting}
                className="w-full rounded-xl border border-white/10 bg-[#101010] px-4 py-2.5 text-sm text-[#f3f3f3] outline-none transition placeholder:text-[#7e7e7e] focus:border-white/25 focus:ring-2 focus:ring-white/10 disabled:cursor-not-allowed disabled:opacity-60"
              />
              {error && (
                <p className="mt-2 text-xs text-red-300">{error}</p>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="rounded-xl border border-white/12 bg-[#222] px-4 py-2 text-sm font-medium text-[#f3f3f3] transition hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#111] transition hover:bg-[#e9e9e9] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Creating..." : "Create"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
