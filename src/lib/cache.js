function normalizeTtl(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createMemoryCache({ defaultTtlMs = 0 } = {}) {
    const store = new Map();

    function get(key) {
        const entry = store.get(key);
        if (!entry) {
            return null;
        }

        if (entry.expiresAt <= Date.now()) {
            store.delete(key);
            return null;
        }

        return {
            value: entry.value,
            ttlMs: entry.expiresAt - Date.now()
        };
    }

    function set(key, value, ttlMs = defaultTtlMs) {
        if (!ttlMs) {
            return value;
        }

        store.set(key, {
            value,
            expiresAt: Date.now() + ttlMs
        });

        return value;
    }

    function clear() {
        store.clear();
    }

    return {
        clear,
        get,
        set
    };
}

module.exports = {
    createMemoryCache,
    normalizeTtl
};
