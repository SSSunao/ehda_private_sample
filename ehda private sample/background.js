// background.js (Manifest V3 service worker)
// EH Downloader — background: queue, download orchestration, bandwidth throttle, cancel, history, settings

// ---------- Defaults ----------
const DEFAULT_SETTINGS = {
  sleepMsBetweenStarts: 800,
  concurrentImages: 1,   // per-gallery concurrency (images started at once)
  bandwidthKBps: 0,      // 0 = no limit
  filenameTemplate: "{gallery_title}/{index}_{orig_name}",
  createPerGalleryFolder: true,
  lang: "ja",
  theme: "light"
};

// ---------- State ----------
let settings = Object.assign({}, DEFAULT_SETTINGS);
let queue = []; // FIFO of { title, galleryId, images:[], tabId }
let processing = false;
const activeGalleryState = new Map(); // galleryId -> { running, abortRequested, currentIndex, total }
const activeDownloadIds = new Map(); // galleryId -> [downloadId,...]
const downloadIdToGallery = new Map(); // downloadId -> galleryId

// bandwidth tracking
let bandwidthLimitKBps = 0;
let bandwidthWindowEnd = Date.now() + 1000;
let bandwidthUsedKB = 0;

// IndexedDB for history/resume
const DB_NAME = "ehdl_db_v1";
const STORE_COMPLETED = "completed";
const STORE_RESUME = "resume";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_COMPLETED)) db.createObjectStore(STORE_COMPLETED, { keyPath: "galleryId" });
      if (!db.objectStoreNames.contains(STORE_RESUME)) db.createObjectStore(STORE_RESUME, { keyPath: "galleryId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(store, obj) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const r = s.put(obj);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const r = s.get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbDel(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const r = s.delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const r = s.getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

// ---------- Utility ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitize(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 200); }
function buildFilename(template, meta) {
  let t = template || DEFAULT_SETTINGS.filenameTemplate;
  t = t.replace(/\{gallery_title\}/g, sanitize(meta.gallery_title || "gallery"));
  t = t.replace(/\{gallery_id\}/g, meta.galleryId || "");
  t = t.replace(/\{index\}/g, String(meta.index || 0).padStart(3, "0"));
  t = t.replace(/\{orig_name\}/g, sanitize(meta.orig_name || "img"));
  t = t.replace(/\{total\}/g, String(meta.total || ""));
  if (settings.createPerGalleryFolder) {
    if (!t.startsWith(sanitize(meta.gallery_title || "gallery") + "/")) {
      t = sanitize(meta.gallery_title || "gallery") + "/" + t;
    }
  }
  // ensure extension exists if not
  if (!/\.[a-z0-9]{2,6}$/i.test(t)) t += ".jpg";
  return t;
}

// ---------- Bandwidth helpers ----------
async function headContentLength(url) {
  try {
    const r = await fetch(url, { method: "HEAD", credentials: "include" });
    if (!r.ok) return 0;
    const cl = r.headers.get("content-length");
    return cl ? Number(cl) : 0;
  } catch (e) { return 0; }
}
async function throttleByBytes(bytes) {
  if (!bandwidthLimitKBps || bandwidthLimitKBps <= 0) return;
  const now = Date.now();
  if (now >= bandwidthWindowEnd) {
    bandwidthWindowEnd = now + 1000;
    bandwidthUsedKB = 0;
  }
  const kb = bytes / 1024;
  if (bandwidthUsedKB + kb > bandwidthLimitKBps) {
    const wait = bandwidthWindowEnd - now;
    if (wait > 0) await sleep(wait);
    bandwidthWindowEnd = Date.now() + 1000;
    bandwidthUsedKB = 0;
  }
  bandwidthUsedKB += kb;
}

// ---------- Download tracking ----------
function recordDownloadId(galleryId, downloadId) {
  if (!activeDownloadIds.has(galleryId)) activeDownloadIds.set(galleryId, []);
  activeDownloadIds.get(galleryId).push(downloadId);
  downloadIdToGallery.set(downloadId, galleryId);
}
function removeDownloadId(downloadId) {
  const gid = downloadIdToGallery.get(downloadId);
  if (!gid) return;
  const arr = activeDownloadIds.get(gid) || [];
  const idx = arr.indexOf(downloadId);
  if (idx >= 0) arr.splice(idx, 1);
  if (arr.length === 0) activeDownloadIds.delete(gid);
  downloadIdToGallery.delete(downloadId);
}
async function cancelGalleryDownloads(galleryId) {
  const arr = activeDownloadIds.get(galleryId) || [];
  for (const id of arr.slice()) {
    try { await new Promise(r => chrome.downloads.cancel(id, () => r())); } catch (e) { /* ignore */ }
    downloadIdToGallery.delete(id);
  }
  activeDownloadIds.delete(galleryId);
}

// wrapper to start chrome.downloads and record id
function startChromeDownload(url, filename, galleryId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: "uniquify" }, id => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      recordDownloadId(galleryId, id);
      resolve(id);
    });
  });
}

