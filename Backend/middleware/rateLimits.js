"use strict";
const { FixedWindowLimiter } = require("../security/securityControls");

const apiLimiter = new FixedWindowLimiter({ windowMs: 60 * 1000, max: 600 });
const loginLimiter = new FixedWindowLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const groupCreationLimiter = new FixedWindowLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
const registrationLimiter = new FixedWindowLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const emailActionLimiter = new FixedWindowLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const tokenVerificationLimiter = new FixedWindowLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

module.exports = {
  apiRateLimit: apiLimiter.middleware({ message: "Too many API requests. Please wait a minute and try again." }),
  loginRateLimit: loginLimiter.middleware({ message: "Too many sign-in attempts. Please wait 15 minutes before trying again." }),
  groupCreationRateLimit: groupCreationLimiter.middleware({ message: "Too many group registration attempts. Please try again later." }),
  registrationRateLimit: registrationLimiter.middleware({ message: "Too many registration attempts from this connection. Please try again later." }),
  emailActionRateLimit: emailActionLimiter.middleware({ message: "Too many email requests. Please wait 15 minutes before trying again." }),
  tokenVerificationRateLimit: tokenVerificationLimiter.middleware({ message: "Too many verification attempts. Please try again later." }),
  _limiters: { apiLimiter, loginLimiter, groupCreationLimiter, registrationLimiter, emailActionLimiter, tokenVerificationLimiter },
};
