import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useThemeStore } from "../store/useThemeStore";
import axios from "axios";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import CreateProjectModal from "../components/CreateProjectModal";

export default function HomePage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useThemeStore();
  const isDark = theme === "dark";

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

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
  const handleCreateProject = async (description) => {
    if (isCreating) return;

    try {
      setIsCreating(true);
      const res = await axios.post(
        "http://localhost:5000/api/project",
        { description },
        { withCredentials: true }
      );

      setIsCreateModalOpen(false);
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

  return (
    <div className={`min-h-screen ${isDark ? "bg-[#212121] text-[#e5e5e5]" : "bg-[#f5f5f5] text-[#111]"}`}>
      
      {/* Topbar */}
      <div className={`sticky top-0 z-50 border-b backdrop-blur-xl ${
        isDark ? "bg-[#2a2a2a]/80 border-white/10" : "bg-white/80 border-black/10"
      }`}>
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
          
          <p className="text-sm font-medium">Projects</p>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsCreateModalOpen(true)}
              disabled={isCreating}
              className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
                isDark
                  ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]"
                  : "bg-black text-white hover:bg-[#222]"
              } ${isCreating ? "opacity-60 cursor-not-allowed" : ""}`}
            >
              {isCreating ? "Creating..." : "+ New Project"}
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
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        
        <motion.header
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-10"
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className={`text-xs font-semibold uppercase tracking-[0.2em] ${isDark ? "text-[#a3a3a3]" : "text-[#666]"}`}>
                Project management
              </p>
              <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
                Your Projects
              </h1>
            </div>
            <div className={`rounded-xl border px-4 py-3 text-sm ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}>
              <p className="font-semibold">{projects.length} total projects</p>
              <p className={`mt-1 text-xs ${isDark ? "text-[#a3a3a3]" : "text-[#666]"}`}>
                Open, rename, or delete from here.
              </p>
            </div>
          </div>
          <p className={`mt-3 text-sm ${isDark ? "text-[#a3a3a3]" : "text-[#555]"}`}>
            Select a project to continue.
          </p>
        </motion.header>

        <div className="mb-8 grid gap-4 sm:grid-cols-3">
          {[
            { label: "Create", text: "Start a new project from the top button." },
            { label: "Open", text: "Jump into a project to continue the conversation." },
            { label: "Manage", text: "Rename or remove a project from its card." },
          ].map((item) => (
            <div
              key={item.label}
              className={`rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}
            >
              <p className="text-sm font-semibold">{item.label}</p>
              <p className={`mt-2 text-sm ${isDark ? "text-[#a3a3a3]" : "text-[#555]"}`}>
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
                    ? "bg-[#2a2a2a] border-white/10 hover:bg-[#323232]"
                    : "bg-white border-black/10 hover:bg-[#f0f0f0]"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className={`text-xs font-semibold uppercase tracking-[0.2em] ${isDark ? "text-[#a3a3a3]" : "text-[#666]"}`}>
                      Project
                    </p>
                    <h2 className={`mt-2 text-lg font-semibold ${isDark ? "text-[#e5e5e5]" : "text-[#111]"}`}>
                      {p.description}
                    </h2>
                    <p className={`mt-3 text-sm ${isDark ? "text-[#a3a3a3]" : "text-[#555]"}`}>
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

                <div className={`mt-5 flex flex-wrap gap-2 border-t pt-4 ${isDark ? "border-white/10" : "border-black/10"}`}>
                  <button
                    type="button"
                    onClick={() => handleEditProject(p)}
                    className={`rounded-full px-4 py-2 text-xs font-semibold transition ${
                      isDark
                        ? "border border-white/10 bg-[#3a3a3a] hover:bg-[#4a4a4a]"
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
            isDark ? "border-white/10 bg-[#2a2a2a] text-[#888]" : "border-black/10 bg-white text-[#666]"
          }`}>
            <p className="text-base font-semibold">No projects yet</p>
            <p className="mt-2">Use the New Project button to create your first workspace.</p>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              disabled={isCreating}
              className={`mt-5 rounded-full px-5 py-2.5 text-xs font-semibold transition ${
                isDark
                  ? "bg-white text-[#111] hover:bg-[#e8e8e8]"
                  : "bg-black text-white hover:bg-[#222]"
              } ${isCreating ? "opacity-60 cursor-not-allowed" : ""}`}
            >
              {isCreating ? "Creating..." : "Create project"}
            </button>
          </div>
        )}
      </div>

      <CreateProjectModal
        isOpen={isCreateModalOpen}
        isSubmitting={isCreating}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateProject}
      />
    </div>
  );
}