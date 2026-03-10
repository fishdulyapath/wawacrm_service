const express = require('express')
const router  = express.Router()
const { crmDB, posDB } = require('../db')
const { authMiddleware, requireRole } = require('../middleware/auth')
const { logAudit } = require('../middleware/audit')
const { notify, notifyMany } = require('../services/notifyService')

router.use(authMiddleware)

// ─────────────────────────────────────────────
// GET /api/activities/stats
// ตัวเลขสรุป: overdue, today, open, meetings_today
// ─────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const ownerCond = req.user.role === 'sales_rep' ? `AND owner_id = ${req.user.id}` : ''
    const result = await crmDB.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='open' AND due_date < CURRENT_DATE)                                          AS overdue,
        COUNT(*) FILTER (WHERE status='open' AND DATE(due_date) = CURRENT_DATE AND activity_type != 'meeting')     AS today,
        COUNT(*) FILTER (WHERE status='open')                                                                       AS open,
        COUNT(*) FILTER (WHERE activity_type='meeting' AND status='open' AND DATE(start_datetime) = CURRENT_DATE)  AS meetings_today
      FROM crm_activities
      WHERE 1=1 ${ownerCond}
    `)
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// GET /api/activities
// query: type, status, ar_code, owner_id, due, search, page, limit
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { type, status, ar_code, owner_id, due, search, page = 1, limit = 20 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)
    const params = []
    const conditions = []

    if (type)     { params.push(type);     conditions.push(`a.activity_type = $${params.length}`) }
    if (ar_code)  { params.push(ar_code);  conditions.push(`a.ar_code = $${params.length}`) }
    if (owner_id) { params.push(owner_id); conditions.push(`a.owner_id = $${params.length}`) }

    // quick due filter (overrides status filter)
    if (due === 'overdue') {
      conditions.push(`a.due_date < CURRENT_DATE AND a.status = 'open'`)
    } else if (due === 'today') {
      conditions.push(`DATE(a.due_date) = CURRENT_DATE AND a.status = 'open'`)
    } else if (due === 'week') {
      conditions.push(`a.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND a.status = 'open'`)
    } else if (status) {
      params.push(status); conditions.push(`a.status = $${params.length}`)
    }

    // search across subject + ar_code
    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(a.subject ILIKE $${params.length} OR a.ar_code ILIKE $${params.length})`)
    }

    // sales_rep เห็นเฉพาะของตัวเอง
    if (req.user.role === 'sales_rep') {
      params.push(req.user.id)
      conditions.push(`a.owner_id = $${params.length}`)
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const countResult = await crmDB.query(
      `SELECT COUNT(*) FROM crm_activities a ${where}`,
      params
    )
    const total = parseInt(countResult.rows[0].count)

    params.push(parseInt(limit))
    params.push(offset)
    const dataResult = await crmDB.query(
      `SELECT a.*, u.name AS owner_name
       FROM crm_activities a
       LEFT JOIN crm_users u ON u.id = a.owner_id
       ${where}
       ORDER BY
         CASE WHEN a.status = 'open' THEN 0 ELSE 1 END,
         a.due_date ASC NULLS LAST,
         a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    // เติม customer_name จาก POS DB (batch query)
    const arCodes = [...new Set(dataResult.rows.map(r => r.ar_code).filter(Boolean))]
    let customerMap = {}
    if (arCodes.length > 0) {
      const placeholders = arCodes.map((_, i) => `$${i + 1}`).join(',')
      const posResult = await posDB.query(
        `SELECT code, name_1 FROM ar_customer WHERE code IN (${placeholders})`,
        arCodes
      )
      posResult.rows.forEach(r => { customerMap[r.code] = r.name_1 })
    }
    const rows = dataResult.rows.map(r => ({
      ...r,
      customer_name: customerMap[r.ar_code] || null
    }))

    res.json({
      data: rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
    })
  } catch (err) {
    console.error('[Activities GET]', err)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// GET /api/activities/:id
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await crmDB.query(
      `SELECT a.*, u.name AS owner_name
       FROM crm_activities a
       LEFT JOIN crm_users u ON u.id = a.owner_id
       WHERE a.id = $1`,
      [req.params.id]
    )
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบ Activity' })

    const activity = result.rows[0]

    // ตรวจสิทธิ์ sales_rep
    if (req.user.role === 'sales_rep' && activity.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง Activity นี้' })
    }

    // ดึง invitees ถ้าเป็น meeting
    if (activity.activity_type === 'meeting') {
      const invResult = await crmDB.query(
        `SELECT u.id, u.name FROM crm_activity_invitees i
         JOIN crm_users u ON u.id = i.user_id
         WHERE i.activity_id = $1`,
        [activity.id]
      )
      activity.invitees = invResult.rows
    }

    res.json(activity)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// POST /api/activities
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    ar_code, activity_type, subject, description, status = 'open', priority = 'normal',
    due_date, start_datetime, end_datetime, location,
    call_direction, call_result, call_phone, duration_sec,
    owner_id, invitees = [], meeting_url, outcome, all_day = false
  } = req.body

  if (!activity_type || !subject) {
    return res.status(400).json({ error: 'กรุณากรอก activity_type และ subject' })
  }

  const client = await crmDB.connect()
  try {
    await client.query('BEGIN')

    const effectiveOwner = owner_id || req.user.id

    const result = await client.query(
      `INSERT INTO crm_activities
         (ar_code, owner_id, activity_type, subject, description, status, priority,
          due_date, start_datetime, end_datetime, location,
          call_direction, call_result, call_phone, duration_sec,
          meeting_url, outcome, all_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [ar_code, effectiveOwner, activity_type, subject, description, status, priority,
       due_date || null, start_datetime || null, end_datetime || null, location || null,
       call_direction || null, call_result || null, call_phone || null, duration_sec || null,
       meeting_url || null, outcome || null, all_day]
    )
    const activity = result.rows[0]

    // เพิ่ม invitees สำหรับ meeting
    if (activity_type === 'meeting' && invitees.length > 0) {
      for (const uid of invitees) {
        await client.query(
          `INSERT INTO crm_activity_invitees (activity_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [activity.id, uid]
        )
      }
    }

    await client.query('COMMIT')

    await logAudit({
      tableName: 'crm_activities', recordId: activity.id, arCode: ar_code,
      action: 'INSERT', newData: activity,
    }, req)

    // แจ้งเตือน owner ว่ามีงานใหม่ (notify เสมอ ไม่ว่าจะ assign ให้ตัวเองหรือคนอื่น)
    await notify({
      userId: effectiveOwner,
      notiType: 'assigned',
      title: effectiveOwner !== req.user.id ? `งานใหม่ถูก assign ให้คุณ` : `งานใหม่ของคุณ`,
      message: subject,
      refType: 'activity',
      refId: activity.id,
      arCode: ar_code || null,
    })

    // แจ้ง invitees ของ meeting
    if (activity_type === 'meeting' && invitees.length > 0) {
      const meetingDate = start_datetime
        ? new Date(start_datetime).toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })
        : ''
      const othersInvited = invitees.filter(uid => uid !== req.user.id && uid !== effectiveOwner)
      await notifyMany(othersInvited, {
        notiType: 'assigned',
        title: `คุณถูกเชิญเข้า Meeting`,
        message: `${subject}${meetingDate ? ' — ' + meetingDate : ''}`,
        refType: 'activity',
        refId: activity.id,
        arCode: ar_code || null,
      })
    }

    res.status(201).json(activity)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[Activity POST]', err)
    res.status(500).json({ error: err.message })
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────
// PUT /api/activities/:id
// ─────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const {
    subject, description, status, priority,
    due_date, start_datetime, end_datetime, location,
    call_direction, call_result, call_phone, duration_sec,
    owner_id, invitees, meeting_url, outcome, all_day
  } = req.body

  const client = await crmDB.connect()
  try {
    const existing = await client.query('SELECT * FROM crm_activities WHERE id=$1', [req.params.id])
    if (!existing.rows.length) return res.status(404).json({ error: 'ไม่พบ Activity' })

    const old = existing.rows[0]
    if (req.user.role === 'sales_rep' && old.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไข Activity นี้' })
    }

    await client.query('BEGIN')

    const result = await client.query(
      `UPDATE crm_activities SET
         subject=$1, description=$2, status=$3, priority=$4,
         due_date=$5, start_datetime=$6, end_datetime=$7, location=$8,
         call_direction=$9, call_result=$10, call_phone=$11, duration_sec=$12,
         owner_id=$13, meeting_url=$14, outcome=$15, all_day=$16,
         updated_at=NOW()
       WHERE id=$17 RETURNING *`,
      [subject ?? old.subject, description ?? old.description,
       status ?? old.status, priority ?? old.priority,
       due_date ?? old.due_date, start_datetime ?? old.start_datetime,
       end_datetime ?? old.end_datetime, location ?? old.location,
       call_direction ?? old.call_direction, call_result ?? old.call_result,
       call_phone ?? old.call_phone,
       (duration_sec === '' || duration_sec === undefined) ? old.duration_sec : (duration_sec === null ? null : parseInt(duration_sec)),
       (owner_id === '' || owner_id === undefined) ? old.owner_id : (owner_id === null ? null : parseInt(owner_id)),
       meeting_url !== undefined ? meeting_url : old.meeting_url,
       outcome     !== undefined ? outcome     : old.outcome,
       all_day     !== undefined ? all_day     : old.all_day,
       req.params.id]
    )
    const updated = result.rows[0]

    // อัปเดต invitees ถ้า meeting
    if (updated.activity_type === 'meeting' && Array.isArray(invitees)) {
      await client.query('DELETE FROM crm_activity_invitees WHERE activity_id=$1', [updated.id])
      for (const uid of invitees) {
        await client.query(
          `INSERT INTO crm_activity_invitees (activity_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [updated.id, uid]
        )
      }
    }

    await client.query('COMMIT')

    await logAudit({
      tableName: 'crm_activities', recordId: updated.id, arCode: updated.ar_code,
      action: 'UPDATE', oldData: old, newData: updated,
    }, req)

    // แจ้ง owner ใหม่ถ้า owner เปลี่ยน
    const newOwner = owner_id !== undefined ? parseInt(owner_id) : old.owner_id
    if (newOwner && newOwner !== old.owner_id && newOwner !== req.user.id) {
      await notify({
        userId: newOwner,
        notiType: 'assigned',
        title: `งานถูก assign ให้คุณ`,
        message: updated.subject,
        refType: 'activity',
        refId: updated.id,
        arCode: updated.ar_code || null,
      })
    }

    // แจ้ง invitees ใหม่ของ meeting
    if (updated.activity_type === 'meeting' && Array.isArray(invitees) && invitees.length > 0) {
      const prevInvitees = await crmDB.query(
        `SELECT user_id FROM crm_activity_invitees WHERE activity_id=$1`, [updated.id]
      )
      const prevIds = prevInvitees.rows.map(r => r.user_id)
      const newInvitees = invitees.filter(uid => !prevIds.includes(uid) && uid !== req.user.id && uid !== newOwner)
      if (newInvitees.length > 0) {
        const meetingDate = updated.start_datetime
          ? new Date(updated.start_datetime).toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })
          : ''
        await notifyMany(newInvitees, {
          notiType: 'assigned',
          title: `คุณถูกเชิญเข้า Meeting`,
          message: `${updated.subject}${meetingDate ? ' — ' + meetingDate : ''}`,
          refType: 'activity',
          refId: updated.id,
          arCode: updated.ar_code || null,
        })
      }
    }

    res.json(updated)
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────
// PATCH /api/activities/:id/snooze — เลื่อน due_date
// body: { days: 1|7 }
// ─────────────────────────────────────────────
router.patch('/:id/snooze', async (req, res) => {
  try {
    const existing = await crmDB.query('SELECT * FROM crm_activities WHERE id=$1', [req.params.id])
    if (!existing.rows.length) return res.status(404).json({ error: 'ไม่พบ Activity' })

    const old = existing.rows[0]
    if (req.user.role === 'sales_rep' && old.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์' })
    }

    const { days, date } = req.body

    let result
    if (date) {
      // เลื่อนไปวันที่ระบุ (รองรับทั้ง due_date และ start_datetime)
      if (old.activity_type === 'meeting' && old.start_datetime) {
        result = await crmDB.query(
          `UPDATE crm_activities SET start_datetime = $2::timestamptz, updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id, date]
        )
      } else {
        result = await crmDB.query(
          `UPDATE crm_activities SET due_date = $2::date, updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id, date]
        )
      }
    } else {
      const d = parseInt(days) || 1
      if (old.activity_type === 'meeting' && old.start_datetime) {
        result = await crmDB.query(
          `UPDATE crm_activities SET start_datetime = start_datetime + INTERVAL '${d} days', updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id]
        )
      } else {
        result = await crmDB.query(
          `UPDATE crm_activities SET due_date = COALESCE(due_date, CURRENT_DATE) + INTERVAL '${d} days', updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id]
        )
      }
    }
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// PATCH /api/activities/:id/done  — ปิดงานเร็ว
// ─────────────────────────────────────────────
router.patch('/:id/done', async (req, res) => {
  try {
    const existing = await crmDB.query('SELECT * FROM crm_activities WHERE id=$1', [req.params.id])
    if (!existing.rows.length) return res.status(404).json({ error: 'ไม่พบ Activity' })

    const old = existing.rows[0]
    if (req.user.role === 'sales_rep' && old.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์' })
    }

    const { outcome, call_phone, call_result, call_direction, duration_sec } = req.body

    const result = await crmDB.query(
      `UPDATE crm_activities
       SET status         = 'done',
           outcome        = COALESCE($2, outcome),
           call_phone     = COALESCE($3, call_phone),
           call_result    = COALESCE($4, call_result),
           call_direction = COALESCE($5, call_direction),
           duration_sec   = COALESCE($6, duration_sec),
           updated_at     = NOW()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        outcome        || null,
        call_phone     || null,
        call_result    || null,
        call_direction || null,
        duration_sec != null ? parseInt(duration_sec) : null,
      ]
    )
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────
// DELETE /api/activities/:id
// ─────────────────────────────────────────────
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const existing = await crmDB.query('SELECT * FROM crm_activities WHERE id=$1', [req.params.id])
    if (!existing.rows.length) return res.status(404).json({ error: 'ไม่พบ Activity' })

    const old = existing.rows[0]
    await crmDB.query('DELETE FROM crm_activities WHERE id=$1', [req.params.id])

    await logAudit({
      tableName: 'crm_activities', recordId: old.id, arCode: old.ar_code,
      action: 'DELETE', oldData: old,
    }, req)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
