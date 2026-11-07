// DroidIME MCP tool catalog + strict argument validation.
// Verified against Tulipskun/droidime: ToolCatalog.kt + McpServer.kt (callTool).
// This module is the SINGLE source of truth for both the server-side validator
// and the dynamic UI form (GET /api/tools). Runtime-agnostic: no Node/Workers APIs.

export const TOOLS = [
  {
    name: 'tap',
    label: 'แตะหน้าจอ',
    description: 'Tap a screen coordinate using percentages of the current screen.',
    group: 'touch',
    fields: [
      { key: 'x', label: 'X', kind: 'percent', required: true, default: '50%', placeholder: '50%', hint: 'ตำแหน่งแนวนอน 0–100%' },
      { key: 'y', label: 'Y', kind: 'percent', required: true, default: '50%', placeholder: '50%', hint: 'ตำแหน่งแนวตั้ง 0–100%' },
    ],
  },
  {
    name: 'long_press',
    label: 'กดค้าง',
    description: 'Hold a screen coordinate for a duration. Defaults to 3 seconds.',
    group: 'touch',
    fields: [
      { key: 'x', label: 'X', kind: 'percent', required: true, default: '50%', placeholder: '50%' },
      { key: 'y', label: 'Y', kind: 'percent', required: true, default: '50%', placeholder: '50%' },
      { key: 'duration_ms', label: 'ระยะเวลา (ms)', kind: 'int', required: false, default: 3000, min: 200, max: 60000, hint: 'ค่าเริ่มต้น 3000, ต่ำสุด 200' },
    ],
  },
  {
    name: 'swipe',
    label: 'ปัดหน้าจอ',
    description: 'Swipe between percentage screen coordinates.',
    group: 'touch',
    fields: [
      { key: 'x1', label: 'X เริ่ม', kind: 'percent', required: true, default: '50%', placeholder: '50%' },
      { key: 'y1', label: 'Y เริ่ม', kind: 'percent', required: true, default: '80%', placeholder: '80%' },
      { key: 'x2', label: 'X สิ้นสุด', kind: 'percent', required: true, default: '50%', placeholder: '50%' },
      { key: 'y2', label: 'Y สิ้นสุด', kind: 'percent', required: true, default: '20%', placeholder: '20%' },
      { key: 'duration_ms', label: 'ระยะเวลา (ms)', kind: 'int', required: true, default: 400, min: 50, max: 10000, hint: 'บังคับ (device ใช้ getLong)' },
    ],
  },
  {
    name: 'gesture',
    label: 'เส้นทางสัมผัส',
    description: 'Execute a custom touch path (points: x, y, delay_ms).',
    group: 'advanced',
    fields: [
      { key: 'points', label: 'จุดสัมผัส (JSON)', kind: 'points', required: true, default: '[{"x":"50%","y":"80%","delay_ms":0},{"x":"50%","y":"20%","delay_ms":0}]', hint: 'อาร์เรย์ ≤32 จุด แต่ละจุดต้องมี x, y, delay_ms' },
    ],
  },
  {
    name: 'multi_touch',
    label: 'สัมผัสหลายนิ้ว',
    description: 'Execute multiple concurrent touch paths (pointers: id, points).',
    group: 'advanced',
    fields: [
      { key: 'pointers', label: 'Pointers (JSON)', kind: 'pointers', required: true, default: '[{"id":0,"points":[{"x":"40%","y":"50%","delay_ms":0}]}]', hint: 'อาร์เรย์ ≤10 pointers' },
    ],
  },
  {
    name: 'key_event',
    label: 'กดปุ่ม / คีย์',
    description: 'Press, hold, or press multiple Android keys simultaneously.',
    group: 'keys',
    fields: [
      { key: 'keycode', label: 'Keycode เดียว', kind: 'int', required: false, min: 0, max: 300, placeholder: 'เช่น 3 = HOME', hint: 'ใส่ keycode หรือ keycodes อย่างใดอย่างหนึ่ง' },
      { key: 'keycodes', label: 'Keycodes (JSON array)', kind: 'keycodes', required: false, default: '', placeholder: '[113, 29] = Ctrl+A', hint: '≤16 ค่า' },
      { key: 'hold_ms', label: 'กดค้าง (ms)', kind: 'int', required: false, default: 0, min: 0, max: 10000 },
    ],
  },
  {
    name: 'input_text',
    label: 'พิมพ์ข้อความ',
    description: 'Type text into the focused field.',
    group: 'keys',
    fields: [
      { key: 'text', label: 'ข้อความ', kind: 'text', required: true, default: '', maxLength: 1000, placeholder: 'พิมพ์ข้อความที่ต้องการ…', hint: '≤1000 ตัวอักษร, ไม่รับ control characters' },
    ],
  },
  {
    name: 'screenshot',
    label: 'ถ่ายภาพหน้าจอ',
    description: 'Capture the current screen as PNG.',
    group: 'keys',
    fields: [],
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

// Strip internal validator-only helpers before sending descriptors to the browser.
export function publicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description,
    group: t.group,
    fields: t.fields.map((f) => ({ ...f })),
  }))
}

export class ToolValidationError extends Error {
  constructor(message, code = 'INVALID_ARGUMENTS') {
    super(message)
    this.name = 'ToolValidationError'
    this.code = code
  }
}

