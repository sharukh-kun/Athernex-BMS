import { generateToken } from "../lib/utils.js";
import User from "../models/user.model.js";

const debugAuth = (...args) => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[auth]", ...args);
  }
};

const verifyFirebaseIdToken = async (idToken) => {
  const apiKey = process.env.FIREBASE_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Missing FIREBASE_API_KEY in backend/.env");
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }
  );

  const payload = await response.json();

  if (!response.ok || !Array.isArray(payload?.users) || payload.users.length === 0) {
    const message = payload?.error?.message || "Invalid Firebase token";
    throw new Error(message);
  }

  return payload.users[0];
};

export const firebaseAuth = async (req, res) => {
  try {
    const { idToken, fullName } = req.body || {};

    if (!idToken) {
      return res.status(400).json({ message: "Firebase idToken is required" });
    }

    const firebaseUser = await verifyFirebaseIdToken(idToken);
    const firebaseUid = String(firebaseUser.localId || "").trim();
    const normalizedEmail = String(firebaseUser.email || "").trim().toLowerCase();

    if (!firebaseUid || !normalizedEmail) {
      return res.status(400).json({ message: "Invalid Firebase user payload" });
    }

    const preferredName =
      String(fullName || "").trim() ||
      String(firebaseUser.displayName || "").trim() ||
      normalizedEmail.split("@")[0];

    const preferredPhoto = String(firebaseUser.photoUrl || "").trim();

    let user = await User.findOne({ firebaseUid });
    if (!user) {
      user = await User.findOne({ email: normalizedEmail });
    }

    if (!user) {
      user = await User.create({
        firebaseUid,
        email: normalizedEmail,
        fullName: preferredName,
        profilePic: preferredPhoto,
        password: "",
      });
    } else {
      user.firebaseUid = user.firebaseUid || firebaseUid;
      user.email = normalizedEmail;
      if (preferredName) user.fullName = preferredName;
      if (preferredPhoto) user.profilePic = preferredPhoto;
      await user.save();
    }

    generateToken(user._id, res);
    debugAuth("firebase auth success", { userId: user._id.toString(), email: user.email });

    return res.status(200).json({
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      profilePic: user.profilePic,
    });
  } catch (error) {
    console.log("Error in firebaseAuth controller", error.message);
    return res.status(401).json({ message: "Google login failed. Please try again." });
  }
};

export const logout = (req, res) => {
  try {
    res.cookie("jwt", "", {
      maxAge: 0,
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });
    debugAuth("logout success");
    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.log("Error in logout controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const checkAuth = (req, res) => {
  try {
    debugAuth("checkAuth success", { userId: req.user?._id?.toString() });
    res.status(200).json(req.user);
  } catch (error) {
    console.log("Error in checkAuth controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};
