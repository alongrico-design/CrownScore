require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');     // npm install bcryptjs
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// MySQL Connection Pool Setup using Railway Environment Variables
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: {
    rejectUnauthorized: false
  }
});

const db = pool.promise();

// Test Database Connection
pool.getConnection((err, conn) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('Connected to MySQL database successfully!');
    conn.release();
  }
});

/* ==========================================================================
   HELPERS
   ========================================================================== */

const isHash = (v) => typeof v === 'string' && /^\$2[aby]\$/.test(v);
const hashSecret = (plain) => bcrypt.hash(plain, 10);
const normAnswer = (s) => String(s || '').trim().toLowerCase();
const toNum = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };

// Works with old plain-text rows AND new hashed rows
async function checkSecret(plain, stored) {
  if (!stored) return false;
  return isHash(stored) ? bcrypt.compare(plain, stored) : plain === stored;
}

async function checkAnswer(plain, stored) {
  if (!stored) return false;
  return isHash(stored)
    ? bcrypt.compare(normAnswer(plain), stored)
    : normAnswer(plain) === normAnswer(stored);
}

// Simple in-memory limiter (resets when the server restarts)
const attempts = new Map();

function lockedSeconds(key) {
  const a = attempts.get(key);
  return a && a.lockedUntil > Date.now() ? Math.ceil((a.lockedUntil - Date.now()) / 1000) : 0;
}

function recordFail(key, max, lockMs) {
  const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
  if (a.lockedUntil && a.lockedUntil <= Date.now()) { a.count = 0; a.lockedUntil = 0; }
  a.count++;
  if (a.count >= max) { a.lockedUntil = Date.now() + lockMs; a.count = 0; }
  attempts.set(key, a);
}

const clearFails = (key) => attempts.delete(key);

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  const bytes = crypto.randomBytes(5);
  let code = 'CS-';
  for (const b of bytes) code += CODE_CHARS[b % CODE_CHARS.length];
  return code;
}

async function getParticipant(roomId, userId) {
  const [rows] = await db.query(
    'SELECT * FROM room_participants WHERE room_id = ? AND user_id = ? LIMIT 1',
    [roomId, userId]
  );
  return rows[0] || null;
}

// Categories (with their criteria) and contestants of one room
async function loadRoomDetails(roomId) {
  const [cats] = await db.query(
    'SELECT category_id AS id, category_name AS name, weight FROM categories WHERE room_id = ? ORDER BY category_id',
    [roomId]
  );
  const [crits] = await db.query(
    `SELECT cr.criteria_id AS id, cr.category_id, cr.criteria_name AS name, cr.percentage AS weight
     FROM criteria cr JOIN categories ca ON ca.category_id = cr.category_id
     WHERE ca.room_id = ? ORDER BY cr.criteria_id`,
    [roomId]
  );
  const categories = cats.map(c => ({
    id: c.id,
    name: c.name,
    weight: toNum(c.weight),
    criteria: crits.filter(x => x.category_id === c.id)
      .map(x => ({ id: x.id, name: x.name, weight: toNum(x.weight) }))
  }));
  const [contestants] = await db.query(
    `SELECT contestant_id AS id, contestant_number AS number, name, representation
     FROM contestants WHERE room_id = ? ORDER BY contestant_number ASC`,
    [roomId]
  );
  return { categories, contestants };
}

