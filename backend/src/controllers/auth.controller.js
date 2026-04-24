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
  const { idToken, fullName } = req.body;

  try {
    if (!idToken?.trim()) {
      return res.status(400).json({ message: "idToken is required" });
    }

    const firebaseUser = await verifyFirebaseIdToken(idToken.trim());
    const firebaseUid = String(firebaseUser.localId || "").trim();
    const email = String(firebaseUser.email || "").trim().toLowerCase();
    const resolvedFullName = String(fullName || firebaseUser.displayName || "").trim();

    if (!firebaseUid || !email || !resolvedFullName) {
      return res.status(400).json({ message: "Incomplete Firebase user profile" });
    }

    let user = await User.findOne({ $or: [{ firebaseUid }, { email }] });

    if (!user) {
      user = await User.create({
        firebaseUid,
        email,
        fullName: resolvedFullName,
        password: "",
      });
    } else {
      user.firebaseUid = firebaseUid;
      user.email = email;
      user.fullName = resolvedFullName;
      await user.save();
    }

    generateToken(user._id, res);
    debugAuth("firebase auth success", { userId: user._id.toString(), email: user.email });

    res.status(200).json({
      _id: user._id,
      firebaseUid: user.firebaseUid,
      fullName: user.fullName,
      email: user.email,
      profilePic: user.profilePic,
    });
  } catch (error) {
    if (error.message?.includes("INVALID_ID_TOKEN") || error.message?.includes("TOKEN_EXPIRED")) {
      return res.status(401).json({ message: "Invalid Firebase token" });
    }

    console.log("Error in firebaseAuth controller", error.message);
    res.status(500).json({ message: "Internal Server Error" });
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