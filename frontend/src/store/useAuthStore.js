import { create } from "zustand";
import { axiosInstance } from "../lib/axios.js";
import toast from "react-hot-toast";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile
} from "firebase/auth";
import { firebaseAuth } from "../lib/firebase.js";

const googleProvider = new GoogleAuthProvider();

const getErrorMessage = (error, fallbackMessage) => {
  return error?.response?.data?.message || fallbackMessage;
};

const debugAuth = (...args) => {
  if (import.meta.env.MODE !== "production") {
    console.debug("[auth-store]", ...args);
  }
};

const syncFirebaseUserToBackend = async (firebaseUser, fullName = "") => {
  const idToken = await firebaseUser.getIdToken();
  const res = await axiosInstance.post("/auth/firebase", {
    idToken,
    fullName,
  });

  return res.data;
};

export const useAuthStore = create((set) => ({
  authUser: null,
  isSigningUp: false,
  isLoggingIn: false,
  isCheckingAuth: true,

  checkAuth: async () => {
    try {
      const res = await axiosInstance.get("/auth/check");

      set({ authUser: res.data });
      debugAuth("checkAuth success", { userId: res.data?._id });
    } catch (error) {
      debugAuth("checkAuth failed", error?.message);
      set({ authUser: null });
    } finally {
      set({ isCheckingAuth: false });
    }
  },

  signup: async (data) => {
    set({ isSigningUp: true });
    try {
      const firebaseUserCredential = await createUserWithEmailAndPassword(
        firebaseAuth,
        data.email,
        data.password
      );

      if (data.fullName?.trim()) {
        await updateProfile(firebaseUserCredential.user, { displayName: data.fullName.trim() });
      }

      const user = await syncFirebaseUserToBackend(
        firebaseUserCredential.user,
        data.fullName?.trim() || ""
      );
      set({ authUser: user });
      toast.success("Account created successfully");
      debugAuth("signup success", { userId: user?._id });
    } catch (error) {
      toast.error(getErrorMessage(error, "Signup failed"));
      debugAuth("signup failed", error?.message);
    } finally {
      set({ isSigningUp: false });
    }
  },

  login: async (data) => {
    set({ isLoggingIn: true });
    try {
      const firebaseUserCredential = await signInWithEmailAndPassword(
        firebaseAuth,
        data.email,
        data.password
      );

      const user = await syncFirebaseUserToBackend(firebaseUserCredential.user);
      set({ authUser: user });
      toast.success("Logged in successfully");
      debugAuth("login success", { userId: user?._id });
    } catch (error) {
      toast.error(getErrorMessage(error, "Login failed"));
      debugAuth("login failed", error?.message);
    } finally {
      set({ isLoggingIn: false });
    }
  },

  loginWithGoogle: async () => {
    set({ isLoggingIn: true });
    try {
      const firebaseUserCredential = await signInWithPopup(firebaseAuth, googleProvider);
      const user = await syncFirebaseUserToBackend(
        firebaseUserCredential.user,
        firebaseUserCredential.user?.displayName || ""
      );

      set({ authUser: user });
      toast.success("Logged in with Google");
      debugAuth("google login success", { userId: user?._id });
    } catch (error) {
      toast.error(getErrorMessage(error, "Google login failed"));
      debugAuth("google login failed", error?.message);
    } finally {
      set({ isLoggingIn: false });
    }
  },

  logout: async () => {
    try {
      await signOut(firebaseAuth);
      await axiosInstance.post("/auth/logout");
      set({ authUser: null });
      toast.success("Logged out successfully");
      debugAuth("logout success");
    } catch (error) {
      toast.error(getErrorMessage(error, "Logout failed"));
      debugAuth("logout failed", error?.message);
    }
  },
}));