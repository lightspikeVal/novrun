// auth.js - Appwrite authentication verification
import { createOrUpdateUser } from "./database.js";

const APPWRITE_API_KEY = Deno.env.get("APPWRITE_API_KEY");
const APPWRITE_ENDPOINT = Deno.env.get("APPWRITE_ENDPOINT") || "http://localhost/v1";
const APPWRITE_PROJECT_ID = Deno.env.get("APPWRITE_PROJECT_ID");

export async function verifyToken(sessionToken) {
  try {
    // Verify session with Appwrite
    const response = await fetch(`${APPWRITE_ENDPOINT}/account`, {
      method: "GET",
      headers: {
        "X-Appwrite-Key": APPWRITE_API_KEY,
        "Cookie": `a_session=${sessionToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const user = await response.json();
    
    // Create or update user in our database
    const dbUser = await createOrUpdateUser(user.$id, user.email);
    return dbUser;
  } catch (error) {
    console.error("[Novirun] Token verification failed:", error.message);
    return null;
  }
}

export async function getAuthUser(request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7);
  return await verifyToken(token);
}

export async function requireAuth(ctx, next) {
  const user = await getAuthUser(ctx.request);
  if (!user) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  ctx.state.user = user;
  await next();
}
