require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const { posDB, crmDB } = require('./db')

const app  = express()
const PORT = process.env.PORT || 3000

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }))

// LINE webhook ต้องการ raw body เพื่อ verify signature
app.use('/api/line/webhook', express.raw({ type: 'application/json' }))

// ทุก route อื่นใช้ JSON parser ปกติ
app.use(express.json())

// ── Routes ─────────────────────────────
app.use('/api/liff',       require('./routes/liff'))         // LIFF API
app.use('/api/line',       require('./routes/line'))         // LINE webhooks
app.use('/api/auth',            require('./routes/auth'))          // Public
app.use('/api/customers', require('./routes/customers'))     // Auth required
app.use('/api/employees',      require('./routes/employees'))      // Auth required
app.use('/api/activities',     require('./routes/activities'))     // Auth required
app.use('/api/notifications',  require('./routes/notifications'))  // Auth required
app.use('/api/notes',          require('./routes/notes'))          // Auth required

// ── Health check ────────────────────────
app.get('/api/health', async (req, res) => {
  const status = { pos: false, crm: false }
  try { await posDB.query('SELECT 1'); status.pos = true } catch {}
  try { await crmDB.query('SELECT 1'); status.crm = true } catch {}
  const ok = status.pos && status.crm
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db: status })
})

// ── 404 handler ─────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }))

// ── Error handler ───────────────────────
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

require('./services/cronJobs').start()
app.listen(PORT, () => {
  console.log(`✅ CRM API running → http://localhost:${PORT}`)
  console.log(`   POS DB: ${process.env.POS_HOST}:${process.env.POS_PORT}`)
  console.log(`   CRM DB: ${process.env.CRM_HOST}:${process.env.CRM_PORT}`)
})
