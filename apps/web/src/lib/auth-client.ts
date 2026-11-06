"use client";

import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

/** Browser client for the Better Auth endpoints under /api/auth (sign-in only; data goes through the API). */
export const authClient = createAuthClient({ plugins: [emailOTPClient()] });
