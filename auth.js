// auth.js - Appwrite SDK-based authentication
import { Client, Account } from "npm:node-appwrite@13.0.0";
import { createOrUpdateUser } from "./database.js";

const APPWRITE_ENDPOINT = Deno.env.get("APPWRITE_ENDPOINT") || "https://cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = Deno.env.get("APPWRITE_PROJECT_ID");

export async function verifyToken(jwt) {
  try {
    console.log("[Novirun Auth] Verifying JWT with Appwrite SDK...");
    
    // Create a client with the user's JWT
    const userClient = new Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setJWT(jwt);
    
    const account = new Account(userClient);
    
    // Get account info using the JWT - this will validate the token
    const user = await account.get();
    
    console.log("[Novirun Auth] User verified:", user.$id);
    
    // Create or update user in our database
    const dbUser = await createOrUpdateUser(user.$id, user.email);
    return dbUser;
  } catch (error) {
    console.error("[Novirun Auth] Token verification failed:", error.message);
    return null;
  }
}

export async function getAuthUser(request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log("[Novirun Auth] No Bearer token found");
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
