// db.js — IndexedDB helper for EH Downloader
// Supports: completed log, resume info, settings backup/export

export const DB_NAME = "ehdl_db_v2";
export const STORE_COMPLETED = "completed";
export const STORE_RESUME = "resume";
export const STORE_SETTINGS = "settings_backup";

export function openDB() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 2);
        r.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_COMPLETED))
                db.createObjectStore(STORE_COMPLETED, { keyPath: "url" });

            if (!db.objectStoreNames.contains(STORE_RESUME))
                db.createObjectStore(STORE_RESUME, { keyPath: "url" });

            if (!db.objectStoreNames.contains(STORE_SETTINGS))
                db.createObjectStore(STORE_SETTINGS, { keyPath: "id" });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

export async function dbPut(store, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const s = tx.objectStore(store);
        const req = s.put(value);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function dbGet(store, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const s = tx.objectStore(store);
        const req = s.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function dbDel(store, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const s = tx.objectStore(store);
        const req = s.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

export async function dbGetAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const s = tx.objectStore(store);
        const req = s.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

// Backup entire DB into one JSON blob
export async function exportBackup() {
    const completed = await dbGetAll(STORE_COMPLETED);
    const resume = await dbGetAll(STORE_RESUME);
    const settings = await dbGetAll(STORE_SETTINGS);

    return JSON.stringify(
        {
            timestamp: Date.now(),
            completed,
            resume,
            settings
        },
        null,
        2
    );
}

// Restore backup JSON
export async function importBackup(json) {
    const data = JSON.parse(json);

    if (data.completed) {
        for (const x of data.completed)
            await dbPut(STORE_COMPLETED, x);
    }
    if (data.resume) {
        for (const x of data.resume)
            await dbPut(STORE_RESUME, x);
    }
    if (data.settings) {
        for (const x of data.settings)
            await dbPut(STORE_SETTINGS, x);
    }

    return true;
}
