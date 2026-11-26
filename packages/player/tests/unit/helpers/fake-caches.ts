/**
 * The Cache API reduced to a map: named caches that keep what is put with its headers, and answer
 * `match`, `keys` and `delete`. The chunk-store write test has its own, counting puts.
 */
export function fakeCaches() {
  const stored = new Map<string, { body: Uint8Array<ArrayBuffer>; headers: Headers }>()
  const cache = {
    async put(key: string, response: Response) {
      stored.set(key, { body: new Uint8Array(await response.arrayBuffer()), headers: response.headers })
    },
    async match(key: string) {
      const hit = stored.get(key)
      return hit ? new Response(hit.body, { headers: hit.headers }) : undefined
    },
    async keys() {
      return [...stored.keys()].map((key) => new Request(key))
    },
    async delete(request: Request | string) {
      return stored.delete(typeof request === 'string' ? request : request.url)
    }
  }
  return { open: async () => cache, has: async () => true, delete: async () => true, keys: async () => [] }
}
