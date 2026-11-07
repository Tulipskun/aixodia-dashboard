// Local JSON-RPC stub that mimics a healthy DroidIME MCP device.
// Used only for E2E tests while the real device is offline.
// It also enforces the real device's Origin rule, so a proxy that leaks Origin
// would fail the test exactly like it would against the real endpoint.
import http from 'node:http'
import { PNG_BASE64 } from './screen-png.mjs'

// Re-exported so api.test.mjs and the UI verifier share one fixture image.
export { PNG_BASE64 }

export async function startStub(port = 0) {
  const seen = []
  const server = http.createServer((req, res) => {
    if (req.headers.origin && req.headers.origin !== 'null') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Invalid Origin' } }))
      return
    }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let rpc
      try {
        rpc = JSON.parse(raw || '{}')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      seen.push({ url: req.url, headers: req.headers, body: rpc })

      let result
      if (rpc.method === 'server/discover') {
        result = { supportedVersions: ['2025-11-25', '2025-06-18', '2025-03-26'] }
      } else if (rpc.method === 'tools/list') {
        result = { tools: [{ name: 'tap', description: 'Tap', inputSchema: { type: 'object' } }] }
      } else if (rpc.method === 'tools/call') {
        result = {
          isError: false,
          resultType: 'complete',
          content: [
            { type: 'text', text: `${rpc.params?.name || 'tool'} completed` },
            { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
          ],
        }
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