// Returns an error message, or '' when the room setup is valid
function checkSetup({ roomName, password, numJudges, categories, contestants }) {
  if (!roomName || !String(roomName).trim()) return 'Room name is required.';
  if (!password || String(password).length < 4) return 'Room password must be at least 4 characters.';
  const judges = Number(numJudges);
  if (!Number.isInteger(judges) || judges < 1 || judges > 15) return 'Number of judges must be between 1 and 15.';

  if (!Array.isArray(categories) || !categories.length) return 'Add at least one category.';
  for (const cat of categories) {
    if (!cat.name || !String(cat.name).trim()) return 'Every category needs a name.';
    if (!Array.isArray(cat.criteria) || !cat.criteria.length) return `Category "${cat.name}" needs at least one sub-criterion.`;
    let sum = 0;
    for (const cr of cat.criteria) {
      if (!cr.name || !String(cr.name).trim()) return `A sub-criterion in "${cat.name}" has no name.`;
      if (!(toNum(cr.weight) > 0)) return `Every sub-criterion in "${cat.name}" needs a weight above 0.`;
      sum += toNum(cr.weight);
    }
    if (Math.abs(sum - 100) > 0.01) return `Sub-criteria in "${cat.name}" total ${sum}%, they must total 100%.`;
  }

  const given = categories.filter(c => c.weight !== undefined && c.weight !== null && c.weight !== '');
  if (given.length) {
    const total = categories.reduce((s, c) => s + toNum(c.weight), 0);
    if (given.length !== categories.length || Math.abs(total - 100) > 0.01) {
      return 'Category weights must be filled in for every category and total 100%.';
    }
  }

  if (!Array.isArray(contestants) || !contestants.length) return 'Add at least one candidate.';
  const seen = new Set();
  for (const c of contestants) {
    if (!c.name || !String(c.name).trim()) return 'Every candidate needs a name.';
    if (seen.has(Number(c.number))) return `Candidate number ${c.number} is used more than once.`;
    seen.add(Number(c.number));
  }
  return '';
}

/* ==========================================================================
   1. USER AUTHENTICATION ENDPOINTS
   ========================================================================== */