// listen downloads.onChanged to remove finished ids and notify
chrome.downloads.onChanged.addListener(delta => {
  try {
    if (!delta || !delta.id) return;
    if (delta.state && delta.state.current === "complete") {
      removeDownloadId(delta.id);
      // optionally notify progress complete (popup/content will get previous progress events)
    } else if (delta.state && delta.state.current === "interrupted") {
      removeDownloadId(delta.id);
      const gid = downloadIdToGallery.get(delta.id);
      if (gid) {
        chrome.runtime.sendMessage({ type: "DOWNLOAD_ERROR", galleryId: gid, message: "download interrupted" });
      }
    }
  } catch (e) { console.error(e); }
});

// ---------- Queue processing ----------
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift(); // { title, galleryId, images, tabId }
      if (!item) continue;
      const galleryId = String(item.galleryId);
      const title = item.title || `gallery_${galleryId}`;
      const images = Array.isArray(item.images) ? item.images.filter(Boolean) : [];
      const total = images.length;

      // notify preparing
      chrome.runtime.sendMessage({ type: "DOWNLOAD_STATUS", galleryId, status: "preparing", title });

      activeGalleryState.set(galleryId, { running: true, abortRequested: false, currentIndex: 0, total });

      const concurrency = Math.max(1, Number(settings.concurrentImages || DEFAULT_SETTINGS.concurrentImages));

      let idx = 0;
      // create worker pool
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          const st = activeGalleryState.get(galleryId);
          if (!st || st.abortRequested) break;
          const currentIndex = idx;
          if (currentIndex >= images.length) break;
          idx++;
          const url = images[currentIndex];
          if (!url) continue;

          // send per-image start status
          chrome.runtime.sendMessage({ type: "DOWNLOAD_STATUS", galleryId, status: "downloading", index: currentIndex + 1, total, title });

          // throttle by file size if bandwidth limit
          if (bandwidthLimitKBps > 0) {
            const size = await headContentLength(url);
            if (size > 0) await throttleByBytes(size);
          }

          const meta = { gallery_title: title, galleryId, index: currentIndex + 1, orig_name: (url.split('/').pop().split('?')[0] || `img${currentIndex+1}`), total };
          const filename = buildFilename(settings.filenameTemplate, meta);

          try {
            await startChromeDownload(url, filename, galleryId);
            // notify progress started
            chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", galleryId, current: currentIndex + 1, total });
          } catch (e) {
            console.error("download start error", e);
            // store resume/error
            await dbPut(STORE_RESUME, { galleryId, last_error: true, last_error_msg: String(e), ts: Date.now() });
            chrome.runtime.sendMessage({ type: "DOWNLOAD_ERROR", galleryId, message: String(e) });
            // abort gallery
            const st2 = activeGalleryState.get(galleryId);
            if (st2) st2.abortRequested = true;
            break;
          }

          // small gap between starts
          await sleep(Number(settings.sleepMsBetweenStarts || DEFAULT_SETTINGS.sleepMsBetweenStarts));
        }
      });

      await Promise.all(workers);

      // if aborted, cancel remaining downloads and mark resume
      const stateAfter = activeGalleryState.get(galleryId);
      if (stateAfter && stateAfter.abortRequested) {
        await cancelGalleryDownloads(galleryId);
        await dbPut(STORE_RESUME, { galleryId, last_error: true, last_error_msg: "aborted", ts: Date.now() });
        chrome.runtime.sendMessage({ type: "DOWNLOAD_ERROR", galleryId, message: "aborted" });
        activeGalleryState.delete(galleryId);
        continue;
      }

      // wait until all download ids for this gallery are finished (downloads.onChanged will remove ids)
      const waitStart = Date.now();
      const waitTimeout = 1000 * 60 * 10; // 10 min safety
      while (true) {
        const arr = activeDownloadIds.get(galleryId) || [];
        if (arr.length === 0) break;
        if (Date.now() - waitStart > waitTimeout) {
          console.warn("timeout waiting downloads complete for", galleryId);
          break;
        }
        await sleep(500);
      }

      // mark completed
      await dbPut(STORE_COMPLETED, { galleryId, ts: Date.now(), meta: { title, total } });
      await dbDel(STORE_RESUME, galleryId).catch(()=>{});
      chrome.runtime.sendMessage({ type: "DOWNLOAD_FINISHED", galleryId });
      activeGalleryState.delete(galleryId);
      activeDownloadIds.delete(galleryId);
      downloadIdToGallery.forEach((v,k)=>{ if (v === galleryId) downloadIdToGallery.delete(k); });
    }
  } catch (e) {
    console.error("processQueue error", e);
  } finally {
    processing = false;
    // broadcast queue update
    chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
  }
}

