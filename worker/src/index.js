import { createRoomService, HttpError } from "./room-service.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!env.DB) {
      return json({ error: "D1 binding DB is not configured" }, 500);
    }

    const service = createRoomService(env.DB);
    const url = new URL(request.url);

    try {
      const route = matchRoute(request.method, url.pathname);

      if (route.name === "createRoom") {
        const body = await readJson(request);
        return json(await service.createRoom(body), 201);
      }

      if (route.name === "joinRoom") {
        const body = await readJson(request);
        return json(await service.joinRoom(route.roomId, body));
      }

      if (route.name === "updateState") {
        const body = await readJson(request);
        return json(await service.updateState(route.roomId, body));
      }

      if (route.name === "getState") {
        return json(await service.getState(route.roomId));
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      console.error(error);
      return json({ error: "Internal server error" }, 500);
    }
  }
};

function matchRoute(method, pathname) {
  if (method === "POST" && pathname === "/rooms") {
    return { name: "createRoom" };
  }

  const joinMatch = pathname.match(/^\/rooms\/([^/]+)\/join$/);
  if (method === "POST" && joinMatch) {
    return { name: "joinRoom", roomId: joinMatch[1] };
  }

  const stateMatch = pathname.match(/^\/rooms\/([^/]+)\/state$/);
  if (stateMatch) {
    if (method === "POST") {
      return { name: "updateState", roomId: stateMatch[1] };
    }
    if (method === "GET") {
      return { name: "getState", roomId: stateMatch[1] };
    }
  }

  return { name: "notFound" };
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(400, "Expected application/json");
  }

  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
