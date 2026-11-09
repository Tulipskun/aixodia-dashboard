import test from 'node:test';
import assert from 'node:assert/strict';
import { getEngineStatus, proxyEngine, listDevices, getDeviceTools, callDeviceTool } from '../worker/integrations.js';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});
const originalFetch = globalThis.fetch;

test('engine status discovers daemon/url from AIXODIA_CONFIG and reports real metrics', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/storage/kv/namespaces?')) {
      return jsonResponse({ success: true, result: [{ id: 'config-kv', title: 'AIXODIA_CONFIG' }] });
    }
    if (url.includes('/values/daemon%2Furl')) {
      return new Response('https://engine.aixodia.dpdns.org');
    }
    if (url.endsWith('/healthz')) {
      return jsonResponse({
        ok: true, version: 'v1.176', uptime_seconds: 12345,
        cpu_percent: 13.5, memory_used_bytes: 2048, memory_total_bytes: 4096, memory_percent: 50,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const status = await getEngineStatus({ CF_TOKEN: 'worker-token' });
    assert.equal(status.online, true);
    assert.equal(status.version, 'v1.176');
    assert.equal(status.metrics.cpuPercent, 13.5);
    assert.equal(status.metrics.memoryPercent, 50);
    assert.ok(calls.some(call => call.url.includes('/values/daemon%2Furl')));
    assert.equal(calls.at(-1).url, 'https://engine.aixodia.dpdns.org/healthz');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('engine status does not invent metrics while offline or unconfigured', async () => {
  const status = await getEngineStatus({});
  assert.equal(status.online, false);
  assert.equal(status.configured, false);
  assert.equal(status.metrics, null);
});

test('engine proxy permits only the required chat API routes and injects the server token', async () => {
  let captured;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/storage/kv/namespaces?')) return jsonResponse({ success: true, result: [{ id: 'config-kv', title: 'AIXODIA_CONFIG' }] });
    if (url.includes('/values/daemon%2Furl')) return new Response('https://engine.aixodia.dpdns.org');
    captured = { url, init };
    return jsonResponse({ sessions: [] });
  };
  try {
    const request = new Request('https://dashboard.example/api/engine/v1/sessions?limit=20', {
      headers: { cookie: 'must-not-forward=1', accept: 'application/json' },
    });
    const response = await proxyEngine(request, { CF_TOKEN: 'server-secret' }, '/v1/sessions');
    assert.equal(response.status, 200);
    assert.equal(captured.url, 'https://engine.aixodia.dpdns.org/v1/sessions?limit=20');
    assert.equal(new Headers(captured.init.headers).get('authorization'), 'Bearer server-secret');
    assert.equal(new Headers(captured.init.headers).get('cookie'), null);
    const blocked = await proxyEngine(request, { CF_TOKEN: 'server-secret' }, '/api/files');
    assert.equal(blocked.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('device discovery only probes registered device keys and returns online status', async () => {
  const requests = [];
  const env = {
    DEVICE_TUNNELS: {
      async list() { return { keys: [{ name: 'pixel-8' }, { name: '../bad' }], list_complete: true }; },
    },
    MCP_GATEWAY: {
      async fetch(request) {
        requests.push(request);
        const body = await request.json();
        assert.equal(body.method, 'initialize');
        assert.equal(body.params.clientInfo.name, 'AIxodia Dashboard');
        assert.equal(request.headers.get('origin'), 'null');
        return jsonResponse({ result: { serverInfo: { name: 'Droid-MCP', version: '1.2.3' } } });
      },
    },
  };
  const result = await listDevices(env, { refresh: true });
  const value = await result.json();
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].id, 'pixel-8');
  assert.equal(value.items[0].status.online, true);
  assert.equal(value.items[0].status.version, '1.2.3');
  assert.equal(requests.length, 1);
});

test('MCP tools and device actions use protocol headers and capture observed screenshots', async () => {
  const requests = [];
  const env = {
    MCP_GATEWAY: {
      async fetch(request) {
        requests.push(request);
        const body = await request.json();
        if (body.method === 'tools/list') return jsonResponse({ result: { tools: [{ name: 'tap' }] } });
        assert.equal(body.method, 'tools/call');
        assert.equal(body.params.name, 'act_and_observe');
        assert.equal(body.params.arguments.action.name, 'tap');
        assert.equal(body.params.arguments.action.x, 10);
        return jsonResponse({ result: { isError: false, content: [
          { type: 'text', text: 'action completed' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ] } });
      },
    },
  };
  const tools = await getDeviceTools(env, 'pixel-8');
  assert.deepEqual(await tools.json(), { tools: [{ name: 'tap' }] });
  const action = await callDeviceTool(env, 'pixel-8', 'tap', { x: 10, y: 20 });
  const value = await action.json();
  assert.equal(value.ok, true);
  assert.equal(value.screenshot.data, 'aGVsbG8=');
  assert.equal(requests[1].headers.get('mcp-protocol-version'), '2025-11-25');
});

test('device actions reject unlisted tools and invalid device identifiers', async () => {
  const denied = await callDeviceTool({}, 'pixel-8', 'shell', {});
  assert.equal(denied.status, 400);
  const tools = await getDeviceTools({}, '../wrong');
  assert.equal(tools.status, 502);
});
