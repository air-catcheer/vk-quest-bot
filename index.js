require('dotenv').config();

const { VK, Keyboard } = require('vk-io');
const { Pool } = require('pg');
const xlsx = require('xlsx');
const { createCanvas } = require('canvas');

const vk = new VK({ token: process.env.VK_TOKEN });
const pool = new Pool({ connectionString: process.env.DB_URL });

// 👑 ВСТАВЬ ID АДМИНОВ
const ADMINS = [12345678, 87654321];

// ===== DB INIT =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT,
      x INT DEFAULT 0,
      y INT DEFAULT 0,
      energy INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      team_id INT,
      waiting BOOLEAN DEFAULT false,
      active_task INT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      question TEXT,
      answer TEXT,
      requires_review BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      task_id INT,
      answer TEXT,
      attachment TEXT,
      status TEXT DEFAULT 'pending',
      assigned_admin BIGINT
    );
  `);
}

// ===== LOAD EXCEL =====
async function loadTasks() {
  const file = xlsx.readFile('tasks.xlsx');
  const sheet = file.Sheets[file.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet);

  for (const t of data) {
    await pool.query(
      `INSERT INTO tasks (question, answer, requires_review)
       VALUES ($1,$2,$3)`,
      [t.question, t.answer || '', t.requires_review || false]
    );
  }
}

// ===== MAP =====
function generateMap(x, y) {
  const canvas = createCanvas(400, 800);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 400, 800);

  ctx.strokeStyle = '#ccc';
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 40; j++) {
      ctx.strokeRect(i * 20, j * 20, 20, 20);
    }
  }

  ctx.fillStyle = 'red';
  ctx.fillRect(x * 20, y * 20, 20, 20);

  return canvas.toBuffer();
}

// ===== SEND TO ONE ADMIN =====
async function sendToAdmin(sub) {
  const admin = ADMINS[Math.floor(Math.random() * ADMINS.length)];

  await pool.query(
    'UPDATE submissions SET assigned_admin=$1 WHERE id=$2',
    [admin, sub.id]
  );

  const keyboard = Keyboard.builder()
    .textButton({ label: '1⭐', payload: { subId: sub.id, grade: 1 } })
    .textButton({ label: '2⭐', payload: { subId: sub.id, grade: 2 } })
    .row()
    .textButton({ label: '3⭐', payload: { subId: sub.id, grade: 3 } })
    .textButton({ label: '4⭐', payload: { subId: sub.id, grade: 4 } })
    .textButton({ label: '5⭐', payload: { subId: sub.id, grade: 5 } });

  await vk.api.messages.send({
    user_id: admin,
    random_id: 0,
    message: `Задание ${sub.id}\n${sub.answer}`,
    attachment: sub.attachment || undefined,
    keyboard
  });
}

// ===== BOT =====
vk.updates.on('message_new', async (ctx) => {
  const userId = ctx.senderId;
  const text = ctx.text;
  const payload = ctx.messagePayload;

  let user = (await pool.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];

  if (text === '/start') return ctx.send('Введите название команды');

  if (!user) {
    const team = await pool.query('INSERT INTO teams (name) VALUES ($1) RETURNING *', [text]);
    await pool.query('INSERT INTO users (id, team_id) VALUES ($1,$2)', [userId, team.rows[0].id]);
    return ctx.send('Команда создана');
  }

  if (text === 'энергия') {
    const team = (await pool.query('SELECT * FROM teams WHERE id=$1', [user.team_id])).rows[0];
    return ctx.send(`Энергия: ${team.energy}`);
  }

  if (text === 'задание') {
    if (user.waiting) return ctx.send('Ждите проверки');

    const task = (await pool.query('SELECT * FROM tasks ORDER BY RANDOM() LIMIT 1')).rows[0];

    await pool.query('UPDATE users SET active_task=$1 WHERE id=$2', [task.id, userId]);
    return ctx.send(task.question);
  }

  if (user.active_task) {
    const task = (await pool.query('SELECT * FROM tasks WHERE id=$1', [user.active_task])).rows[0];

    if (task.requires_review) {
      const attachment = ctx.attachments.length ? ctx.attachments[0].toString() : null;

      const sub = (await pool.query(
        'INSERT INTO submissions (user_id, task_id, answer, attachment) VALUES ($1,$2,$3,$4) RETURNING *',
        [userId, task.id, text, attachment]
      )).rows[0];

      await pool.query('UPDATE users SET waiting=true WHERE id=$1', [userId]);

      await sendToAdmin(sub);

      return ctx.send('Отправлено на проверку');
    }

    if (text.toLowerCase() === task.answer.toLowerCase()) {
      await pool.query('UPDATE teams SET energy=energy+1 WHERE id=$1', [user.team_id]);
      await pool.query('UPDATE users SET active_task=NULL WHERE id=$1', [userId]);
      return ctx.send('Верно!');
    }

    return ctx.send('Неверно');
  }

  // ===== ADMIN =====
  if (payload && ADMINS.includes(userId)) {
    const { subId, grade } = payload;

    const sub = (await pool.query('SELECT * FROM submissions WHERE id=$1', [subId])).rows[0];

    if (!sub || sub.status !== 'pending') return ctx.send('Уже оценено');

    if (sub.assigned_admin !== userId) return ctx.send('Не тебе');

    await pool.query("UPDATE submissions SET status='approved' WHERE id=$1", [subId]);

    const u = (await pool.query('SELECT * FROM users WHERE id=$1', [sub.user_id])).rows[0];

    await pool.query('UPDATE teams SET energy=energy+$1 WHERE id=$2', [grade, u.team_id]);

    await pool.query('UPDATE users SET waiting=false, active_task=NULL WHERE id=$1', [sub.user_id]);

    await vk.api.messages.send({
      user_id: sub.user_id,
      random_id: 0,
      message: `Вам поставили ${grade} ⭐`
    });

    return ctx.send('Оценено');
  }

  // ===== MOVE =====
  if (text && text.startsWith('шаг')) {
    const dir = text.split(' ')[1];
    const team = (await pool.query('SELECT * FROM teams WHERE id=$1', [user.team_id])).rows[0];

    if (team.energy < 3) return ctx.send('Мало энергии');

    let dx = 0, dy = 0;
    if (dir === 'вверх') dy = -1;
    if (dir === 'вниз') dy = 1;
    if (dir === 'лево') dx = -1;
    if (dir === 'право') dx = 1;

    const nx = team.x + dx;
    const ny = team.y + dy;

    await pool.query('UPDATE teams SET x=$1,y=$2,energy=energy-3 WHERE id=$3', [nx, ny, team.id]);

    const img = generateMap(nx, ny);

    await ctx.send({ attachment: { value: img, type: 'photo' } });
  }
});

(async () => {
  await initDB();
  // await loadTasks(); // Включи 1 раз!
  await vk.updates.start();
})();