// Device pattern (ToolCatalog.kt): ^ *([0-9]+([.][0-9]+)?)% *$
// We accept an OPTIONAL space before '%' for nicer UX, then always normalize to
// "<number>%" (no spaces) before sending, so the wire value still matches the
// device regex exactly.
const PERCENT_RE = /^ *([0-9]+(?:[.][0-9]+)?) *% *$/
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function percent(value, key) {
  let raw = value
  if (typeof value === 'number' && Number.isFinite(value)) raw = `${value}%`
  if (typeof raw !== 'string') {
    throw new ToolValidationError(`${key} ต้องเป็นเปอร์เซ็นต์เช่น "50%"`)
  }
  const m = PERCENT_RE.exec(raw)
  if (!m) throw new ToolValidationError(`${key} ไม่ตรงรูปแบบเปอร์เซ็นต์ (เช่น "50%")`)
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new ToolValidationError(`${key} ต้องอยู่ระหว่าง 0% ถึง 100%`)
  }
  return `${Number(n.toFixed(3))}%`
}

export function intField(value, key, opts = {}) {
  const { min = 0, max = 10000, required = false, fallback = undefined } = opts
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolValidationError(`${key} จำเป็นต้องระบุ`)
    return fallback
  }
  let n
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) n = Number(value.trim())
  else n = NaN
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolValidationError(`${key} ต้องเป็นจำนวนเต็มระหว่าง ${min} ถึง ${max}`)
  }
  return n
}

function parseJsonField(value, key) {
  if (Array.isArray(value) || isObject(value)) return value
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolValidationError(`${key} ต้องเป็น JSON array`)
  }
  try {
    return JSON.parse(value)
  } catch {
    throw new ToolValidationError(`${key} ไม่ใช่ JSON ที่ถูกต้อง`)
  }
}

function pointsArray(value, key = 'points') {
  const arr = parseJsonField(value, key)
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new ToolValidationError(`${key} ต้องเป็น array ที่มีอย่างน้อย 1 จุด`)
  }
  if (arr.length > 32) throw new ToolValidationError(`${key} ต้องมีไม่เกิน 32 จุด`)
  return arr.map((p, i) => {
    if (!isObject(p)) throw new ToolValidationError(`${key}[${i}] ต้องเป็น object`)
    return {
      x: percent(p.x, `${key}[${i}].x`),
      y: percent(p.y, `${key}[${i}].y`),
      delay_ms: intField(p.delay_ms, `${key}[${i}].delay_ms`, { min: 0, max: 10000, required: true }),
    }
  })
}

function pointersArray(value, key = 'pointers') {
  const arr = parseJsonField(value, key)
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new ToolValidationError(`${key} ต้องเป็น array ที่มีอย่างน้อย 1 pointer`)
  }
  if (arr.length > 10) throw new ToolValidationError(`${key} ต้องมีไม่เกิน 10 pointers`)
  return arr.map((p, i) => {
    if (!isObject(p)) throw new ToolValidationError(`${key}[${i}] ต้องเป็น object`)
    return {
      id: intField(p.id, `${key}[${i}].id`, { min: 0, max: 31, required: true }),
      points: pointsArray(p.points, `${key}[${i}].points`),
    }
  })
}

function keycodesArray(value) {
  const arr = parseJsonField(value, 'keycodes')
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new ToolValidationError('keycodes ต้องเป็น array ที่มีอย่างน้อย 1 ค่า')
  }
  if (arr.length > 16) throw new ToolValidationError('keycodes ต้องมีไม่เกิน 16 ค่า')
  return arr.map((k, i) => intField(k, `keycodes[${i}]`, { min: 0, max: 300, required: true }))
}

/**
 * Validate an action and BUILD A NEW arguments object from allowlisted keys only.
 * Never spreads the raw request object -> prevents argument/prototype injection.
 * Returns { name, arguments } ready for MCP tools/call params.
 */
export function validateTool(name, rawArgs) {
  const tool = TOOL_BY_NAME.get(String(name ?? ''))
  if (!tool) {
    throw new ToolValidationError(`Unknown tool: ${String(name ?? '')}`, 'UNKNOWN_TOOL')
  }
  const raw = isObject(rawArgs) ? rawArgs : {}
  const out = {}

  switch (tool.name) {
    case 'tap':
      out.x = percent(raw.x, 'x')
      out.y = percent(raw.y, 'y')
      break

    case 'long_press':
      out.x = percent(raw.x, 'x')
      out.y = percent(raw.y, 'y')
      out.duration_ms = intField(raw.duration_ms, 'duration_ms', { min: 200, max: 60000, fallback: 3000 })
      break

    case 'swipe':
      out.x1 = percent(raw.x1, 'x1')
      out.y1 = percent(raw.y1, 'y1')
      out.x2 = percent(raw.x2, 'x2')
      out.y2 = percent(raw.y2, 'y2')
      // McpServer.kt uses args.getLong("duration_ms") -> strictly required.
      out.duration_ms = intField(raw.duration_ms, 'duration_ms', { min: 50, max: 10000, required: true })
      break

    case 'gesture':
      out.points = pointsArray(raw.points)
      break

    case 'multi_touch':
      out.pointers = pointersArray(raw.pointers)
      break

    case 'key_event':
      if (raw.keycodes !== undefined && raw.keycodes !== null && raw.keycodes !== '') {
        out.keycodes = keycodesArray(raw.keycodes)
      } else {
        out.keycode = intField(raw.keycode, 'keycode', { min: 0, max: 300, required: true })
      }
      out.hold_ms = intField(raw.hold_ms, 'hold_ms', { min: 0, max: 10000, fallback: 0 })
      break

    case 'input_text': {
      const t = raw.text
      if (typeof t !== 'string' || t.length === 0) {
        throw new ToolValidationError('text จำเป็นต้องระบุ')
      }
      if (t.length > 1000) throw new ToolValidationError('text ต้องไม่เกิน 1000 ตัวอักษร')
      if (CONTROL_CHARS.test(t)) throw new ToolValidationError('text มี control character ที่ไม่รองรับ')
      out.text = t
      break
    }

    case 'screenshot':
      break
  }

  return { name: tool.name, arguments: out }
}