// ---------- Message API ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) { sendResponse({ ok: false }); return; }

      switch (msg.type) {
        case "ADD_TO_QUEUE": {
          const g = msg.gallery;
          if (!g || !g.galleryId || !Array.isArray(g.images) || g.images.length === 0) {
            sendResponse({ ok: false, reason: "invalid_gallery" }); return;
          }
          const tabId = (sender && sender.tab && sender.tab.id) ? sender.tab.id : (g.tabId || null);
          queue.push({ title: g.title || `gallery_${g.galleryId}`, galleryId: String(g.galleryId), images: g.images, tabId });
          chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
          processQueue().catch(e=>console.error(e));
          sendResponse({ ok: true, queued: true });
          return;
        }
        case "STOP_GALLERY": {
          const gid = String(msg.galleryId);
          queue = queue.filter(x => x.galleryId !== gid);
          const st = activeGalleryState.get(gid);
          if (st) st.abortRequested = true;
          await cancelGalleryDownloads(gid);
          chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
          sendResponse({ ok: true });
          return;
        }
        case "STOP_ALL": {
          queue = [];
          for (const gid of Array.from(activeDownloadIds.keys())) {
            const st = activeGalleryState.get(gid);
            if (st) st.abortRequested = true;
            await cancelGalleryDownloads(gid);
          }
          chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
          sendResponse({ ok: true });
          return;
        }
        case "CHECK_DONE": {
          const gid = String(msg.galleryId);
          if (!gid) { sendResponse({ done: false }); return; }
          const rec = await dbGet(STORE_COMPLETED, gid).catch(()=>null);
          if (rec) sendResponse({ done: true });
          else {
            const resume = await dbGet(STORE_RESUME, gid).catch(()=>null);
            if (resume && resume.last_error) sendResponse({ done:false, error:true });
            else sendResponse({ done:false });
          }
          return;
        }
        case "GET_QUEUE": {
          sendResponse({ queue: queue.map(q => ({ title: q.title, galleryId: q.galleryId })) });
          return;
        }
        case "GET_SETTINGS": {
          sendResponse({ settings });
          return;
        }
        case "SAVE_SETTINGS": {
          settings = Object.assign({}, DEFAULT_SETTINGS, msg.settings || {});
          bandwidthLimitKBps = Number(settings.bandwidthKBps || 0);
          chrome.storage.local.set({ settings });
          sendResponse({ ok: true });
          return;
        }
        case "EXPORT_HISTORY": {
          const completed = await dbGetAll(STORE_COMPLETED).catch(()=>[]);
          const resume = await dbGetAll(STORE_RESUME).catch(()=>[]);
          const blob = new Blob([JSON.stringify({ ts: Date.now(), completed, resume }, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const filename = `ehdl-history-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
          chrome.downloads.download({ url, filename }, (id) => { setTimeout(()=>URL.revokeObjectURL(url), 15000); });
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, reason: "unknown" });
          return;
      }
    } catch (e) {
      console.error("bg message error", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // indicates async response
});

// ---------- init load settings ----------
chrome.storage.local.get(["settings"], res => {
  if (res && res.settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, res.settings);
    bandwidthLimitKBps = Number(settings.bandwidthKBps || 0);
  } else {
    settings = Object.assign({}, DEFAULT_SETTINGS);
    bandwidthLimitKBps = 0;
  }
  processQueue().catch(e => console.error(e));
});
