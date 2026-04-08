import { VK } from 'vk-io';
import { Pool } from 'pg';
import XLSX from 'xlsx';
import dotenv from 'dotenv';
dotenv.config();

// ===== Параметры =====
const vk = new VK({ token: process.env.VK_TOKEN });
const PORT = process.env.PORT || 3000;
const PATH = '/'; 

const pool = new Pool({
    connectionString: process.env.DB_URL
});

// Список админов
const ADMINS = [12345678, 87654321]; 

// ===== Загрузка заданий из Excel =====
const workbook = XLSX.readFile('tasks.xlsx');
const sheetName = workbook.SheetNames[0];
const tasks = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

// ===== Подтверждение сервера VK =====
vk.updates.on('webhook', async (ctx, next) => {
    if (ctx.body.type === 'confirmation') {
        return ctx.send('cb4b0c26'); // Твой код из ВК
    }
    await next();
});

// ===== Сообщения игроков =====
vk.updates.on('message_new', async (ctx) => {
    const userId = ctx.senderId;

    // Проверка команд
    if (ctx.text === 'проверить энергию') {
        const res = await pool.query('SELECT energy FROM users WHERE vk_id=$1', [userId]);
        const energy = res.rows[0]?.energy || 0;
        return ctx.send(`У вас энергии: ${energy}`);
    }

    if (ctx.text === 'выполнить задание') {
        // Находим первое доступное задание
        const task = tasks.find(t => !t.completed);
        if (!task) return ctx.send('Все задания выполнены!');
        
        // Сохраняем в базу, блокируем до оценки
        await pool.query(
            'INSERT INTO tasks_in_progress(vk_id, task_id, status) VALUES($1,$2,$3)',
            [userId, task.id, 'waiting']
        );
        return ctx.send(`Задание: ${task.description}`);
    }

    if (ctx.text === 'сделать шаг') {
        const res = await pool.query('SELECT energy FROM users WHERE vk_id=$1', [userId]);
        const energy = res.rows[0]?.energy || 0;
        if (energy < 3) return ctx.send('Не хватает энергии на шаг!');
        await pool.query('UPDATE users SET energy=energy-3 WHERE vk_id=$1', [userId]);
        return ctx.send('Шаг сделан!');
    }

    // ===== Оценка админом =====
    if (ADMINS.includes(userId) && ctx.text.startsWith('оценить ')) {
        const [_, taskIdStr, scoreStr] = ctx.text.split(' ');
        const taskId = parseInt(taskIdStr);
        const score = parseInt(scoreStr);

        // Проверка на 1–5
        if (score < 1 || score > 5) return ctx.send('Оценка от 1 до 5');

        // Обновляем задание и энергию игрока
        const taskRes = await pool.query(
            'SELECT vk_id FROM tasks_in_progress WHERE task_id=$1 AND status=$2',
            [taskId, 'waiting']
        );

        if (!taskRes.rows.length) return ctx.send('Задание уже оценено');

        const playerId = taskRes.rows[0].vk_id;
        await pool.query(
            'UPDATE users SET energy=energy+$1 WHERE vk_id=$2',
            [score, playerId]
        );

        // Удаляем/обновляем задание
        await pool.query(
            'UPDATE tasks_in_progress SET status=$1 WHERE task_id=$2',
            ['done', taskId]
        );

        return ctx.send(`Задание ${taskId} оценено на ${score}`);
    }
});

// ===== Запуск сервера Webhook =====
(async () => {
    await vk.updates.startWebhook({
        port: PORT,
        path: PATH
    });
    console.log(`Бот запущен на порту ${PORT}`);
})();
