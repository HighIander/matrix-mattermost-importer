(() => {
  "use strict";

  if (window.__matrixMattermostImporterInitialized) {
    return;
  }

  window.__matrixMattermostImporterInitialized = true;

  const STORAGE_KEY = "matrix_mattermost_importer_config_v2";
  const BUTTON_ID = "mmi-button";
  const OVERLAY_ID = "mmi-overlay";
  const PAGE_BRIDGE_SOURCE = "matrix-mattermost-importer-page-bridge";
  const PAGE_BRIDGE_SESSION_REQUEST = "matrix-mattermost-importer-session-request";
  const PAGE_BRIDGE_SESSION_RESPONSE = "matrix-mattermost-importer-session-response";
  const PAGE_BRIDGE_SEND_REQUEST = "matrix-mattermost-importer-send-request";
  const PAGE_BRIDGE_SEND_RESPONSE = "matrix-mattermost-importer-send-response";
  const PAGE_BRIDGE_SEND_PROGRESS = "matrix-mattermost-importer-send-progress";

  const DEFAULT_CONFIG = {
    buttonRight: 18,
    buttonBottom: 76,
    includeOtherFiles: true
  };

  const state = {
    config: { ...DEFAULT_CONFIG },
    fileIndex: new Map(),
    rootHandle: null,
    rootPrefix: "",
    rootName: "",
    lazyFolderMode: false,
    manifest: null,
    users: {},
    scopes: [],
    selectedScope: null,
    selectedChannel: null,
    postsCache: new Map(),
    pageSession: null,
    loaded: false,
    importing: false
  };

  injectPageBridge();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  function boot() {
    loadConfig().then(() => {
      createFloatingButton();
      requestPageSession();
      setInterval(requestPageSession, 2500);
      installRoomChangeWatcher();
    });
  }

  function injectPageBridge() {
    window.addEventListener("message", event => {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== PAGE_BRIDGE_SOURCE) return;

      if (event.data.type === PAGE_BRIDGE_SESSION_RESPONSE && event.data.ok) {
        state.pageSession = event.data.session || null;
        updateSessionUiIfOpen();
      }
    });

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    script.onload = () => script.remove();

    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function requestPageSession() {
    window.postMessage({
      type: PAGE_BRIDGE_SESSION_REQUEST
    }, window.location.origin);
  }

  function chromeStorageGet(defaults) {
    return new Promise(resolve => {
      chrome.storage.local.get(defaults, result => resolve(result || defaults));
    });
  }

  function chromeStorageSet(values) {
    return new Promise(resolve => {
      chrome.storage.local.set(values, resolve);
    });
  }

  async function loadConfig() {
    const result = await chromeStorageGet({ [STORAGE_KEY]: DEFAULT_CONFIG });
    state.config = { ...DEFAULT_CONFIG, ...(result[STORAGE_KEY] || {}) };
  }

  async function saveConfig() {
    await chromeStorageSet({ [STORAGE_KEY]: state.config });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function htmlFromPlainText(value) {
    const escaped = escapeHtml(String(value || "").replace(/\r\n/g, "\n"));

    return escaped
      .replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
      )
      .replace(/\n/g, "<br>");
  }

  function normalizePath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  }

  function stripRootPrefix(relativePath) {
    const path = normalizePath(relativePath);

    if (state.rootPrefix && path.startsWith(state.rootPrefix)) {
      return path.slice(state.rootPrefix.length);
    }

    return path;
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

  function installRoomChangeWatcher() {
    let lastRoom = detectCurrentRoomIdOrAlias();

    const closeOnRoomChange = () => {
      const current = detectCurrentRoomIdOrAlias();
      if (current === lastRoom) return;
      lastRoom = current;

      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay) overlay.remove();
    };

    window.addEventListener("hashchange", closeOnRoomChange, true);
    window.addEventListener("popstate", closeOnRoomChange, true);
    setInterval(closeOnRoomChange, 1200);
  }

  function createFloatingButton() {
    if (document.getElementById(BUTTON_ID)) {
      return;
    }

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.className = "mmi-button";
    button.type = "button";
    button.textContent = "MM";
    button.title = "Import Mattermost export";
    button.setAttribute("aria-label", "Import Mattermost export");

    button.style.right = `${state.config.buttonRight}px`;
    button.style.bottom = `${state.config.buttonBottom}px`;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startBottom = 0;

    button.addEventListener("pointerdown", event => {
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startRight = parseFloat(button.style.right) || DEFAULT_CONFIG.buttonRight;
      startBottom = parseFloat(button.style.bottom) || DEFAULT_CONFIG.buttonBottom;
      button.setPointerCapture(event.pointerId);
    });

    button.addEventListener("pointermove", event => {
      if (!dragging) return;

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

      button.style.right = `${Math.max(4, startRight - dx)}px`;
      button.style.bottom = `${Math.max(4, startBottom - dy)}px`;
    });

    button.addEventListener("pointerup", async event => {
      if (!dragging) return;

      dragging = false;
      button.releasePointerCapture(event.pointerId);

      state.config.buttonRight = parseFloat(button.style.right) || DEFAULT_CONFIG.buttonRight;
      state.config.buttonBottom = parseFloat(button.style.bottom) || DEFAULT_CONFIG.buttonBottom;
      await saveConfig();

      if (!moved) {
        openModal();
      }
    });

    window.addEventListener("resize", () => {
      const rect = button.getBoundingClientRect();
      const right = Math.max(4, window.innerWidth - rect.right);
      const bottom = Math.max(4, window.innerHeight - rect.bottom);

      button.style.right = `${right}px`;
      button.style.bottom = `${bottom}px`;
    });

    document.body.appendChild(button);
  }

  function createFolderInput() {
    /*
     * Legacy fallback. This enumerates the whole folder through an <input> and
     * can be slow for very large exports. The preferred path is
     * window.showDirectoryPicker(), which keeps the export on disk and opens
     * only the selected files later.
     */
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.setAttribute("mozdirectory", "");

    document.body.appendChild(input);

    return input;
  }

  function resetLoadedExportState() {
    state.fileIndex.clear();
    state.rootHandle = null;
    state.rootPrefix = "";
    state.rootName = "";
    state.lazyFolderMode = false;
    state.manifest = null;
    state.users = {};
    state.scopes = [];
    state.selectedScope = null;
    state.selectedChannel = null;
    state.postsCache.clear();
    state.loaded = false;
  }

  function indexSelectedFiles(files) {
    /*
     * Legacy fallback for browsers without File System Access API.
     * It still works, but it enumerates every file in the export folder.
     */
    resetLoadedExportState();

    const fileArray = Array.from(files || []);
    const entries = fileArray.map(file => {
      const path = normalizePath(file.webkitRelativePath || file.name);
      return { file, path };
    });

    const manifestEntry = entries.find(entry => entry.path.endsWith("/manifest.json")) ||
      entries.find(entry => entry.path === "manifest.json");

    if (!manifestEntry) {
      throw new Error("No manifest.json found. Select the complete Mattermost export folder, not only index.html.");
    }

    state.rootPrefix = manifestEntry.path.slice(0, manifestEntry.path.length - "manifest.json".length);
    state.rootName = state.rootPrefix.replace(/\/$/, "").split("/").filter(Boolean).pop() || "Mattermost export";

    for (const entry of entries) {
      const stripped = state.rootPrefix && entry.path.startsWith(state.rootPrefix)
        ? entry.path.slice(state.rootPrefix.length)
        : entry.path;

      state.fileIndex.set(stripped, entry.file);
    }
  }

  async function selectExportFolderLazily() {
    /*
     * Preferred path for large exports.
     * The browser grants a directory handle, but files are not read until the
     * extension explicitly opens their path. This means the first step reads
     * only manifest.json and users.json; selected channel chunks/assets are
     * read only after channel selection/import.
     */
    if (!window.showDirectoryPicker) {
      throw new Error(
        "This browser does not expose showDirectoryPicker() here. Use Chrome or Edge and open Matrix through HTTPS, or use the legacy folder upload fallback."
      );
    }

    resetLoadedExportState();

    const handle = await window.showDirectoryPicker({ mode: "read" });
    state.rootHandle = handle;
    state.rootName = handle.name || "Mattermost export";
    state.lazyFolderMode = true;
  }

  async function fileFromDirectoryPath(relativePath) {
    const normalized = normalizePath(stripRootPrefix(relativePath));
    const parts = normalized.split("/").filter(Boolean);

    if (!state.rootHandle) {
      return null;
    }

    if (parts.length === 0) {
      return null;
    }

    let directory = state.rootHandle;

    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }

    const fileHandle = await directory.getFileHandle(parts[parts.length - 1], { create: false });
    return fileHandle.getFile();
  }

  async function readTextFile(path) {
    const normalized = normalizePath(stripRootPrefix(path));

    if (state.lazyFolderMode) {
      const file = await fileFromDirectoryPath(normalized);
      if (!file) {
        throw new Error(`Missing export file: ${path}`);
      }
      return file.text();
    }

    const file = state.fileIndex.get(normalized);

    if (!file) {
      throw new Error(`Missing export file: ${path}`);
    }

    return file.text();
  }

  async function readJsonFile(path) {
    const text = await readTextFile(path);
    return JSON.parse(text);
  }

  async function getExportFile(path) {
    const normalized = normalizePath(stripRootPrefix(path));

    if (state.lazyFolderMode) {
      try {
        return await fileFromDirectoryPath(normalized);
      } catch {
        return null;
      }
    }

    return state.fileIndex.get(normalized) || null;
  }

  async function loadExportFromSelectedFolder() {
    /*
     * This loads only the export metadata necessary for selection:
     * - manifest.json: teams/channels and post chunk paths
     * - users.json: names for DMs and senders, if present
     * No channel post chunks or assets are read here.
     */
    state.manifest = await readJsonFile("manifest.json");

    try {
      state.users = await readJsonFile("users.json");
    } catch {
      state.users = {};
    }

    makeScopes();
    state.selectedScope = state.scopes[0] || null;
    state.selectedChannel = null;
    state.loaded = true;
  }

  function allChannels() {
    return state.manifest ? (state.manifest.channels || []) : [];
  }

  function allTeams() {
    return state.manifest ? (state.manifest.teams || []) : [];
  }

  function makeScopes() {
    const teams = allTeams();
    const channels = allChannels();
    const scopes = [];

    for (const team of teams) {
      const teamChannels = channels.filter(channel => {
        return channel.team_id === team.id && channel.type !== "D" && channel.type !== "G";
      });

      if (teamChannels.length > 0) {
        scopes.push({
          type: "team",
          id: team.id,
          title: team.display_name || team.name || team.id,
          subtitle: `${teamChannels.length} channels`,
          icon: "T"
        });
      }
    }

    const directChannels = channels.filter(channel => channel.type === "D" || channel.type === "G");

    if (directChannels.length > 0) {
      scopes.push({
        type: "dm",
        id: "direct-messages",
        title: "Direct messages",
        subtitle: `${directChannels.length} conversations`,
        icon: "DM"
      });
    }

    const knownTeamIds = new Set(teams.map(team => team.id));
    const otherChannels = channels.filter(channel => {
      const isDirect = channel.type === "D" || channel.type === "G";
      const hasKnownTeam = channel.team_id && knownTeamIds.has(channel.team_id);
      return !isDirect && !hasKnownTeam;
    });

    if (otherChannels.length > 0) {
      scopes.push({
        type: "other",
        id: "other-channels",
        title: "Other channels",
        subtitle: `${otherChannels.length} channels`,
        icon: "?"
      });
    }

    state.scopes = scopes;
  }

  function channelsForScope(scope) {
    if (!scope) return [];

    const channels = allChannels();

    if (scope.type === "team") {
      return channels.filter(channel => channel.team_id === scope.id && channel.type !== "D" && channel.type !== "G");
    }

    if (scope.type === "dm") {
      return channels.filter(channel => channel.type === "D" || channel.type === "G");
    }

    if (scope.type === "other") {
      const knownTeamIds = new Set(allTeams().map(team => team.id));

      return channels.filter(channel => {
        const isDirect = channel.type === "D" || channel.type === "G";
        const hasKnownTeam = channel.team_id && knownTeamIds.has(channel.team_id);
        return !isDirect && !hasKnownTeam;
      });
    }

    return [];
  }

  function userName(userId) {
    const user = state.users[userId];

    if (!user) return userId || "unknown";

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();

    if (fullName) {
      return fullName + (user.username ? ` @${user.username}` : "");
    }

    return user.username ? `@${user.username}` : user.id;
  }

  function directMessageTitle(channel) {
    const ownUserId = state.manifest && state.manifest.user ? state.manifest.user.id : "";
    const ids = String(channel.name || "").split("__").filter(Boolean);
    const otherIds = ids.filter(id => id !== ownUserId);
    const visibleIds = otherIds.length > 0 ? otherIds : ids;

    if (visibleIds.length > 0) {
      return visibleIds.map(userName).join(", ");
    }

    return channel.display_name || channel.name || channel.id;
  }

  function channelTitle(channel) {
    if (!channel) return "";

    if (channel.type === "D" || channel.type === "G") {
      return directMessageTitle(channel);
    }

    return channel.display_name || channel.name || channel.id;
  }

  function channelTypeLabel(type) {
    if (type === "O") return "public";
    if (type === "P") return "private";
    if (type === "D") return "direct";
    if (type === "G") return "group";
    return type || "unknown";
  }

  async function loadPostsForChannel(channel) {
    if (state.postsCache.has(channel.id)) {
      return state.postsCache.get(channel.id);
    }

    const posts = [];

    for (const filePath of channel.post_files || []) {
      const chunk = await readJsonFile(stripRootPrefix(filePath));
      posts.push(...chunk);
    }

    posts.sort((a, b) => a.create_at - b.create_at);
    state.postsCache.set(channel.id, posts);

    return posts;
  }

  function formatMattermostTime(ms) {
    if (!ms) return "";

    return new Date(ms).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function isImageFile(fileInfo) {
    return String(fileInfo.mime_type || "").toLowerCase().startsWith("image/");
  }

  function exportedFileInfos(post) {
    return (post.file_infos || []).filter(fileInfo => fileInfo.exported && fileInfo.relative_path);
  }

  function imageFileInfos(post) {
    return exportedFileInfos(post).filter(isImageFile);
  }

  function otherFileInfos(post) {
    return exportedFileInfos(post).filter(fileInfo => !isImageFile(fileInfo));
  }

  async function countImportStats(posts) {
    let images = 0;
    let otherFiles = 0;
    let missingFiles = 0;

    for (const post of posts) {
      for (const fileInfo of post.file_infos || []) {
        if (!fileInfo.exported || !fileInfo.relative_path) continue;

        const file = await getExportFile(fileInfo.relative_path);
        if (!file) missingFiles += 1;

        if (isImageFile(fileInfo)) images += 1;
        else otherFiles += 1;
      }
    }

    return {
      messages: posts.length,
      images,
      otherFiles,
      missingFiles
    };
  }

  function originalMessagePrefix(post) {
    return `${userName(post.user_id)} · ${formatMattermostTime(post.create_at)}`;
  }

  function mattermostMeta(channel, post, extra = {}) {
    return {
      source: "mattermost-static-local-export",
      channel_id: channel.id,
      channel_name: channelTitle(channel),
      channel_type: channel.type || "",
      post_id: post.id,
      root_id: post.root_id || "",
      parent_id: post.parent_id || "",
      user_id: post.user_id || "",
      sender_name: userName(post.user_id),
      create_at: post.create_at || 0,
      ...extra
    };
  }

  function makeTextItem(channel, post, options = {}) {
    const prefix = originalMessagePrefix(post);
    const message = String(post.message || "").trim();
    const body = message ? `${prefix}\n${message}` : `${prefix}\n${options.fallbackText || "[attachment message]"}`;

    const formattedPrefix = `<strong>${escapeHtml(userName(post.user_id))}</strong> <span data-mx-color="#687076">· ${escapeHtml(formatMattermostTime(post.create_at))}</span>`;
    const formattedBody = message
      ? `${formattedPrefix}<br>${htmlFromPlainText(message)}`
      : `${formattedPrefix}<br><em>${escapeHtml(options.fallbackText || "attachment message")}</em>`;

    return {
      kind: "text",
      body,
      formatted_body: formattedBody,
      shortLabel: post.id,
      meta: mattermostMeta(channel, post, options.meta || {}),
      gallery: options.gallery || null
    };
  }

  async function makeFileForImport(fileInfo) {
    const sourceFile = await getExportFile(fileInfo.relative_path);

    if (!sourceFile) {
      return null;
    }

    const targetName = fileInfo.name || sourceFile.name || fileInfo.id || "mattermost-file";
    const type = fileInfo.mime_type || sourceFile.type || "application/octet-stream";

    return new File([sourceFile], targetName, {
      type,
      lastModified: sourceFile.lastModified || Date.now()
    });
  }

  function makeFileItem(channel, post, fileInfo, file, options = {}) {
    return {
      kind: "file",
      file,
      fileMeta: {
        name: fileInfo.name || file.name,
        type: fileInfo.mime_type || file.type || "application/octet-stream",
        size: fileInfo.size || file.size || 0,
        width: fileInfo.width || 0,
        height: fileInfo.height || 0
      },
      meta: mattermostMeta(channel, post, {
        ...(options.meta || {}),
        file_id: fileInfo.id || "",
        file_name: fileInfo.name || "",
        mime_type: fileInfo.mime_type || ""
      }),
      gallery: options.gallery || null
    };
  }

  function createGalleryId(channel, post) {
    return `mm_gallery_${channel.id}_${post.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  async function buildItemsForPost(channel, post, includeOtherFiles) {
    const items = [];
    const images = imageFileInfos(post);
    const otherFiles = includeOtherFiles ? otherFileInfos(post) : [];
    const hasText = Boolean(String(post.message || "").trim());

    if (images.length > 0) {
      const galleryId = createGalleryId(channel, post);
      const gallery = { id: galleryId, count: images.length };

      items.push(makeTextItem(channel, post, {
        fallbackText: `${images.length} image attachment${images.length === 1 ? "" : "s"}`,
        gallery,
        meta: {
          gallery_id: galleryId,
          gallery_count: images.length
        }
      }));

      for (let index = 0; index < images.length; index++) {
        const fileInfo = images[index];
        const file = await makeFileForImport(fileInfo);
        if (!file) continue;

        items.push(makeFileItem(channel, post, fileInfo, file, {
          gallery: {
            id: galleryId,
            index,
            count: images.length,
            caption: fileInfo.name || ""
          },
          meta: {
            gallery_id: galleryId,
            gallery_index: index,
            gallery_count: images.length
          }
        }));
      }
    } else if (hasText || otherFiles.length === 0) {
      items.push(makeTextItem(channel, post));
    }

    if (otherFiles.length > 0) {
      if (!hasText && images.length === 0) {
        items.push(makeTextItem(channel, post, {
          fallbackText: `${otherFiles.length} file attachment${otherFiles.length === 1 ? "" : "s"}`
        }));
      }

      for (const fileInfo of otherFiles) {
        const file = await makeFileForImport(fileInfo);
        if (!file) continue;
        items.push(makeFileItem(channel, post, fileInfo, file));
      }
    }

    return items;
  }

  function sendItemsViaPageBridge(room, items, log) {
    const requestId = `mmi_send_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Live Element MatrixClient send timed out"));
      }, 180000);

      const onMessage = event => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== PAGE_BRIDGE_SOURCE) return;
        if (event.data.requestId !== requestId) return;

        if (event.data.type === PAGE_BRIDGE_SEND_PROGRESS) {
          log(event.data.message || "Sending ...");
          return;
        }

        if (event.data.type === PAGE_BRIDGE_SEND_RESPONSE) {
          cleanup();

          if (event.data.ok) {
            resolve(event.data.result || {});
          } else {
            reject(new Error(event.data.error || "Live Element MatrixClient send failed"));
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);

      window.postMessage({
        type: PAGE_BRIDGE_SEND_REQUEST,
        requestId,
        room,
        items
      }, window.location.origin);
    });
  }

  async function importSelectedChannel(root) {
    if (state.importing) return;
    if (!state.selectedChannel) throw new Error("No Mattermost channel selected.");

    const room = detectCurrentRoomIdOrAlias();
    if (!room) throw new Error("Could not detect the current Matrix room from the URL.");

    state.importing = true;

    try {
      const includeOtherFiles = qs("#mmi-other-files", root).checked;
      state.config.includeOtherFiles = includeOtherFiles;
      await saveConfig();

      const channel = state.selectedChannel;
      const posts = await loadPostsForChannel(channel);
      const stats = await countImportStats(posts);

      const confirmed = window.confirm(
        `Really import ${stats.messages} messages and ${stats.images} images into the current Matrix room?\n\n` +
        `Source: ${channelTitle(channel)}\n` +
        `Other exported files: ${includeOtherFiles ? stats.otherFiles : 0}\n` +
        `Missing exported files in selected folder: ${stats.missingFiles}`
      );

      if (!confirmed) {
        appendLog(root, "Import cancelled.");
        return;
      }

      qs("#mmi-status", root).textContent = "Importing…";
      appendLog(root, `Importing ${stats.messages} messages, ${stats.images} images into ${room}`);

      const startItem = {
        kind: "text",
        msgtype: "m.notice",
        body: `Mattermost import started: ${channelTitle(channel)} (${stats.messages} messages, ${stats.images} images).`,
        shortLabel: "import-start",
        meta: {
          source: "mattermost-static-local-export",
          type: "import-start",
          channel_id: channel.id,
          channel_name: channelTitle(channel),
          message_count: stats.messages,
          image_count: stats.images,
          other_file_count: includeOtherFiles ? stats.otherFiles : 0
        }
      };

      await sendItemsViaPageBridge(room, [startItem], text => appendLog(root, text));

      let importedPosts = 0;
      let importedImages = 0;
      let importedFiles = 0;

      for (const post of posts) {
        const items = await buildItemsForPost(channel, post, includeOtherFiles);

        if (items.length === 0) {
          importedPosts += 1;
          continue;
        }

        await sendItemsViaPageBridge(room, items, text => appendLog(root, text));

        importedPosts += 1;
        importedImages += imageFileInfos(post).length;
        importedFiles += includeOtherFiles ? otherFileInfos(post).length : 0;

        qs("#mmi-status", root).textContent = `Imported ${importedPosts}/${stats.messages} messages, ${importedImages}/${stats.images} images.`;
        appendLog(root, `Imported post ${importedPosts}/${stats.messages}: ${post.id}`);

        await sleep(100);
      }

      const finishItem = {
        kind: "text",
        msgtype: "m.notice",
        body: `Mattermost import finished: ${channelTitle(channel)} (${importedPosts} messages, ${importedImages} images, ${importedFiles} files).`,
        shortLabel: "import-finished",
        meta: {
          source: "mattermost-static-local-export",
          type: "import-finished",
          channel_id: channel.id,
          channel_name: channelTitle(channel),
          message_count: importedPosts,
          image_count: importedImages,
          other_file_count: importedFiles
        }
      };

      await sendItemsViaPageBridge(room, [finishItem], text => appendLog(root, text));

      qs("#mmi-status", root).textContent = "Done.";
      appendLog(root, "Import finished.");
    } finally {
      state.importing = false;
    }
  }

  function qs(selector, root = document) {
    return root.querySelector(selector);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function updateSessionUiIfOpen() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;

    const target = qs("#mmi-session", overlay);
    if (!target) return;

    if (state.pageSession) {
      target.textContent = [
        state.pageSession.homeserver || "homeserver unknown",
        state.pageSession.userId || "user unknown"
      ].join(" · ");
    } else {
      target.textContent = "Waiting for live Element MatrixClient…";
    }
  }

  function appendLog(root, text) {
    const log = qs("#mmi-log", root);
    if (!log) return;

    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    log.textContent = log.textContent ? `${log.textContent}\n${line}` : line;
    log.scrollTop = log.scrollHeight;
  }

  function renderScopes(root) {
    const container = qs("#mmi-scope-list", root);

    container.innerHTML = state.scopes.map(scope => {
      const active = state.selectedScope && scope.type === state.selectedScope.type && scope.id === state.selectedScope.id ? " active" : "";

      return `
        <button class="mmi-list-button${active}" data-scope-type="${escapeHtml(scope.type)}" data-scope-id="${escapeHtml(scope.id)}">
          <div class="mmi-title">${escapeHtml(scope.title)}</div>
          <div class="mmi-subtitle">${escapeHtml(scope.subtitle)}</div>
        </button>
      `;
    }).join("") || `<div class="mmi-small">No teams or direct messages found.</div>`;
  }

  function renderChannels(root) {
    const container = qs("#mmi-channel-list", root);
    const channels = channelsForScope(state.selectedScope);

    container.innerHTML = channels.map(channel => {
      const active = state.selectedChannel && channel.id === state.selectedChannel.id ? " active" : "";

      return `
        <button class="mmi-list-button${active}" data-channel-id="${escapeHtml(channel.id)}">
          <div class="mmi-title">${escapeHtml(channelTitle(channel))}</div>
          <div class="mmi-subtitle">${escapeHtml(channelTypeLabel(channel.type))} · ${channel.post_count || 0} messages</div>
        </button>
      `;
    }).join("") || `<div class="mmi-small">No channels in this group.</div>`;
  }

  async function renderPreview(root) {
    const preview = qs("#mmi-preview", root);

    if (!state.loaded) {
      preview.innerHTML = `
        <div class="mmi-preview-card">
          <h4>No local export loaded</h4>
          <div class="mmi-small">Select the export folder. Only manifest.json and users.json are read initially.</div>
        </div>
      `;
      return;
    }

    if (!state.selectedChannel) {
      preview.innerHTML = `
        <div class="mmi-preview-card">
          <h4>No channel selected</h4>
          <div class="mmi-small">Select a team/DM and a channel.</div>
        </div>
      `;
      return;
    }

    preview.innerHTML = `
      <div class="mmi-preview-card">
        <h4>${escapeHtml(channelTitle(state.selectedChannel))}</h4>
        <div class="mmi-small">Loading channel stats…</div>
      </div>
    `;

    const posts = await loadPostsForChannel(state.selectedChannel);
    const stats = await countImportStats(posts);

    preview.innerHTML = `
      <div class="mmi-preview-card">
        <h4>${escapeHtml(channelTitle(state.selectedChannel))}</h4>
        <div class="mmi-preview-row"><span>Messages</span><strong>${stats.messages}</strong></div>
        <div class="mmi-preview-row"><span>Images</span><strong>${stats.images}</strong></div>
        <div class="mmi-preview-row"><span>Other exported files</span><strong>${stats.otherFiles}</strong></div>
        <div class="mmi-preview-row"><span>Missing files</span><strong>${stats.missingFiles}</strong></div>
        <div class="mmi-preview-row"><span>Channel ID</span><span>${escapeHtml(state.selectedChannel.id)}</span></div>
      </div>
    `;
  }

  function renderLoadedUi(root) {
    renderScopes(root);
    renderChannels(root);

    const importButton = qs("#mmi-import", root);
    if (importButton) {
      importButton.disabled = !state.loaded || !state.selectedChannel;
    }

    renderPreview(root).catch(error => appendLog(root, `Preview error: ${error.message || error}`));
  }

  function openModal() {
    const existing = document.getElementById(OVERLAY_ID);

    if (existing) {
      existing.remove();
      return;
    }

    requestPageSession();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "mmi-overlay";

    overlay.innerHTML = `
      <div class="mmi-modal" role="dialog" aria-modal="true">
        <div class="mmi-header">
          <div>
            <h2>Import local Mattermost export into this Matrix room</h2>
            <div class="mmi-small">Current Matrix target: ${escapeHtml(detectCurrentRoomIdOrAlias() || "not detected")}</div>
            <div class="mmi-small" id="mmi-session">Waiting for live Element MatrixClient…</div>
            <div class="mmi-warning">Lazy local mode: first only manifest.json and users.json are read. Channel post chunks and assets are opened only after you select/import one channel.</div>
          </div>
          <button class="mmi-close" id="mmi-close" title="Close">×</button>
        </div>

        <div class="mmi-controls">
          <button id="mmi-select-folder">Select export folder metadata</button>
          <button id="mmi-import" ${state.loaded ? "" : "disabled"}>Import selected channel</button>
          <label><input id="mmi-other-files" type="checkbox" ${state.config.includeOtherFiles ? "checked" : ""}> Import non-image files if present</label>
        </div>

        <div class="mmi-body">
          <div class="mmi-pane">
            <h3>Teams / DMs</h3>
            <div id="mmi-scope-list"></div>
          </div>

          <div class="mmi-pane">
            <h3>Channels</h3>
            <div id="mmi-channel-list"></div>
          </div>

          <div class="mmi-pane">
            <h3>Preview</h3>
            <div id="mmi-preview"></div>
            <h3>Log</h3>
            <div id="mmi-log" class="mmi-log"></div>
          </div>
        </div>

        <div class="mmi-footer">
          <div class="mmi-progress" id="mmi-status">Ready.</div>
          <button class="mmi-secondary-button" id="mmi-close-footer">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    updateSessionUiIfOpen();

    qs("#mmi-close", overlay).addEventListener("click", () => overlay.remove());
    qs("#mmi-close-footer", overlay).addEventListener("click", () => overlay.remove());

    qs("#mmi-select-folder", overlay).addEventListener("click", async () => {
      try {
        qs("#mmi-status", overlay).textContent = "Opening local export folder…";

        await selectExportFolderLazily();
        await loadExportFromSelectedFolder();

        qs("#mmi-import", overlay).disabled = true;
        qs("#mmi-status", overlay).textContent = `Loaded metadata from ${state.rootName}. Select one channel to preview/import.`;
        appendLog(overlay, `Loaded metadata only: ${state.rootName}`);
        appendLog(overlay, "No post chunks or assets have been read yet.");
        renderLoadedUi(overlay);
      } catch (error) {
        qs("#mmi-status", overlay).textContent = "Error.";
        appendLog(overlay, `Lazy folder load error: ${error.message || error}`);
        appendLog(overlay, "Fallback is possible but enumerates all files and is not recommended for very large exports.");
      }
    });

    qs("#mmi-import", overlay).addEventListener("click", async () => {
      try {
        await importSelectedChannel(overlay);
      } catch (error) {
        qs("#mmi-status", overlay).textContent = "Error.";
        appendLog(overlay, `Import error: ${error.message || error}`);
      }
    });

    overlay.addEventListener("click", event => {
      const scopeButton = event.target.closest("[data-scope-type][data-scope-id]");
      const channelButton = event.target.closest("[data-channel-id]");

      if (scopeButton) {
        const type = scopeButton.getAttribute("data-scope-type");
        const id = scopeButton.getAttribute("data-scope-id");

        state.selectedScope = state.scopes.find(scope => scope.type === type && scope.id === id) || null;
        state.selectedChannel = null;
        renderLoadedUi(overlay);
      }

      if (channelButton) {
        const channelId = channelButton.getAttribute("data-channel-id");
        state.selectedChannel = allChannels().find(channel => channel.id === channelId) || null;
        renderLoadedUi(overlay);
      }
    });

    renderLoadedUi(overlay);
  }
})();
