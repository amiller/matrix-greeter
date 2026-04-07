// Matrix greeter bot for tee-daemon
// Connects to a Matrix homeserver, DMs a target user on startup

const MATRIX_HOMESERVER = Deno.env.get("MATRIX_HOMESERVER") || "";
const MATRIX_ACCESS_TOKEN = Deno.env.get("MATRIX_ACCESS_TOKEN") || "";
const MATRIX_USER_ID = Deno.env.get("MATRIX_USER_ID") || "";
const TARGET_USER = Deno.env.get("TARGET_USER") || "@socrates1024:matrix.org";
const GREETING = Deno.env.get("GREETING") || "👋 Hi from the hermes-staging CVM! I'm a matrix greeter bot running in a TEE.";

let ready = false;
let greetResult = "";
let credsReady = false;

// Inject env vars from tee-daemon warmup (same pattern as tweetbot)
function injectCreds(ctx: Record<string, unknown>) {
  if (typeof ctx?.env !== "object" || ctx.env === null) return;
  const e = ctx.env as Record<string, string>;
  if (e.MATRIX_HOMESERVER && e.MATRIX_ACCESS_TOKEN) {
    (globalThis as Record<string, unknown>).MATRIX_HOMESERVER = e.MATRIX_HOMESERVER;
    (globalThis as Record<string, unknown>).MATRIX_ACCESS_TOKEN = e.MATRIX_ACCESS_TOKEN;
    (globalThis as Record<string, unknown>).MATRIX_USER_ID = e.MATRIX_USER_ID;
    (globalThis as Record<string, unknown>).TARGET_USER = e.TARGET_USER || TARGET_USER;
    (globalThis as Record<string, unknown>).GREETING = e.GREETING || GREETING;
    if (!credsReady) {
      credsReady = true;
      greet();
    }
  }
}

// Helper to get current value of env var (may be set via warmup)
function getEnv(name: string): string {
  return (globalThis as Record<string, unknown>)[name] as string || Deno.env.get(name) || "";
}

async function matrixRequest(path: string, method = "GET", body?: Record<string, unknown>): Promise<unknown> {
  const hs = getEnv("MATRIX_HOMESERVER");
  const token = getEnv("MATRIX_ACCESS_TOKEN");
  const url = `${hs}/_matrix/client/v3/${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
  };
  const opts: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Matrix API ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function getJoinedRooms(): Promise<string[]> {
  const data = await matrixRequest("joined_rooms") as { joined_rooms: string[] };
  return data.joined_rooms;
}

async function createRoom(name: string, invite: string): Promise<string> {
  const data = await matrixRequest("createRoom", "POST", {
    name,
    invite: [invite],
    preset: "private_chat",
    visibility: "private",
  }) as { room_id: string };
  return data.room_id;
}

async function sendMessage(roomId: string, body: string): Promise<string> {
  const txn = `greeter_${Date.now()}`;
  const data = await matrixRequest(
    `rooms/${roomId}/send/m.room.message/${txn}`,
    "PUT",
    { msgtype: "m.text", body }
  ) as { event_id: string };
  return data.event_id;
}

async function findExistingDm(targetUserId: string): Promise<string | null> {
  const myUserId = getEnv("MATRIX_USER_ID");
  const rooms = await getJoinedRooms();
  for (const roomId of rooms) {
    try {
      const data = await matrixRequest(`rooms/${roomId}/members`) as {
        joined: { user_id: string; membership: string }[];
      };
      const members = (data.joined || [])
        .filter((m: { membership: string }) => m.membership === "join")
        .map((m: { user_id: string }) => m.user_id);
      if (members.includes(targetUserId) && members.includes(myUserId)) {
        return roomId;
      }
    } catch {
      // skip rooms we can't read
    }
  }
  return null;
}

async function greet() {
  const target = getEnv("TARGET_USER");
  const greeting = getEnv("GREETING");
  console.log(`[greeter] Looking for existing DM with ${target}...`);
  try {
    const existingRoom = await findExistingDm(target);
    if (existingRoom) {
      console.log(`[greeter] Found existing DM: ${existingRoom}`);
      const eventId = await sendMessage(existingRoom, greeting);
      greetResult = `Sent to existing room ${existingRoom} (event ${eventId})`;
    } else {
      console.log(`[greeter] No existing DM, creating room...`);
      const roomId = await createRoom(`🪶 greeter`, target);
      console.log(`[greeter] Created room ${roomId}`);
      // Wait a beat for the invite to propagate
      await new Promise(r => setTimeout(r, 1000));
      const eventId = await sendMessage(roomId, greeting);
      greetResult = `Created room ${roomId}, sent message (event ${eventId})`;
    }
    ready = true;
    console.log(`[greeter] ${greetResult}`);
  } catch (e) {
    greetResult = `Error: ${e}`;
    console.error(`[greeter] ${greetResult}`);
    ready = true;
  }
}

// HTTP handler for tee-daemon router
export default async function handler(req: Request, ctx: Record<string, unknown>): Promise<Response> {
  // Inject creds from warmup
  injectCreds(ctx);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/greeter/, "") || "/";

  // Admin: trigger a new greet
  if (path === "/greet" && req.method === "POST") {
    greet();
    return new Response(JSON.stringify({ status: "greeting" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Status dashboard
  if (path === "/" || path === "/status") {
    const html = `<!DOCTYPE html>
<html><head><title>matrix-greeter</title>
<style>
  body { font-family: system-ui; max-width: 600px; margin: 2rem auto; padding: 0 1rem; background: #0a0a0a; color: #e0e0e0; }
  h1 { font-size: 1.2rem; color: #4ade80; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .label { color: #888; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .value { font-size: 1rem; margin-top: 0.25rem; }
  .ok { color: #4ade80; }
  .err { color: #f87171; }
</style>
</head><body>
<h1>🪶 matrix-greeter</h1>
<div class="card">
  <div class="label">Status</div>
  <div class="value ${ready ? "ok" : "err"}">${ready ? "● ready" : "● initializing..."}</div>
</div>
<div class="card">
  <div class="label">Homeserver</div>
  <div class="value">${getEnv("MATRIX_HOMESERVER")}</div>
</div>
<div class="card">
  <div class="label">Bot</div>
  <div class="value">${getEnv("MATRIX_USER_ID")}</div>
</div>
<div class="card">
  <div class="label">Target</div>
  <div class="value">${getEnv("TARGET_USER")}</div>
</div>
<div class="card">
  <div class="label">Last Greet Result</div>
  <div class="value ${greetResult.startsWith("Error") ? "err" : "ok"}">${greetResult || "pending..."}</div>
</div>
</body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  }

  return new Response("not found", { status: 404 });
}
