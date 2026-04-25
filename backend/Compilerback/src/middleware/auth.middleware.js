import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

const getJwtSecret = () => process.env.JWT_SECRET?.trim();

const clearJwtCookie = (res) => {
  res.cookie("jwt", "", {
    maxAge: 0,
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });
};

export const protectRoute = async (req, res, next) => {
  try {
    const token = req.cookies.jwt;
    const jwtSecret = getJwtSecret();

    if (!jwtSecret) {
      return res.status(500).json({ message: "JWT_SECRET is not configured" });
    }

    if (!token) {
      return res.status(401).json({ message: "Unauthorized - No Token Provided" });
    }

    const decoded = jwt.verify(token, jwtSecret);

    if (!decoded) {
      return res.status(401).json({ message: "Unauthorized - Invalid Token" });
    }

    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    req.user = user;

    next();
  } catch (error) {
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError") {
      console.debug("[auth] token validation failed:", error.message);
      clearJwtCookie(res);
      return res.status(401).json({ message: "Unauthorized - Invalid Token" });
    }

    console.log("Error in protectRoute middleware: ", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
};