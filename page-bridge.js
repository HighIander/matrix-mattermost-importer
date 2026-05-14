(() => {
  "use strict";

  const SOURCE = "matrix-mattermost-importer-page-bridge";
  const SESSION_REQUEST = "matrix-mattermost-importer-session-request";
  const SESSION_RESPONSE = "matrix-mattermost-importer-session-response";
  const SEND_REQUEST = "matrix-mattermost-importer-send-request";
  const SEND_RESPONSE = "matrix-mattermost-importer-send-response";
  const SEND_PROGRESS = "matrix-mattermost-importer-send-progress";
  const DUPLICATE_REQUEST = "matrix-mattermost-importer-duplicate-request";
  const DUPLICATE_RESPONSE = "matrix-mattermost-importer-duplicate-response";
  const GALLERY_CONTENT_KEY = "de.tkluge.gallery";
  const MATTERMOST_CONTENT_KEY = "de.tkluge.mattermost_import";
  const DUPLICATE_HISTORY_PAGE_SIZE = 100;
  const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 12;
  const RATE_LIMIT_RETRY_DEFAULT_MS = 5000;
  const RATE_LIMIT_RETRY_MAX_MS = 300000;
  const RATE_LIMIT_RETRY_HEARTBEAT_MS = 30000;

  let lastSession = null;
  let installed = false;
  const duplicateIndexes = new Map();

  function cleanUrl(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\/+$/, "");
  }

  function safeCall(obj, method) {
    try {
      if (obj && typeof obj[method] === "function") return obj[method]();
    } catch {}
    return undefined;
  }

  function isUsableMatrixClient(client) {
    return Boolean(
      client &&
      typeof client === "object" &&
      typeof client.sendMessage === "function" &&
      (
        typeof client.uploadContent === "function" ||
        client.http ||
        client._http
      )
    );
  }

  function sessionFromClient(client) {
    if (!client || typeof client !== "object") return null;

    const homeserver =
      safeCall(client, "getHomeserverUrl") ||
      client.baseUrl ||
      client.opts?.baseUrl ||
      client.clientOpts?.baseUrl ||
      client.store?.getHomeserverUrl?.() ||
      "";

    const userId =
      safeCall(client, "getUserId") ||
      client.credentials?.userId ||
      client.credentials?.user_id ||
      client.userId ||
      "";

    const deviceId =
      safeCall(client, "getDeviceId") ||
      client.deviceId ||
      client.credentials?.deviceId ||
      client.credentials?.device_id ||
      "";

    return {
      homeserver: cleanUrl(homeserver),
      userId,
      deviceId
    };
  }

  function findClientFromKnownGlobals() {
    const paths = [
      ["mxMatrixClientPeg"],
      ["MatrixClientPeg"],
      ["matrixClientPeg"],
      ["mxReactSdk", "MatrixClientPeg"],
      ["mxReactSdk", "default", "MatrixClientPeg"]
    ];

    for (const path of paths) {
      let obj = window;
      for (const part of path) obj = obj?.[part];
      if (!obj) continue;

      const client =
        safeCall(obj, "get") ||
        obj.matrixClient ||
        obj.client ||
        obj._matrixClient ||
        obj;

      if (isUsableMatrixClient(client)) return client;
    }

    for (const key of Object.keys(window)) {
      if (!/matrix|client|peg|mx/i.test(key)) continue;

      try {
        const value = window[key];

        const client =
          (isUsableMatrixClient(value) && value) ||
          (isUsableMatrixClient(value?.get?.()) && value.get()) ||
          (isUsableMatrixClient(value?.client) && value.client) ||
          (isUsableMatrixClient(value?.matrixClient) && value.matrixClient) ||
          (isUsableMatrixClient(value?._matrixClient) && value._matrixClient);

        if (client) return client;
      } catch {}
    }

    return null;
  }

  function walkObjectForUsableClient(root, maxNodes = 2600) {
    const seen = new WeakSet();
    const queue = [root];
    let nodes = 0;

    while (queue.length && nodes < maxNodes) {
      const value = queue.shift();
      nodes += 1;

      if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (isUsableMatrixClient(value)) return value;

      let children = [];
      try {
        children = Object.values(value).slice(0, 80);
      } catch {
        continue;
      }

      for (const child of children) {
        if (child && (typeof child === "object" || typeof child === "function")) {
          queue.push(child);
        }
      }
    }

    return null;
  }

  function findClientFromWebpack() {
    const chunkKeys = Object.keys(window).filter(key => key.startsWith("webpackChunk"));
    const modules = [];

    for (const chunkKey of chunkKeys) {
      const chunk = window[chunkKey];
      if (!Array.isArray(chunk)) continue;

      try {
        chunk.push([
          [Math.random()],
          {},
          req => {
            try {
              if (req?.c) {
                for (const mod of Object.values(req.c)) {
                  if (mod?.exports) modules.push(mod.exports);
                }
              }
            } catch {}
          }
        ]);
      } catch {}
    }

    for (const exp of modules) {
      const direct =
        (isUsableMatrixClient(exp) && exp) ||
        (isUsableMatrixClient(exp?.default) && exp.default) ||
        (isUsableMatrixClient(exp?.MatrixClientPeg?.get?.()) && exp.MatrixClientPeg.get()) ||
        (isUsableMatrixClient(exp?.default?.MatrixClientPeg?.get?.()) && exp.default.MatrixClientPeg.get());

      if (direct) return direct;

      const walked = walkObjectForUsableClient(exp, 2600);
      if (walked) return walked;
    }

    return null;
  }

  function findClient() {
    return findClientFromKnownGlobals() || findClientFromWebpack() || null;
  }

  function detectCurrentRoomIdOrAlias() {
    const hash = window.location.hash || "";
    const match = hash.match(/\/room\/([^/?#]+)/);

    if (match) {
      return decodeURIComponent(match[1]);
    }

    const pathMatch = window.location.pathname.match(/\/room\/([^/?#]+)/);

    if (pathMatch) {
      return decodeURIComponent(pathMatch[1]);
    }

    return "";
  }

  function getRoomByIdOrAlias(client, roomIdOrAlias) {
    if (!client || !roomIdOrAlias) return null;

    try {
      const direct = client.getRoom?.(roomIdOrAlias);
      if (direct) return direct;
    } catch {}

    try {
      const rooms = client.getRooms?.() || [];

      return rooms.find(room => {
        const roomId = room?.roomId || room?.room_id || "";
        const canonicalAlias = room?.getCanonicalAlias?.() || "";
        const altAliases = room?.getAltAliases?.() || [];

        return roomId === roomIdOrAlias ||
          canonicalAlias === roomIdOrAlias ||
          altAliases.includes(roomIdOrAlias);
      }) || null;
    } catch {
      return null;
    }
  }

  function roomName(room) {
    if (!room) return "";

    try {
      return room.name || room.getDefaultRoomName?.() || room.currentState?.getStateEvents?.("m.room.name", "")?.getContent?.()?.name || "";
    } catch {
      return room.name || "";
    }
  }

  function roomAliases(room) {
    if (!room) return [];

    const aliases = new Set();

    try {
      const canonical = room.getCanonicalAlias?.();
      if (canonical) aliases.add(canonical);
    } catch {}

    try {
      for (const alias of room.getAltAliases?.() || []) {
        if (alias) aliases.add(alias);
      }
    } catch {}

    try {
      const event = room.currentState?.getStateEvents?.("m.room.canonical_alias", "");
      const content = event?.getContent?.() || {};
      if (content.alias) aliases.add(content.alias);
      for (const alias of content.alt_aliases || []) aliases.add(alias);
    } catch {}

    return [...aliases];
  }

  function parentSpaceNames(client, room) {
    if (!client || !room) return [];

    const names = new Set();
    const parentIds = new Set();

    try {
      const events = room.currentState?.getStateEvents?.("m.space.parent") || [];
      for (const event of events) {
        const stateKey = event?.getStateKey?.() || event?.event?.state_key || "";
        if (stateKey) parentIds.add(stateKey);
      }
    } catch {}

    try {
      for (const candidate of client.getRooms?.() || []) {
        const children = candidate?.currentState?.getStateEvents?.("m.space.child") || [];
        for (const childEvent of children) {
          const stateKey = childEvent?.getStateKey?.() || childEvent?.event?.state_key || "";
          if (stateKey && stateKey === room.roomId) {
            parentIds.add(candidate.roomId);
          }
        }
      }
    } catch {}

    for (const parentId of parentIds) {
      const parentRoom = getRoomByIdOrAlias(client, parentId);
      const name = roomName(parentRoom);
      if (name) names.add(name);
    }

    return [...names];
  }

  function currentRoomInfo(client) {
    const roomIdOrAlias = detectCurrentRoomIdOrAlias();
    const room = getRoomByIdOrAlias(client, roomIdOrAlias);

    return {
      currentRoomId: room?.roomId || roomIdOrAlias || "",
      currentRoomName: roomName(room),
      currentRoomAliases: roomAliases(room),
      spaceNames: parentSpaceNames(client, room)
    };
  }

  function postSession(reason) {
    const client = findClient();

    if (!client) {
      window.postMessage({
        source: SOURCE,
        type: SESSION_RESPONSE,
        reason,
        ok: false,
        session: null,
        error: "No live MatrixClient found"
      }, window.location.origin);
      return;
    }

    lastSession = {
      ...(sessionFromClient(client) || {}),
      ...currentRoomInfo(client)
    };

    window.postMessage({
      source: SOURCE,
      type: SESSION_RESPONSE,
      reason,
      ok: true,
      session: lastSession
    }, window.location.origin);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function makeGalleryHtmlMetadata(galleryId, type, index, count, mxcUrl = "") {
    const payload = {
      id: galleryId,
      type,
      index,
      count,
      url: mxcUrl
    };

    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return `<span data-mg-gallery="${escapeHtml(encoded)}" style="display:none"></span>`;
  }

  function postProgress(requestId, message) {
    window.postMessage({
      source: SOURCE,
      type: SEND_PROGRESS,
      requestId,
      message
    }, window.location.origin);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function errorMessage(error) {
    return error?.message || error?.data?.error || error?.response?.data?.error || String(error);
  }

  function headerValue(headers, name) {
    if (!headers) return "";

    try {
      if (typeof headers.get === "function") {
        return headers.get(name) || headers.get(name.toLowerCase()) || "";
      }
    } catch {}

    const lowerName = name.toLowerCase();

    try {
      for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === lowerName) return value;
      }
    } catch {}

    return "";
  }

  function retryAfterHeaderMs(value) {
    const text = String(value || "").trim();
    if (!text) return 0;

    const seconds = Number(text);
    if (Number.isFinite(seconds)) return seconds * 1000;

    const timestamp = Date.parse(text);
    if (Number.isFinite(timestamp)) return timestamp - Date.now();

    return 0;
  }

  function numericRetryAfterMs(error) {
    const candidates = [
      error?.retry_after_ms,
      error?.retryAfterMs,
      error?.data?.retry_after_ms,
      error?.data?.retryAfterMs,
      error?.response?.data?.retry_after_ms,
      error?.response?.data?.retryAfterMs
    ];

    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value > 0) return value;
    }

    return 0;
  }

  function statusCode(error) {
    const candidates = [
      error?.httpStatus,
      error?.statusCode,
      error?.status,
      error?.data?.status,
      error?.response?.status,
      error?.xhr?.status
    ];

    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }

    return 0;
  }

  function isRateLimitError(error) {
    const errcodes = [
      error?.errcode,
      error?.name,
      error?.data?.errcode,
      error?.response?.data?.errcode
    ].map(value => String(value || "").toUpperCase());

    if (errcodes.includes("M_LIMIT_EXCEEDED")) return true;
    if (statusCode(error) === 429) return true;

    const message = errorMessage(error).toLowerCase();
    return message.includes("m_limit_exceeded") ||
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("rate-limited") ||
      message.includes("ratelimited");
  }

  function retryDelayMs(error, attempt) {
    const headerRetryAfter = retryAfterHeaderMs(
      headerValue(error?.headers, "retry-after") ||
      headerValue(error?.response?.headers, "retry-after") ||
      headerValue(error?.xhr?.headers, "retry-after")
    );

    const serverDelay = numericRetryAfterMs(error) || headerRetryAfter;
    const fallbackDelay = RATE_LIMIT_RETRY_DEFAULT_MS * Math.pow(2, Math.max(0, attempt - 1));
    const delay = serverDelay || fallbackDelay;

    return Math.max(1000, Math.min(delay, RATE_LIMIT_RETRY_MAX_MS));
  }

  function formatDelay(ms) {
    const seconds = Math.ceil(ms / 1000);

    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  async function sleepWithProgress(ms, requestId, description) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < ms) {
      const remaining = ms - (Date.now() - startedAt);
      const waitMs = Math.min(remaining, RATE_LIMIT_RETRY_HEARTBEAT_MS);

      await sleep(waitMs);

      const nextRemaining = ms - (Date.now() - startedAt);
      if (nextRemaining > 0) {
        postProgress(requestId, `Still rate limited while ${description}; retrying in ${formatDelay(nextRemaining)}.`);
      }
    }
  }

  async function withRateLimitRetry(description, requestId, operation) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!isRateLimitError(error)) {
          throw error;
        }

        if (attempt >= RATE_LIMIT_RETRY_MAX_ATTEMPTS) {
          throw new Error(`Rate limit did not clear after ${RATE_LIMIT_RETRY_MAX_ATTEMPTS} retries while ${description}: ${errorMessage(error)}`);
        }

        const retryNumber = attempt + 1;
        const delay = retryDelayMs(error, retryNumber);
        postProgress(
          requestId,
          `Rate limited while ${description}; retrying in ${formatDelay(delay)} (${retryNumber}/${RATE_LIMIT_RETRY_MAX_ATTEMPTS}).`
        );
        await sleepWithProgress(delay, requestId, description);
      }
    }
  }

  async function resolveRoom(client, roomIdOrAlias) {
    if (!roomIdOrAlias) {
      throw new Error("Missing Matrix room id or alias");
    }

    if (roomIdOrAlias.startsWith("#") && typeof client.getRoomIdForAlias === "function") {
      const aliasResult = await client.getRoomIdForAlias(roomIdOrAlias);
      return aliasResult?.room_id || aliasResult?.roomId || roomIdOrAlias;
    }

    return roomIdOrAlias;
  }

  async function uploadContentViaClient(client, file, meta) {
    if (typeof client.uploadContent === "function") {
      const result = await client.uploadContent(file, {
        name: meta.name || file.name,
        type: meta.type || file.type || "application/octet-stream",
        rawResponse: false
      });

      if (typeof result === "string") return result;
      if (result?.content_uri) return result.content_uri;
      if (result?.contentUri) return result.contentUri;
    }

    const http = client.http || client._http;

    if (http && typeof http.authedRequest === "function") {
      const result = await http.authedRequest(
        undefined,
        "POST",
        "/_matrix/media/v3/upload",
        { filename: meta.name || file.name },
        file,
        {
          headers: {
            "Content-Type": meta.type || file.type || "application/octet-stream"
          }
        }
      );

      if (typeof result === "string") return result;
      if (result?.content_uri) return result.content_uri;
      if (result?.contentUri) return result.contentUri;
    }

    throw new Error("MatrixClient has no usable upload method");
  }

  function addMattermostMetadata(content, meta) {
    if (!meta || typeof meta !== "object") return content;

    content[MATTERMOST_CONTENT_KEY] = {
      version: 1,
      ...meta
    };

    return content;
  }

  function addThreadRelation(content, thread) {
    if (!thread?.rootEventId || content["m.relates_to"]) {
      return content;
    }

    const fallbackEventId = thread.fallbackEventId || thread.rootEventId;

    content["m.relates_to"] = {
      rel_type: "m.thread",
      event_id: thread.rootEventId,
      "m.in_reply_to": {
        event_id: fallbackEventId
      },
      is_falling_back: true
    };

    return content;
  }

  function addThreadFallbackLabel(content, thread) {
    if (!thread?.rootEventId || !content || typeof content !== "object") {
      return content;
    }

    const textLabel = "Thread:";
    const htmlLabel = "<strong>Thread:</strong>";
    const msgtype = String(content.msgtype || "");

    if (msgtype === "m.text" || msgtype === "m.notice" || content.formatted_body) {
      const body = String(content.body || "");

      if (!body.startsWith(`${textLabel}\n`)) {
        content.body = `${textLabel}\n${body}`.trimEnd();
      }

      if (!content.formatted_body) {
        content.format = "org.matrix.custom.html";
        content.formatted_body = escapeHtml(body);
      }

      if (!String(content.formatted_body || "").startsWith(htmlLabel)) {
        content.format = "org.matrix.custom.html";
        content.formatted_body = `${htmlLabel}<br>${content.formatted_body || ""}`;
      }

      return content;
    }

    if ((msgtype === "m.image" || msgtype === "m.file") && content.body) {
      const body = String(content.body || "");
      if (!body.startsWith(`${textLabel} `)) {
        content.body = `${textLabel} ${body}`;
      }
    }

    return content;
  }

  function cloneMessageContent(content) {
    try {
      return structuredClone(content);
    } catch {
      return JSON.parse(JSON.stringify(content));
    }
  }

  function shouldUseThreadAwareSend(client, thread) {
    return Boolean(
      thread?.rootEventId &&
      String(thread.rootEventId).startsWith("$") &&
      client &&
      typeof client.sendMessage === "function"
    );
  }

  async function sendMessageToRoom(client, roomId, content, thread) {
    if (shouldUseThreadAwareSend(client, thread)) {
      /*
       * Current matrix-js-sdk versions have a thread-aware overload:
       * sendMessage(roomId, threadId, content). Using it lets Element update
       * its local thread model immediately instead of treating the local echo
       * like a plain timeline message until the user opens the thread. The SDK
       * adds the Matrix m.thread relation when it is missing.
       */
      return client.sendMessage(roomId, thread.rootEventId, cloneMessageContent(content));
    }

    return client.sendMessage(roomId, addThreadRelation(cloneMessageContent(content), thread));
  }

  function normalizeDuplicateText(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map(line => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .trim();
  }

  function normalizeDuplicateAuthor(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeDuplicateTime(value) {
    const numberValue = Number(value);

    if (Number.isFinite(numberValue)) {
      return String(Math.trunc(numberValue));
    }

    return String(value || "").trim();
  }

  function importedContentFromBody(body) {
    const value = normalizeDuplicateText(body);
    const splitAt = value.indexOf("\n");

    return splitAt === -1 ? value : value.slice(splitAt + 1).trim();
  }

  function duplicateSignature(check) {
    if (!check || typeof check !== "object") return "";

    const senderName = normalizeDuplicateAuthor(check.senderName || check.sender_name);
    const createAt = normalizeDuplicateTime(check.createAt ?? check.create_at);
    const content = normalizeDuplicateText(check.content);

    if (!senderName || !createAt) return "";

    return `${senderName}\u001f${createAt}\u001f${content}`;
  }

  function duplicateBodySignature(body) {
    const value = normalizeDuplicateText(body);

    return value ? `body\u001f${value}` : "";
  }

  function getEventId(event) {
    try {
      return event?.getId?.() || event?.event?.event_id || event?.event_id || "";
    } catch {
      return event?.event?.event_id || event?.event_id || "";
    }
  }

  function getEventType(event) {
    try {
      return event?.getType?.() || event?.event?.type || event?.type || "";
    } catch {
      return event?.event?.type || event?.type || "";
    }
  }

  function getEventContent(event) {
    try {
      return event?.getContent?.() || event?.event?.content || event?.content || {};
    } catch {
      return event?.event?.content || event?.content || {};
    }
  }

  function rememberMapValue(map, key, value) {
    if (!key) return;

    if (!map.has(key) || (!map.get(key) && value)) {
      map.set(key, value || "");
    }
  }

  function addEventToDuplicateIndex(index, event) {
    if (!index || !event) return;

    const eventId = getEventId(event);
    if (eventId && index.seenEventIds.has(eventId)) return;
    if (eventId) index.seenEventIds.add(eventId);

    if (getEventType(event) !== "m.room.message") return;

    const content = getEventContent(event);
    const body = content?.body || "";
    const meta = content?.[MATTERMOST_CONTENT_KEY] || {};

    if (meta.sender_name && meta.create_at !== undefined) {
      const signature = duplicateSignature({
        senderName: meta.sender_name,
        createAt: meta.create_at,
        content: importedContentFromBody(body)
      });

      rememberMapValue(index.signatures, signature, eventId);
    }

    const bodySignature = duplicateBodySignature(body);
    rememberMapValue(index.bodySignatures, bodySignature, meta.post_id ? eventId : "");
    rememberMapValue(index.postEventIds, meta.post_id || "", eventId);
  }

  function emptyDuplicateIndex() {
    return {
      signatures: new Map(),
      bodySignatures: new Map(),
      postEventIds: new Map(),
      seenEventIds: new Set(),
      scannedHistory: false,
      historyLimited: false
    };
  }

  function addTimelineEvents(events, output, seen) {
    for (const event of events || []) {
      const eventId = getEventId(event);
      const key = eventId || event;

      if (seen.has(key)) continue;
      seen.add(key);
      output.push(event);
    }
  }

  function loadedRoomEvents(room) {
    const events = [];
    const seen = new Set();

    try {
      addTimelineEvents(room?.timeline || [], events, seen);
    } catch {}

    try {
      addTimelineEvents(room?.getLiveTimeline?.()?.getEvents?.() || [], events, seen);
    } catch {}

    try {
      addTimelineEvents(room?.getUnfilteredTimelineSet?.()?.getLiveTimeline?.()?.getEvents?.() || [], events, seen);
    } catch {}

    try {
      for (const timelineSet of room?.getTimelineSets?.() || []) {
        addTimelineEvents(timelineSet?.getLiveTimeline?.()?.getEvents?.() || [], events, seen);
        for (const timeline of timelineSet?.getTimelines?.() || []) {
          addTimelineEvents(timeline?.getEvents?.() || [], events, seen);
        }
      }
    } catch {}

    return events;
  }

  function getBackwardPaginationToken(room) {
    const timelines = [];

    try {
      const liveTimeline = room?.getLiveTimeline?.();
      if (liveTimeline) timelines.push(liveTimeline);
    } catch {}

    try {
      const unfilteredTimeline = room?.getUnfilteredTimelineSet?.()?.getLiveTimeline?.();
      if (unfilteredTimeline) timelines.push(unfilteredTimeline);
    } catch {}

    for (const timeline of timelines) {
      try {
        const token =
          timeline.getPaginationToken?.("b") ||
          timeline.getPaginationToken?.("backwards") ||
          timeline.paginationToken?.b ||
          timeline.paginationToken;

        if (token) return token;
      } catch {}
    }

    return "";
  }

  async function fetchBackwardsMessages(client, roomId, fromToken, requestId) {
    const http = client?.http || client?._http;

    if (!http || typeof http.authedRequest !== "function" || !fromToken) {
      return null;
    }

    return withRateLimitRetry("scanning Matrix history", requestId, () => http.authedRequest(
      undefined,
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        dir: "b",
        from: fromToken,
        limit: DUPLICATE_HISTORY_PAGE_SIZE
      }
    ));
  }

  async function addServerHistoryToDuplicateIndex(client, room, roomId, index, requestId) {
    if (!room || index.scannedHistory) return;

    let token = getBackwardPaginationToken(room);
    let scanned = 0;

    if (!token) {
      index.scannedHistory = true;
      index.historyLimited = false;
      return;
    }

    postProgress(requestId, "Indexing all available existing Matrix messages for duplicate checks...");

    while (token) {
      let result = null;

      try {
        result = await fetchBackwardsMessages(client, roomId, token, requestId);
      } catch (error) {
        postProgress(requestId, `Could not scan older Matrix history for duplicates: ${error?.message || error}`);
        break;
      }

      const chunk = Array.isArray(result?.chunk) ? result.chunk : [];

      for (const event of chunk) {
        addEventToDuplicateIndex(index, event);
        scanned += 1;
      }

      if (!result?.end || result.end === token || chunk.length === 0) break;
      token = result.end;

      if (scanned > 0 && scanned % 1000 === 0) {
        postProgress(requestId, `Indexed ${scanned} older Matrix events for duplicate checks...`);
      }
    }

    index.scannedHistory = true;
    index.historyLimited = false;

    if (scanned > 0) {
      postProgress(requestId, `Finished duplicate history scan after indexing ${scanned} older Matrix events.`);
    }
  }

  async function getDuplicateIndex(client, roomId, requestId) {
    const room = getRoomByIdOrAlias(client, roomId);
    let index = duplicateIndexes.get(roomId);

    if (!index) {
      index = emptyDuplicateIndex();
      duplicateIndexes.set(roomId, index);
    }

    for (const event of loadedRoomEvents(room)) {
      addEventToDuplicateIndex(index, event);
    }

    await addServerHistoryToDuplicateIndex(client, room, roomId, index, requestId);

    return index;
  }

  async function checkDuplicateImport(client, roomId, duplicateCheck, requestId) {
    const signature = duplicateSignature(duplicateCheck);
    const bodySignature = duplicateBodySignature(duplicateCheck?.body);

    if (!signature && !bodySignature) {
      return { duplicate: false, matchedBy: "" };
    }

    const index = await getDuplicateIndex(client, roomId, requestId);

    if (signature && index.signatures.has(signature)) {
      return {
        duplicate: true,
        matchedBy: "author-content-time",
        eventId: index.signatures.get(signature) || "",
        postId: duplicateCheck?.postId || ""
      };
    }

    if (bodySignature && index.bodySignatures.has(bodySignature)) {
      return {
        duplicate: true,
        matchedBy: "body",
        eventId: index.bodySignatures.get(bodySignature) || "",
        postId: duplicateCheck?.postId || ""
      };
    }

    return { duplicate: false, matchedBy: "" };
  }

  function rememberDuplicateCheck(roomId, duplicateCheck, eventId = "") {
    let index = duplicateIndexes.get(roomId);

    if (!index) {
      index = emptyDuplicateIndex();
      duplicateIndexes.set(roomId, index);
    }

    const signature = duplicateSignature(duplicateCheck);
    const bodySignature = duplicateBodySignature(duplicateCheck?.body);

    rememberMapValue(index.signatures, signature, eventId);
    rememberMapValue(index.bodySignatures, bodySignature, eventId);
    rememberMapValue(index.postEventIds, duplicateCheck?.postId || "", eventId);
  }

  async function resolveThreadContext(client, roomId, thread, requestId) {
    const rootPostId = String(thread?.rootPostId || "").trim();

    if (!rootPostId) {
      return null;
    }

    const index = await getDuplicateIndex(client, roomId, requestId);
    const rootEventId = String(thread?.rootEventId || index.postEventIds.get(rootPostId) || "").trim();

    if (!rootEventId) {
      postProgress(requestId, `Thread root ${rootPostId} is not available in Matrix history; sending in main timeline.`);
      return null;
    }

    return {
      rootPostId,
      rootEventId,
      fallbackEventId: String(thread?.fallbackEventId || rootEventId).trim() || rootEventId
    };
  }

  async function checkDuplicate(payload) {
    const client = findClient();

    if (!client) {
      throw new Error("No live MatrixClient found in Element page context");
    }

    const roomId = await resolveRoom(client, payload.room);
    const result = await checkDuplicateImport(client, roomId, payload.duplicateCheck, payload.requestId);

    if (result.duplicate) {
      postProgress(payload.requestId, `Duplicate found for Mattermost post ${payload.duplicateCheck?.postId || ""}`.trim());
    }

    return {
      ok: true,
      roomId,
      duplicate: result.duplicate,
      matchedBy: result.matchedBy,
      eventId: result.eventId || "",
      postId: result.postId || payload.duplicateCheck?.postId || ""
    };
  }

  function eventIdFromSendResult(result) {
    if (typeof result === "string") return result;

    return result?.event_id || result?.eventId || result?.event?.event_id || "";
  }

  async function sendTextItem(client, roomId, item, requestId, threadContext) {
    postProgress(requestId, `Sende Text: ${item.shortLabel || item.meta?.post_id || "Mattermost message"}`);

    const content = {
      msgtype: item.msgtype || "m.text",
      body: item.body || "",
      format: item.formatted_body ? "org.matrix.custom.html" : undefined,
      formatted_body: item.formatted_body || undefined
    };

    if (!content.formatted_body) {
      delete content.format;
      delete content.formatted_body;
    }

    if (item.gallery) {
      content[GALLERY_CONTENT_KEY] = {
        id: item.gallery.id,
        type: "caption",
        count: item.gallery.count
      };

      content.format = "org.matrix.custom.html";
      content.formatted_body = `${content.formatted_body || escapeHtml(content.body)}${makeGalleryHtmlMetadata(item.gallery.id, "caption", -1, item.gallery.count)}`;
    }

    const eventContent = addMattermostMetadata(addThreadFallbackLabel(content, threadContext), item.meta);
    const result = await withRateLimitRetry("sending text", requestId, () => sendMessageToRoom(client, roomId, eventContent, threadContext));

    return eventIdFromSendResult(result);
  }

  async function sendFileItem(client, roomId, item, requestId, threadContext) {
    const file = item.file;
    const meta = item.fileMeta || {};

    postProgress(requestId, `Lade Datei hoch: ${meta.name || file?.name || "file"}`);

    const mxcUrl = await withRateLimitRetry(
      `uploading ${meta.name || file?.name || "file"}`,
      requestId,
      () => uploadContentViaClient(client, file, meta)
    );
    const isImage = String(meta.type || file?.type || "").startsWith("image/");

    const content = {
      msgtype: isImage ? "m.image" : "m.file",
      body: meta.name || file?.name || "Mattermost file",
      filename: meta.name || file?.name || undefined,
      url: mxcUrl,
      info: {
        mimetype: meta.type || file?.type || "application/octet-stream",
        size: meta.size || file?.size || 0,
        w: meta.width || undefined,
        h: meta.height || undefined
      }
    };

    if (isImage && item.gallery) {
      content[GALLERY_CONTENT_KEY] = {
        id: item.gallery.id,
        type: "image",
        index: item.gallery.index,
        count: item.gallery.count,
        caption: item.gallery.caption || "",
        url: mxcUrl
      };
    }

    postProgress(requestId, `Sende Datei: ${content.body}`);
    const eventContent = addMattermostMetadata(addThreadFallbackLabel(content, threadContext), item.meta);
    const result = await withRateLimitRetry(`sending file ${content.body}`, requestId, () => sendMessageToRoom(client, roomId, eventContent, threadContext));

    return eventIdFromSendResult(result);
  }

  async function sendItems(payload) {
    const client = findClient();

    if (!client) {
      throw new Error("No live MatrixClient found in Element page context");
    }

    const roomId = await resolveRoom(client, payload.room);
    const requestId = payload.requestId;
    const items = Array.isArray(payload.items) ? payload.items : [];
    const duplicateCheck = payload.duplicateCheck || null;

    if (duplicateCheck) {
      const duplicateResult = await checkDuplicateImport(client, roomId, duplicateCheck, requestId);

      if (duplicateResult.duplicate) {
        postProgress(requestId, `Skipping duplicate Mattermost post ${duplicateCheck.postId || ""}`.trim());

        return {
          ok: true,
          roomId,
          sent: 0,
          duplicate: true,
          matchedBy: duplicateResult.matchedBy,
          primaryEventId: duplicateResult.eventId || "",
          eventIds: duplicateResult.eventId ? [duplicateResult.eventId] : []
        };
      }
    }

    const threadContext = await resolveThreadContext(client, roomId, payload.thread, requestId);
    const eventIds = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let eventId = "";
      postProgress(requestId, `Sende Importelement ${i + 1}/${items.length} ...`);

      if (item.kind === "text") {
        eventId = await sendTextItem(client, roomId, item, requestId, threadContext);
      } else if (item.kind === "file") {
        eventId = await sendFileItem(client, roomId, item, requestId, threadContext);
      } else {
        throw new Error(`Unknown import item kind: ${item.kind}`);
      }

      if (eventId) eventIds.push(eventId);
    }

    if (duplicateCheck) {
      rememberDuplicateCheck(roomId, duplicateCheck, eventIds[0] || "");
    }

    return {
      ok: true,
      roomId,
      sent: items.length,
      duplicate: false,
      primaryEventId: eventIds[0] || "",
      eventIds,
      threadRootEventId: threadContext?.rootEventId || ""
    };
  }

  function install() {
    if (installed) return;
    installed = true;

    window.addEventListener("message", event => {
      if (event.source !== window) return;
      if (!event.data) return;

      if (event.data.type === SESSION_REQUEST) {
        postSession("request");
        return;
      }

      if (event.data.type === SEND_REQUEST) {
        const requestId = event.data.requestId;

        sendItems(event.data)
          .then(result => {
            window.postMessage({
              source: SOURCE,
              type: SEND_RESPONSE,
              requestId,
              ok: true,
              result
            }, window.location.origin);
          })
          .catch(error => {
            window.postMessage({
              source: SOURCE,
              type: SEND_RESPONSE,
              requestId,
              ok: false,
              error: error?.message || String(error)
            }, window.location.origin);
          });
      }

      if (event.data.type === DUPLICATE_REQUEST) {
        const requestId = event.data.requestId;

        checkDuplicate(event.data)
          .then(result => {
            window.postMessage({
              source: SOURCE,
              type: DUPLICATE_RESPONSE,
              requestId,
              ok: true,
              result
            }, window.location.origin);
          })
          .catch(error => {
            window.postMessage({
              source: SOURCE,
              type: DUPLICATE_RESPONSE,
              requestId,
              ok: false,
              error: error?.message || String(error)
            }, window.location.origin);
          });
      }
    });

    postSession("install");
    setInterval(() => postSession("poll"), 2500);
  }

  install();
})();
