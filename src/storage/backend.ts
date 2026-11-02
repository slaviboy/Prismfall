import { openDB, type IDBPDatabase } from 'idb';

export type StoreName = 'kv' | 'highscores' | 'replays' | 'userTracks';

/** Minimal storage contract shared by IndexedDB and the localStorage fallback. */
export interface SaveBackend {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  getKV<T>(key: string): Promise<T | undefined>;
  putKV(key: string, value: unknown): Promise<void>;
  deleteKV(key: string): Promise<void>;
  getAll<T>(store: Exclude<StoreName, 'kv'>): Promise<T[]>;
  get<T>(store: Exclude<StoreName, 'kv'>, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(store: Exclude<StoreName, 'kv'>, value: T): Promise<void>;
  delete(store: Exclude<StoreName, 'kv'>, id: string): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = 'prismfall';
const DB_VERSION = 1;

class IndexedDbBackend implements SaveBackend {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly db: IDBPDatabase) {}

  async getKV<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('kv', key)) as T | undefined;
  }
  async putKV(key: string, value: unknown): Promise<void> {
    await this.db.put('kv', value, key);
  }
  async deleteKV(key: string): Promise<void> {
    await this.db.delete('kv', key);
  }
  async getAll<T>(store: Exclude<StoreName, 'kv'>): Promise<T[]> {
    return (await this.db.getAll(store)) as T[];
  }
  async get<T>(store: Exclude<StoreName, 'kv'>, id: string): Promise<T | undefined> {
    return (await this.db.get(store, id)) as T | undefined;
  }
  async put<T extends { id: string }>(store: Exclude<StoreName, 'kv'>, value: T): Promise<void> {
    await this.db.put(store, value);
  }
  async delete(store: Exclude<StoreName, 'kv'>, id: string): Promise<void> {
    await this.db.delete(store, id);
  }
  async clearAll(): Promise<void> {
    const tx = this.db.transaction(['kv', 'highscores', 'replays', 'userTracks'], 'readwrite');
    await Promise.all([tx.objectStore('kv').clear(), tx.objectStore('highscores').clear(), tx.objectStore('replays').clear(), tx.objectStore('userTracks').clear(), tx.done]);
  }
}

/** Used when IndexedDB is unavailable (private browsing on some browsers). Blobs are not supported. */
class WebStorageBackend implements SaveBackend {
  readonly kind: 'localstorage' | 'memory';
  private readonly memory = new Map<string, string>();
  constructor(private readonly storage: Storage | null) {
    this.kind = storage ? 'localstorage' : 'memory';
  }
  private read(key: string): string | null {
    try {
      return this.storage ? this.storage.getItem(`${DB_NAME}:${key}`) : (this.memory.get(key) ?? null);
    } catch {
      return this.memory.get(key) ?? null;
    }
  }
  private write(key: string, value: string | null): void {
    try {
      if (!this.storage) throw new Error('no storage');
      if (value === null) this.storage.removeItem(`${DB_NAME}:${key}`);
      else this.storage.setItem(`${DB_NAME}:${key}`, value);
    } catch {
      if (value === null) this.memory.delete(key);
      else this.memory.set(key, value);
    }
  }
  async getKV<T>(key: string): Promise<T | undefined> {
    const raw = this.read(`kv:${key}`);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }
  async putKV(key: string, value: unknown): Promise<void> {
    this.write(`kv:${key}`, JSON.stringify(value));
  }
  async deleteKV(key: string): Promise<void> {
    this.write(`kv:${key}`, null);
  }
  private table<T extends { id: string }>(store: string): T[] {
    const raw = this.read(`store:${store}`);
    return raw ? (JSON.parse(raw) as T[]) : [];
  }
  async getAll<T>(store: Exclude<StoreName, 'kv'>): Promise<T[]> {
    return this.table<{ id: string }>(store) as T[];
  }
  async get<T>(store: Exclude<StoreName, 'kv'>, id: string): Promise<T | undefined> {
    return this.table<{ id: string }>(store).find((r) => r.id === id) as T | undefined;
  }
  async put<T extends { id: string }>(store: Exclude<StoreName, 'kv'>, value: T): Promise<void> {
    const rows = this.table<{ id: string }>(store).filter((r) => r.id !== value.id);
    rows.push(value);
    this.write(`store:${store}`, JSON.stringify(rows));
  }
  async delete(store: Exclude<StoreName, 'kv'>, id: string): Promise<void> {
    this.write(`store:${store}`, JSON.stringify(this.table<{ id: string }>(store).filter((r) => r.id !== id)));
  }
  async clearAll(): Promise<void> {
    this.memory.clear();
    if (!this.storage) return;
    for (const key of Object.keys(this.storage)) if (key.startsWith(`${DB_NAME}:`)) this.storage.removeItem(key);
  }
}

export async function openSaveBackend(factory: IDBFactory | null = globalThis.indexedDB ?? null, dbName = DB_NAME): Promise<SaveBackend> {
  if (factory) {
    try {
      const db = await openDB(dbName, DB_VERSION, {
        upgrade(database, oldVersion) {
          if (oldVersion < 1) {
            database.createObjectStore('kv');
            database.createObjectStore('highscores', { keyPath: 'id' }).createIndex('byKey', 'key');
            database.createObjectStore('replays', { keyPath: 'id' });
            database.createObjectStore('userTracks', { keyPath: 'id' });
          }
          // Future schema upgrades: if (oldVersion < 2) { ... }
        },
      });
      return new IndexedDbBackend(db);
    } catch (err) {
      console.warn('[storage] IndexedDB unavailable, falling back to localStorage', err);
    }
  }
  let storage: Storage | null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    storage = null;
  }
  return new WebStorageBackend(storage);
}

/** Asks the browser not to evict saves under storage pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
