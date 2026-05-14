(() => {
  "use strict";

  const SOURCE = "matrix-mattermost-importer-page-bridge";
  const SESSION_REQUEST = "matrix-mattermost-importer-session-request";
  const SESSION_RESPONSE = "matrix-mattermost-importer-session-response";
  const SEND_REQUEST = "matrix-mattermost-importer-send-request";
  const SEND_RESPONSE = "matrix-mattermost-importer-send-response";
  const SEND_PROGRESS = "matrix-mattermost-importer-send-progress";
  const GALLERY_CONTENT_KEY = "de.tkluge.gallery";

  let lastSession = null;
  let installed = false;

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

    lastSession = sessionFromClient(client) || {};

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

    content["de.tkluge.mattermost_import"] = {
      version: 1,
      ...meta
    };

    return content;
  }

  async function sendTextItem(client, roomId, item, requestId) {
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

    await client.sendMessage(roomId, addMattermostMetadata(content, item.meta));
  }

  async function sendFileItem(client, roomId, item, requestId) {
    const file = item.file;
    const meta = item.fileMeta || {};

    postProgress(requestId, `Lade Datei hoch: ${meta.name || file?.name || "file"}`);

    const mxcUrl = await uploadContentViaClient(client, file, meta);
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
    await client.sendMessage(roomId, addMattermostMetadata(content, item.meta));
  }

  async function sendItems(payload) {
    const client = findClient();

    if (!client) {
      throw new Error("No live MatrixClient found in Element page context");
    }

    const roomId = await resolveRoom(client, payload.room);
    const requestId = payload.requestId;
    const items = Array.isArray(payload.items) ? payload.items : [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      postProgress(requestId, `Sende Importelement ${i + 1}/${items.length} ...`);

      if (item.kind === "text") {
        await sendTextItem(client, roomId, item, requestId);
      } else if (item.kind === "file") {
        await sendFileItem(client, roomId, item, requestId);
      } else {
        throw new Error(`Unknown import item kind: ${item.kind}`);
      }
    }

    return {
      ok: true,
      roomId,
      sent: items.length
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
    });

    postSession("install");
    setInterval(() => postSession("poll"), 2500);
  }

  install();
})();
