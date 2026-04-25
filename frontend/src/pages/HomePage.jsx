import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useThemeStore } from "../store/useThemeStore";
import { useAuthStore } from "../store/useAuthStore";
import axios from "axios";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import PromptInputDynamicGrow from "../components/ui/PromptInputDynamicGrow";
import TubesCursor from "../components/ui/TubesCursor";

export default function HomePage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useThemeStore();
  const { logout } = useAuthStore();
  const isDark = theme === "dark";

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // 🔥 fetch user projects
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const res = await axios.get(
          "http://localhost:5000/api/projects",
          { withCredentials: true }
        );
        setProjects(res.data);
      } catch (err) {
        console.error("Fetch Projects Error:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchProjects();
  }, []);

  // 🔥 create project
  const handleCreateProject = async (nextDescription) => {
    if (isCreating) return;

    const description = (nextDescription || "").trim();
    if (!description) {
      toast.error("Project name is required");
      return;
    }
    try {
      setIsCreating(true);
      const res = await axios.post(
        "http://localhost:5000/api/project",
        { description },
        { withCredentials: true }
      );

      navigate(`/project/${res.data.projectId}`);
    } catch (err) {
      console.error("Create Project Error:", err);
      toast.error(err?.response?.data?.error || "Failed to create project");
    } finally {
      setIsCreating(false);
    }
  };


  const handleEditProject = async (project) => {
    const nextDescription = window.prompt("Update project name", project.description);

    if (!nextDescription || nextDescription.trim() === project.description) return;

    try {
      await axios.put(
        `http://localhost:5000/api/project/${project._id}`,
        { description: nextDescription.trim() },
        { withCredentials: true }
      );

      setProjects(prev =>
        prev.map(item =>
          item._id === project._id
            ? { ...item, description: nextDescription.trim() }
            : item
        )
      );

      toast.success("Project updated");
    } catch (err) {
      console.error("Update Project Error:", err);
      toast.error(err?.response?.data?.error || "Failed to update project");
    }
  };

  const handleDeleteProject = async (project) => {
    const confirmDelete = window.confirm(`Delete "${project.description}"?`);

    if (!confirmDelete) return;

    try {
      await axios.delete(
        `http://localhost:5000/api/project/${project._id}`,
        { withCredentials: true }
      );

      setProjects(prev => prev.filter(item => item._id !== project._id));
      toast.success("Project deleted");
    } catch (err) {
      console.error("Delete Project Error:", err);
      toast.error(err?.response?.data?.error || "Failed to delete project");
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate("/auth");
  };

  return (
    <div className={`min-h-screen ${isDark ? "bg-[#212121] text-[#e5e5e5]" : "bg-[#f5f5f5] text-[#111]"}`}>
      
      {/* Content */}
      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-10">
        <div className="mb-2 flex justify-end gap-3">
          <button
            onClick={handleLogout}
            className={`rounded-lg px-4 py-2 text-xs font-semibold border transition ${
              isDark
                ? "border-white/10 text-red-300 hover:bg-white/10"
                : "border-black/10 text-red-600 hover:bg-black/5"
            }`}
          >
            Logout
          </button>

          <button
            onClick={toggleTheme}
            className={`rounded-lg px-4 py-2 text-xs font-semibold border transition ${
              isDark
                ? "border-white/10 hover:bg-white/10"
                : "border-black/10 hover:bg-black/5"
            }`}
          >
            {isDark ? "Light" : "Dark"}
          </button>
        </div>

        <TubesCursor className={isDark ? "opacity-40" : "opacity-25"} />
        
        <div className="mb-6" />

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mb-6"
        >
          <div className="mx-auto w-full max-w-4xl text-center">
            <h2 className={`hero-display text-4xl font-semibold leading-[1.18] sm:text-5xl lg:text-6xl ${isDark ? "text-white" : "text-[#111]"}`}>
              <span className="block">Your</span>
              <span className="block">AI</span>
              <span className="block">Companion</span>
              <span className="block">for</span>
              <span className="block">Hardware</span>
            </h2>
          </div>
        </motion.div>

        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="relative mb-12"
        >
          <div className="relative z-10 mx-auto w-full max-w-4xl">
            <PromptInputDynamicGrow
              placeholder="e.g. Smart garden monitor with ESP32"
              disabled={isCreating}
              tone={isDark ? "shader" : "default"}
              onSubmit={(value) => handleCreateProject(value || "My new project")}
            />
          </div>
        </motion.section>

        <div className="mb-6">
          <h3 className="text-xl font-semibold">My Projects</h3>
          <p className={`mt-1 text-sm ${isDark ? "text-[#d2d6f0]" : "text-[#555]"}`}>
            Continue where you left off.
          </p>
        </div>

        <div className="mb-8 grid gap-4 sm:grid-cols-2">
          {[
            { label: "Open", text: "Jump into a project to continue the conversation." },
            { label: "Manage", text: "Rename or remove a project from its card." },
          ].map((item) => (
            <div
              key={item.label}
              className={`rounded-xl border p-4 ${
                isDark
                  ? "border-[#5b4fc0]/55 bg-[#171327]/90 backdrop-blur-md shadow-[0_8px_24px_rgba(10,10,22,0.45)]"
                  : "border-black/10 bg-white"
              }`}
            >
              <p className="text-sm font-semibold">{item.label}</p>
              <p className={`mt-2 text-sm ${isDark ? "text-[#d2d6f0]" : "text-[#555]"}`}>
                {item.text}
              </p>
            </div>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <p className="text-sm text-center">Loading projects...</p>
        )}

        {/* Projects Grid */}
        {!loading && projects.length > 0 && (
          <div className="grid gap-6 sm:grid-cols-2">
            {projects.map((p) => (
              <div
                key={p._id}
                className={`rounded-2xl border p-6 text-left transition ${
                  isDark
                    ? "bg-[#161225]/92 border-[#5b4fc0]/55 backdrop-blur-md shadow-[0_10px_28px_rgba(10,10,22,0.5)] hover:bg-[#201936]"
                    : "bg-white border-black/10 hover:bg-[#f0f0f0]"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className={`text-xs font-semibold uppercase tracking-[0.2em] ${isDark ? "text-[#d2d6f0]" : "text-[#666]"}`}>
                      Project
                    </p>
                    <h2 className={`mt-2 text-lg font-semibold ${isDark ? "text-[#e5e5e5]" : "text-[#111]"}`}>
                      {p.description}
                    </h2>
                    <p className={`mt-3 text-sm ${isDark ? "text-[#d2d6f0]" : "text-[#555]"}`}>
                      Created: {new Date(p.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => navigate(`/project/${p._id}`)}
                    className={`rounded-full px-4 py-2 text-xs font-semibold transition ${
                      isDark
                        ? "bg-white text-[#111] hover:bg-[#e8e8e8]"
                        : "bg-black text-white hover:bg-[#222]"
                    }`}
                  >
                    Open
                  </button>
                </div>

                <div className={`mt-5 flex flex-wrap gap-2 border-t pt-4 ${isDark ? "border-[#5b4fc0]/45" : "border-black/10"}`}>
                  <button
                    type="button"
                    onClick={() => handleEditProject(p)}
                    className={`rounded-full px-4 py-2 text-xs font-semibold transition ${
                      isDark
                        ? "border border-[#5a618f] bg-[#2b3150] text-[#eef0ff] hover:bg-[#383f63]"
                        : "border border-black/10 bg-white hover:bg-[#f0f0f0]"
                    }`}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteProject(p)}
                    className={`rounded-full px-4 py-2 text-xs font-semibold transition ${
                      isDark
                        ? "border border-red-500/30 text-red-300 hover:bg-red-500/10"
                        : "border border-red-200 text-red-600 hover:bg-red-50"
                    }`}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty */}
        {!loading && projects.length === 0 && (
          <div className={`mt-16 rounded-2xl border p-8 text-center text-sm ${
            isDark ? "border-[#4d5280] bg-[#1d2132] text-[#d2d6f0]" : "border-black/10 bg-white text-[#666]"
          }`}>
            <p className="text-base font-semibold">No projects yet</p>
            <p className="mt-2">Use the chat box above to create your first workspace.</p>
          </div>
        )}
      </div>
    </div>
  );
}