// Registration: returns the new user so the app can log them straight in
app.post('/api/register', async (req, res) => {
  const { username, password, recoveryQuestion, recoveryAnswer } = req.body;

  if (!username || !password || !recoveryQuestion || !recoveryAnswer) {
    return res.status(400).json({ message: 'Please fill in all fields.' });
  }

  const name = String(username).trim();
  if (name.length < 4 || name.length > 20 || /\s/.test(name)) {
    return res.status(400).json({ message: 'Username must be 4-20 characters with no spaces.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO users (username, password, recovery_question, recovery_answer) VALUES (?, ?, ?, ?)',
      [name, await hashSecret(String(password)), String(recoveryQuestion).trim(), await hashSecret(normAnswer(recoveryAnswer))]
    );
    res.status(201).json({
      message: 'User registered successfully!',
      user: { id: result.insertId, username: name }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Username already exists.' });
    }
    if (err.code === 'ER_DATA_TOO_LONG') {
      return res.status(500).json({ message: 'Database columns are too short. Run migration.sql first.' });
    }
    console.error('Register error:', err);
    res.status(500).json({ message: 'Database error.' });
  }
});

// Login: never sends the password back
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Please provide both username and password.' });
  }

  const key = 'login:' + String(username).toLowerCase();
  const wait = lockedSeconds(key);
  if (wait) {
    return res.status(429).json({ message: `Too many attempts. Try again in ${wait} seconds.` });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
    const user = rows[0];

    if (!user || !(await checkSecret(String(password), user.password))) {
      recordFail(key, 5, 30 * 1000);
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    clearFails(key);

    const userId = user.user_id || user.id;

    // Old plain-text password? Upgrade it to a hash now
    if (!isHash(user.password)) {
      try {
        await db.query('UPDATE users SET password = ? WHERE user_id = ? OR id = ?', [await hashSecret(String(password)), userId, userId]);
      } catch (e) {
        console.warn('Could not upgrade password hash. Run migration.sql so users.password is VARCHAR(255).');
      }
    }

    res.status(200).json({
      message: 'Login successful!',
      user: { id: userId, username: user.username }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Database error.' });
  }
});

// Forgot Password step 2: show the saved question (never the answer)
app.get('/api/security-question', async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) return res.status(400).json({ message: 'Username is required.' });

  try {
    const [rows] = await db.query(
      'SELECT recovery_question FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    if (!rows.length || !rows[0].recovery_question) {
      return res.status(404).json({ message: "We couldn't find that username." });
    }
    res.json({ question: rows[0].recovery_question });
  } catch (err) {
    console.error('Security question error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Forgot Password step 3: answer + new password (3 wrong answers = 5 minute lock)
app.post('/api/reset-password', async (req, res) => {
  const { username, recoveryAnswer, newPassword } = req.body;

  if (!username || !recoveryAnswer || !newPassword) {
    return res.status(400).json({ message: 'Please fill in all fields.' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ message: 'New password must be at least 8 characters.' });
  }

  const key = 'reset:' + String(username).toLowerCase();
  const wait = lockedSeconds(key);
  if (wait) {
    return res.status(429).json({ message: `Too many wrong answers. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
    const user = rows[0];

    if (!user || !(await checkAnswer(recoveryAnswer, user.recovery_answer))) {
      recordFail(key, 3, 5 * 60 * 1000);
      return res.status(400).json({ message: "That answer doesn't match." });
    }

    clearFails(key);
    
    // Hash new password securely
    const newHash = await hashSecret(String(newPassword));
    const userId = user.user_id || user.id;

    await db.query('UPDATE users SET password = ? WHERE user_id = ? OR id = ?', [newHash, userId, userId]);

    res.status(200).json({ message: 'Password updated successfully!' });
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ message: 'Failed to update password.' });
  }
});

/* ==========================================================================
   2. ROOM MANAGEMENT (Admin & Judge flows)
   ========================================================================== */

// Admin creates a room (room, categories, criteria, candidates)
app.post('/api/rooms/create', async (req, res) => {
  const { code, roomName, description, password, numJudges, categories, contestants, userId } = req.body;

  if (!userId) return res.status(401).json({ message: 'Please log in again.' });

  const problem = checkSetup({ roomName, password, numJudges, categories, contestants });
  if (problem) return res.status(400).json({ message: problem });

  let connection;
  try {
    // FIX: Safely check for user_id OR id column depending on schema
    const [users] = await db.query('SELECT * FROM users WHERE user_id = ? OR id = ? LIMIT 1', [userId, userId]);
    if (!users.length) return res.status(401).json({ message: 'Please log in again.' });

    connection = await pool.promise().getConnection();
    await connection.beginTransaction();

    // 1. Insert room (Room ID is generated here if the suggested one is taken)
    const passwordHash = await hashSecret(String(password));
    let roomId = null;
    let roomCode = '';

    for (let attempt = 0; attempt < 5 && !roomId; attempt++) {
      roomCode = (attempt === 0 && code) ? String(code).trim().toUpperCase() : generateRoomCode();
      try {
        const [roomRes] = await connection.query(
          'INSERT INTO rooms (room_code, room_name, description, created_by, room_password, num_judges) VALUES (?, ?, ?, ?, ?, ?)',
          [roomCode, String(roomName).trim(), description || null, userId, passwordHash, Number(numJudges)]
        );
        roomId = roomRes.insertId;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    if (!roomId) throw new Error('Could not create a unique Room ID. Please try again.');

    // 2. Creator is the room admin
    await connection.query(
      'INSERT INTO room_participants (room_id, user_id, role) VALUES (?, ?, ?)',
      [roomId, userId, 'admin']
    );

    // 3. Categories + criteria (no category weights given = equal share)
    const equalShare = Math.round(10000 / categories.length) / 100;
    const insertedCategories = [];

    for (const cat of categories) {
      const catWeight = (cat.weight === undefined || cat.weight === null || cat.weight === '')
        ? equalShare : toNum(cat.weight);

      const [catRes] = await connection.query(
        'INSERT INTO categories (room_id, category_name, weight) VALUES (?, ?, ?)',
        [roomId, String(cat.name).trim(), catWeight]
      );
      const categoryId = catRes.insertId;

      const insertedCriteria = [];
      for (const crit of cat.criteria) {
        const [critRes] = await connection.query(
          'INSERT INTO criteria (category_id, criteria_name, percentage) VALUES (?, ?, ?)',
          [categoryId, String(crit.name).trim(), toNum(crit.weight)]
        );
        insertedCriteria.push({ id: critRes.insertId, name: crit.name, weight: toNum(crit.weight) });
      }
      insertedCategories.push({ id: categoryId, name: cat.name, weight: catWeight, criteria: insertedCriteria });
    }

    // 4. Candidates (this room only)
    const insertedContestants = [];
    for (let i = 0; i < contestants.length; i++) {
      const c = contestants[i];
      const number = Number(c.number) || i + 1;
      const [contRes] = await connection.query(
        'INSERT INTO contestants (room_id, contestant_number, name, representation) VALUES (?, ?, ?, ?)',
        [roomId, number, String(c.name).trim(), c.representation || null]
      );
      insertedContestants.push({
        id: contRes.insertId, number, name: c.name, representation: c.representation || null
      });
    }

    await connection.commit();
    res.json({ roomId, code: roomCode, categories: insertedCategories, contestants: insertedContestants });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error creating room:', err);
    res.status(500).json({ message: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Free / taken judge slots for a Room ID (fills the dropdown on the join screen)
app.get('/api/room-slots/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const userId = Number(req.query.userId) || 0;

  try {
    const [rooms] = await db.query(
      'SELECT room_id, num_judges, status FROM rooms WHERE room_code = ? LIMIT 1', [code]
    );
    if (!rooms.length) return res.status(404).json({ message: 'Room not found.' });

    const [taken] = await db.query(
      "SELECT judge_number, user_id FROM room_participants WHERE room_id = ? AND role = 'judge' AND judge_number IS NOT NULL",
      [rooms[0].room_id]
    );
    res.json({
      num_judges: rooms[0].num_judges,
      status: rooms[0].status,
      taken: taken.map(t => ({ judge_number: t.judge_number, mine: t.user_id === userId }))
    });
  } catch (err) {
    console.error('Slots error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Judge joins a room: Room ID + password + judge slot
app.post('/api/rooms/join', async (req, res) => {
  const { code, password, userId, judgeNumber } = req.body;

  if (!userId) return res.status(401).json({ message: 'Please log in again.' });

  const roomCode = String(code || '').trim().toUpperCase();
  const key = `join:${roomCode}:${userId}`;
  const wait = lockedSeconds(key);
  if (wait) return res.status(429).json({ message: `Too many wrong passwords. Try again in ${wait} seconds.` });

  try {
    const [rooms] = await db.query('SELECT * FROM rooms WHERE room_code = ? LIMIT 1', [roomCode]);
    if (!rooms.length) return res.status(401).json({ message: 'Invalid Room ID or password.' });

    const room = rooms[0];
    if (room.status && room.status !== 'active') {
      return res.status(409).json({ message: 'This room has already ended.' });
    }

    // Room password (rooms made before the upgrade have none)
    if (room.room_password && !(await checkSecret(String(password || ''), room.room_password))) {
      recordFail(key, 5, 30 * 1000);
      return res.status(401).json({ message: 'Invalid Room ID or password.' });
    }
    clearFails(key);

    let participant = await getParticipant(room.room_id, userId);
    if (participant && participant.role === 'admin') {
      return res.status(403).json({ message: "You created this room, so you can't judge it." });
    }

    let slot = participant ? participant.judge_number : null;

    if (!slot) {
      slot = Number(judgeNumber);
      if (!Number.isInteger(slot) || slot < 1 || slot > room.num_judges) {
        return res.status(400).json({ message: `Choose a judge slot from 1 to ${room.num_judges}.` });
      }
      try {
        if (participant) {
          await db.query('UPDATE room_participants SET judge_number = ? WHERE room_id = ? AND user_id = ?',
            [slot, room.room_id, userId]);
        } else {
          await db.query(
            'INSERT INTO room_participants (room_id, user_id, role, judge_number) VALUES (?, ?, ?, ?)',
            [room.room_id, userId, 'judge', slot]
          );
        }
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ message: `Judge #${slot} is already taken. Pick another slot.` });
        }
        throw e;
      }
    }

    const details = await loadRoomDetails(room.room_id);
    res.json({
      id: room.room_id,
      code: room.room_code,
      room_name: room.room_name,
      num_judges: room.num_judges,
      judgeNumber: slot,
      ...details
    });

  } catch (err) {
    console.error('Error joining room:', err);
    res.status(500).json({ message: err.message });
  }
});

// Re-open a room you already belong to (Profile > Manage / Resume)
app.get('/api/rooms/by-code/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const userId = Number(req.query.userId) || 0;

  try {
    const [rooms] = await db.query('SELECT * FROM rooms WHERE room_code = ? LIMIT 1', [code]);
    if (!rooms.length) return res.status(404).json({ message: 'Room not found.' });

    const room = rooms[0];
    const participant = userId ? await getParticipant(room.room_id, userId) : null;
    if (!participant) return res.status(403).json({ message: 'You are not part of this room.' });

    const details = await loadRoomDetails(room.room_id);
    res.json({
      id: room.room_id,
      code: room.room_code,
      room_name: room.room_name,
      num_judges: room.num_judges,
      status: room.status,
      role: participant.role,
      judgeNumber: participant.judge_number,
      ...details
    });
  } catch (err) {
    console.error('By-code error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Admin ends the room (results stay available)
app.post('/api/rooms/:roomId/complete', async (req, res) => {
  const { userId } = req.body;
  try {
    const [result] = await db.query(
      "UPDATE rooms SET status = 'completed' WHERE room_id = ? AND created_by = ?",
      [req.params.roomId, userId]
    );
    if (!result.affectedRows) return res.status(403).json({ message: 'Only the room admin can end this room.' });
    res.json({ message: 'Room ended.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ==========================================================================
   3. SCORES
   ========================================================================== */

// Live scores for the admin dashboard (admin only)
app.get('/api/rooms/:roomId/scores', async (req, res) => {
  const userId = Number(req.query.userId) || 0;
  try {
    const [rooms] = await db.query('SELECT created_by FROM rooms WHERE room_id = ? LIMIT 1', [req.params.roomId]);
    if (!rooms.length || rooms[0].created_by !== userId) {
      return res.status(403).json({ message: 'Only the room admin can see live scores.' });
    }

    const [scores] = await db.query(
      `SELECT s.judge_id, rp.judge_number, s.contestant_id, s.criteria_id,
              s.score_value AS score, s.is_final
       FROM scores s
       LEFT JOIN room_participants rp
         ON rp.room_id = s.room_id AND rp.user_id = s.judge_id AND rp.role = 'judge'
       WHERE s.room_id = ?`,
      [req.params.roomId]
    );
    res.json(scores);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// One judge's own scores (fills the judge portal)
app.get('/api/rooms/:roomId/scores/judge/:userId', async (req, res) => {
  try {
    const participant = await getParticipant(req.params.roomId, req.params.userId);
    if (!participant || participant.role !== 'judge') {
      return res.status(403).json({ message: 'You are not a judge in this room.' });
    }
    const [scores] = await db.query(
      `SELECT contestant_id, criteria_id, score_value AS score, is_final
       FROM scores WHERE room_id = ? AND judge_id = ?`,
      [req.params.roomId, req.params.userId]
    );
    res.json(scores);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Save a draft (final:false) or submit + lock (final:true) one candidate's scores
app.post('/api/scores/submit', async (req, res) => {
  const { roomId, userId, contestantId, scores, final } = req.body;

  if (!roomId || !userId || !contestantId || !Array.isArray(scores) || !scores.length) {
    return res.status(400).json({ message: 'Missing score data.' });
  }

  let connection;
  try {
    const participant = await getParticipant(roomId, userId);
    if (!participant || participant.role !== 'judge') {
      return res.status(403).json({ message: 'You are not a judge in this room.' });
    }

    const [rooms] = await db.query('SELECT status FROM rooms WHERE room_id = ? LIMIT 1', [roomId]);
    if (!rooms.length || (rooms[0].status && rooms[0].status !== 'active')) {
      return res.status(409).json({ message: 'This room has ended.' });
    }

    const [cont] = await db.query(
      'SELECT contestant_id FROM contestants WHERE contestant_id = ? AND room_id = ? LIMIT 1',
      [contestantId, roomId]
    );
    if (!cont.length) return res.status(400).json({ message: 'That candidate is not in this room.' });

    const [crits] = await db.query(
      `SELECT cr.criteria_id FROM criteria cr
       JOIN categories ca ON ca.category_id = cr.category_id WHERE ca.room_id = ?`,
      [roomId]
    );
    const valid = new Set(crits.map(c => Number(c.criteria_id)));

    const sent = new Set();
    for (const s of scores) {
      const n = Number(s.score);
      if (!valid.has(Number(s.criteriaId))) return res.status(400).json({ message: 'Unknown sub-criterion.' });
      if (isNaN(n) || n < 0 || n > 100) return res.status(400).json({ message: 'Scores must be between 0 and 100.' });
      sent.add(Number(s.criteriaId));
    }
    if (final && sent.size !== valid.size) {
      return res.status(400).json({ message: 'Please score every sub-criterion before submitting.' });
    }

    const [locked] = await db.query(
      'SELECT COUNT(*) AS n FROM scores WHERE room_id = ? AND judge_id = ? AND contestant_id = ? AND is_final = 1',
      [roomId, userId, contestantId]
    );
    if (locked[0].n > 0) {
      return res.status(409).json({ message: 'Scores for this candidate are already submitted and locked.' });
    }

    connection = await pool.promise().getConnection();
    await connection.beginTransaction();

    for (const s of scores) {
      await connection.query(
        `INSERT INTO scores (room_id, judge_id, contestant_id, criteria_id, score_value, is_final, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE score_value = VALUES(score_value), is_final = VALUES(is_final), submitted_at = NOW()`,
        [roomId, userId, contestantId, s.criteriaId, Number(s.score), final ? 1 : 0]
      );
    }

    await connection.commit();
    res.json({ message: final ? 'Scores submitted.' : 'Draft saved.' });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error submitting scores:', err);
    res.status(500).json({ message: err.message });
  } finally {
    if (connection) connection.release();
  }
});

/* ==========================================================================
   4. RESULTS (winners page + export)
   ========================================================================== */

// Category score = sum(rating x weight / 100) per judge, averaged over judges
app.get('/api/rooms/:code/results', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const userId = Number(req.query.userId) || 0;

  try {
    const [rooms] = await db.query('SELECT * FROM rooms WHERE room_code = ? LIMIT 1', [code]);
    if (!rooms.length) return res.status(404).json({ message: 'Room not found.' });
    const room = rooms[0];

    const participant = userId ? await getParticipant(room.room_id, userId) : null;
    if (!participant) return res.status(403).json({ message: 'Only people in this room can see its results.' });

    const { categories, contestants } = await loadRoomDetails(room.room_id);
    const [rows] = await db.query(
      'SELECT judge_id, contestant_id, criteria_id, score_value FROM scores WHERE room_id = ? AND is_final = 1',
      [room.room_id]
    );

    const critInfo = {};
    categories.forEach(cat => cat.criteria.forEach(cr => {
      critInfo[cr.id] = { catId: cat.id, weight: cr.weight };
    }));
    const critTotal = Object.keys(critInfo).length;
    const critPerCat = {};
    categories.forEach(cat => { critPerCat[cat.id] = cat.criteria.length; });

    // pair = one judge scoring one candidate
    const pairs = {};
    rows.forEach(r => {
      const info = critInfo[r.criteria_id];
      if (!info) return;
      const key = r.contestant_id + '|' + r.judge_id;
      const p = pairs[key] || (pairs[key] = { contestant: r.contestant_id, judge: r.judge_id, cats: {}, counts: {}, n: 0 });
      p.cats[info.catId] = (p.cats[info.catId] || 0) + toNum(r.score_value) * info.weight / 100;
      p.counts[info.catId] = (p.counts[info.catId] || 0) + 1;
      p.n++;
    });

    const judgeDone = {};
    Object.values(pairs).forEach(p => {
      if (p.n >= critTotal) judgeDone[p.judge] = (judgeDone[p.judge] || 0) + 1;
    });

    const candidates = contestants.map(c => {
      const scores = {};
      categories.forEach(cat => {
        const list = Object.values(pairs).filter(p =>
          p.contestant === c.id && p.counts[cat.id] === critPerCat[cat.id]);
        scores[cat.id] = list.length
          ? Math.round(list.reduce((s, p) => s + p.cats[cat.id], 0) / list.length * 100) / 100
          : 0;
      });
      return { number: c.number, name: c.name, title: c.representation, scores };
    });

    const judgesDone = Object.values(judgeDone).filter(n => n >= contestants.length && contestants.length > 0).length;

    res.json({
      room: { name: room.room_name, code: room.room_code, date: room.created_at, status: room.status },
      categories: categories.map(c => ({ id: c.id, name: c.name, weight: c.weight })),
      candidates,
      progress: {
        judgesDone,
        totalJudges: room.num_judges,
        complete: room.num_judges > 0 && judgesDone >= room.num_judges
      }
    });
  } catch (err) {
    console.error('Results error:', err);
    res.status(500).json({ message: err.message });
  }
});

/* ==========================================================================
   5. PROFILE & USER HISTORY
   ========================================================================== */

app.get('/api/users/:userId/history', async (req, res) => {
  const userId = req.params.userId;

  try {
    // Rooms created as Admin
    const [adminRooms] = await db.query(
      `SELECT room_id AS id, room_code AS code, room_name, num_judges, status, created_at
       FROM rooms WHERE created_by = ? ORDER BY created_at DESC`,
      [userId]
    );

    // Rooms judged as Judge
    const [judgedRaw] = await db.query(
      `SELECT r.room_id AS id, r.room_code AS code, r.room_name, rp.judge_number,
              MAX(s.submitted_at) AS last_submitted,
              COALESCE(SUM(s.is_final = 1), 0) AS final_count,
              (SELECT COUNT(*) FROM contestants c WHERE c.room_id = r.room_id) *
              (SELECT COUNT(*) FROM criteria cr JOIN categories ca ON ca.category_id = cr.category_id
                 WHERE ca.room_id = r.room_id) AS expected
       FROM room_participants rp
       JOIN rooms r ON r.room_id = rp.room_id
       LEFT JOIN scores s ON s.room_id = rp.room_id AND s.judge_id = rp.user_id
       WHERE rp.user_id = ? AND rp.role = 'judge'
       GROUP BY r.room_id, r.room_code, r.room_name, rp.judge_number
       ORDER BY last_submitted DESC`,
      [userId]
    );

    const judgedRooms = judgedRaw.map(r => ({
      id: r.id,
      code: r.code,
      room_name: r.room_name,
      judge_number: r.judge_number,
      last_submitted: r.last_submitted,
      scoring_status: Number(r.expected) > 0 && Number(r.final_count) >= Number(r.expected)
        ? 'submitted' : 'in progress'
    }));

    res.json({ adminRooms, judgedRooms });

  } catch (err) {
    console.error('Error fetching user history:', err);
    res.status(500).json({ message: err.message });
  }
});

// Start API Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CrownScore local API server running on http://localhost:${PORT}`);
});